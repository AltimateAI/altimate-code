/**
 * Unit tests for optional-driver resolution and installation.
 *
 * These cover the reports the resolver exists to fix:
 * - #671 / #295 — an SDK the user already installed was invisible to the
 *   compiled binary, which reported it as "not installed".
 * - #1075 — drivers installed by hand into ~/.altimate/bin were wiped by the
 *   self-upgrade, so installs must land somewhere the upgrade never touches.
 * - #769 / #764 / #713 / #670 / #659 — the error text named a bare `npm
 *   install` with no indication of where to run it or where we looked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { spawn } from "child_process"
import { EventEmitter, once } from "node:events"
import { PassThrough } from "node:stream"
import {
  _testing,
  DRIVER_PACKAGES,
  isModuleNotFound,
  npmInstallArgs,
  shellQuote,
  installOptionalDriver,
  DriverNotInstalledError,
  driverInstallDir,
  driverLabel,
  driverSearchRoots,
  isDriverInstalled,
  loadOptionalDriver,
  packageNameOf,
  resolveOptionalPackage,
} from "../src/resolve"

let tmpRoot: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["ALTIMATE_DRIVER_DIR", "ALTIMATE_BIN_DIR", "NODE_PATH", "XDG_DATA_HOME", "OPENCODE_TEST_HOME"]

/** Write a minimal installed package at <root>/node_modules/<name>. */
function installFakePackage(root: string, name: string, body: string): string {
  const dir = path.join(root, "node_modules", ...name.split("/"))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "index.js"), body)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }))
  return dir
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function fakeChild(pid = 42) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    killedSignals: Array<NodeJS.Signals | undefined>
    kill: (signal?: NodeJS.Signals) => boolean
  }
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killedSignals = []
  child.kill = (signal) => {
    child.killedSignals.push(signal)
    return true
  }
  return child
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // realpath it: require.resolve returns realpaths, and on macOS the temp dir
  // is reached through the /var -> /private/var symlink.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "altimate-drivers-")))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("packageNameOf", () => {
  test("returns the package for a bare specifier", () => {
    expect(packageNameOf("pg")).toBe("pg")
  })

  test("strips a subpath", () => {
    // mysql.ts imports mysql2/promise, so the package probe must not look for
    // a directory literally named "mysql2/promise".
    expect(packageNameOf("mysql2/promise")).toBe("mysql2")
  })

  test("keeps both segments of a scoped package", () => {
    expect(packageNameOf("@google-cloud/bigquery")).toBe("@google-cloud/bigquery")
    expect(packageNameOf("@clickhouse/client/dist/x")).toBe("@clickhouse/client")
  })
})

describe("driverInstallDir", () => {
  test("sits under the XDG data dir, not ~/.altimate/bin", () => {
    delete process.env["ALTIMATE_DRIVER_DIR"]
    process.env["XDG_DATA_HOME"] = path.join(tmpRoot, "xdg")

    const dir = driverInstallDir()

    expect(dir).toBe(path.join(tmpRoot, "xdg", "altimate-code", "drivers"))
    // The curl installer rebuilds ~/.altimate/bin on every self-upgrade (#1075),
    // so an install target inside it would be wiped on the next upgrade.
    expect(dir.includes(path.join(".altimate", "bin"))).toBe(false)
  })

  test("honours an explicit override", () => {
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "custom")
    expect(driverInstallDir()).toBe(path.join(tmpRoot, "custom"))
  })

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    delete process.env["ALTIMATE_DRIVER_DIR"]
    delete process.env["XDG_DATA_HOME"]
    process.env["OPENCODE_TEST_HOME"] = tmpRoot

    expect(driverInstallDir()).toBe(path.join(tmpRoot, ".local", "share", "altimate-code", "drivers"))
  })
})

describe("driverSearchRoots", () => {
  test("puts the managed install dir first", () => {
    const managed = path.join(tmpRoot, "managed")
    fs.mkdirSync(path.join(managed, "node_modules"), { recursive: true })
    process.env["ALTIMATE_DRIVER_DIR"] = managed

    const roots = driverSearchRoots()

    expect(roots[0]).toBe(path.join(managed, "node_modules"))
  })

  test("includes node_modules next to ALTIMATE_BIN_DIR", () => {
    // The npm wrapper (bin/altimate) exports ALTIMATE_BIN_DIR; for a global
    // `npm install -g altimate-code` this is where dependencies live.
    const binDir = path.join(tmpRoot, "global", "lib", "node_modules", "altimate-code", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    installFakePackage(path.join(tmpRoot, "global", "lib"), "pg", "module.exports = {}")
    process.env["ALTIMATE_BIN_DIR"] = binDir

    const roots = driverSearchRoots()

    expect(roots).toContain(path.join(tmpRoot, "global", "lib", "node_modules"))
  })

  test("includes every NODE_PATH entry that exists", () => {
    const a = path.join(tmpRoot, "a", "node_modules")
    const b = path.join(tmpRoot, "b", "node_modules")
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    process.env["NODE_PATH"] = [a, b, path.join(tmpRoot, "missing")].join(path.delimiter)

    const roots = driverSearchRoots()

    expect(roots).toContain(a)
    expect(roots).toContain(b)
    // A NODE_PATH entry that does not exist must not become a search root.
    expect(roots).not.toContain(path.join(tmpRoot, "missing"))
  })

  test("does not return duplicates", () => {
    const shared = path.join(tmpRoot, "shared")
    fs.mkdirSync(path.join(shared, "node_modules"), { recursive: true })
    process.env["ALTIMATE_DRIVER_DIR"] = shared
    process.env["NODE_PATH"] = path.join(shared, "node_modules")

    const roots = driverSearchRoots()

    expect(roots.length).toBe(new Set(roots).size)
  })

  test("does not trust project or ancestor node_modules implicitly", () => {
    const ancestor = path.join(tmpRoot, "ancestor")
    const workspace = path.join(ancestor, "workspace")
    installFakePackage(ancestor, "altimate-hostile-ancestor-sdk", "module.exports = {}")
    installFakePackage(workspace, "altimate-hostile-project-sdk", "module.exports = {}")
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "managed")
    delete process.env["ALTIMATE_BIN_DIR"]
    delete process.env["NODE_PATH"]

    const originalCwd = process.cwd()
    try {
      process.chdir(workspace)
      const roots = driverSearchRoots()

      expect(roots).not.toContain(path.join(workspace, "node_modules"))
      expect(roots).not.toContain(path.join(ancestor, "node_modules"))
    } finally {
      process.chdir(originalCwd)
    }
  })
})

describe("resolveOptionalPackage", () => {
  test("finds a package installed under a search root", () => {
    installFakePackage(tmpRoot, "pg", "module.exports = { Pool: function () {} }")

    const resolved = resolveOptionalPackage("pg", [path.join(tmpRoot, "node_modules")])

    expect(resolved).toBeDefined()
    expect(resolved!.startsWith(path.join(tmpRoot, "node_modules", "pg"))).toBe(true)
  })

  test("finds a scoped package", () => {
    installFakePackage(tmpRoot, "@clickhouse/client", "module.exports = { createClient: function () {} }")

    const resolved = resolveOptionalPackage("@clickhouse/client", [path.join(tmpRoot, "node_modules")])

    expect(resolved).toBeDefined()
  })

  test("returns undefined when the package is absent", () => {
    fs.mkdirSync(path.join(tmpRoot, "node_modules"), { recursive: true })

    expect(resolveOptionalPackage("snowflake-sdk", [path.join(tmpRoot, "node_modules")])).toBeUndefined()
  })

  test("prefers the earlier root when a package is installed twice", () => {
    const first = path.join(tmpRoot, "first")
    const second = path.join(tmpRoot, "second")
    installFakePackage(first, "pg", "module.exports = { which: 'first' }")
    installFakePackage(second, "pg", "module.exports = { which: 'second' }")

    const resolved = resolveOptionalPackage("pg", [path.join(first, "node_modules"), path.join(second, "node_modules")])

    expect(resolved!.startsWith(first)).toBe(true)
  })
})

describe("loadOptionalDriver", () => {
  test("loads a package that only exists on a search root", async () => {
    // The regression from #671: the SDK is installed, but not anywhere the
    // ambient module resolver looks from inside the compiled binary. The
    // specifier is deliberately one that can never resolve ambiently, so this
    // exercises the on-disk fallback rather than the workspace's own copy.
    installFakePackage(tmpRoot, "altimate-fake-sdk", "module.exports = { marker: 'resolved-from-disk' }")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot

    const mod: any = await loadOptionalDriver("postgres", "altimate-fake-sdk")

    expect(mod.marker ?? mod.default?.marker).toBe("resolved-from-disk")
  })

  test("does not import a package found only in project or ancestor roots", async () => {
    const ancestor = path.join(tmpRoot, "ancestor")
    const workspace = path.join(ancestor, "workspace")
    const specifier = "altimate-hostile-project-sdk"
    installFakePackage(ancestor, specifier, "module.exports = { marker: 'ancestor' }")
    installFakePackage(workspace, specifier, "module.exports = { marker: 'project' }")
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "managed")
    delete process.env["ALTIMATE_BIN_DIR"]
    delete process.env["NODE_PATH"]
    const attempts: string[] = []
    const importer = async (spec: string) => {
      attempts.push(spec)
      throw Object.assign(new Error(`Cannot find package '${spec}'`), { code: "ERR_MODULE_NOT_FOUND" })
    }

    const originalCwd = process.cwd()
    try {
      process.chdir(workspace)
      await expect(loadOptionalDriver("postgres", specifier, importer)).rejects.toBeInstanceOf(DriverNotInstalledError)
    } finally {
      process.chdir(originalCwd)
    }

    expect(attempts).toEqual([specifier])
    expect(attempts.some((attempt) => attempt.startsWith("file:"))).toBe(false)
  })

  test("prefers a managed SDK over an untrusted project copy", async () => {
    const managed = path.join(tmpRoot, "managed")
    const workspace = path.join(tmpRoot, "workspace")
    const specifier = "altimate-managed-priority-sdk"
    installFakePackage(managed, specifier, "module.exports = { marker: 'managed' }")
    installFakePackage(workspace, specifier, "module.exports = { marker: 'project' }")
    process.env["ALTIMATE_DRIVER_DIR"] = managed
    delete process.env["ALTIMATE_BIN_DIR"]
    delete process.env["NODE_PATH"]

    const originalCwd = process.cwd()
    try {
      process.chdir(workspace)
      const mod: any = await loadOptionalDriver("postgres", specifier)
      expect(mod.marker ?? mod.default?.marker).toBe("managed")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("loads an SDK from an explicit NODE_PATH root", async () => {
    const explicit = path.join(tmpRoot, "explicit")
    const specifier = "altimate-explicit-node-path-sdk"
    installFakePackage(explicit, specifier, "module.exports = { marker: 'node-path' }")
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "managed")
    process.env["NODE_PATH"] = path.join(explicit, "node_modules")

    const mod: any = await loadOptionalDriver("postgres", specifier)

    expect(mod.marker ?? mod.default?.marker).toBe("node-path")
  })

  test("throws DriverNotInstalledError naming the searched roots", async () => {
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "empty")
    delete process.env["ALTIMATE_BIN_DIR"]
    delete process.env["NODE_PATH"]

    let error: unknown
    try {
      await loadOptionalDriver("snowflake", "definitely-not-a-real-sdk-xyz")
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(DriverNotInstalledError)
    const err = error as DriverNotInstalledError
    expect(err.driver).toBe("snowflake")
    expect(err.packages).toEqual(DRIVER_PACKAGES.snowflake)
    // The old message was a bare "Run: npm install snowflake-sdk" with no
    // target directory and no account of where we had looked.
    expect(err.message).toContain("--prefix")
    expect(err.message).toContain("Searched")
  })

  test("reports a disk-resolved package that throws on import as a load failure", async () => {
    // Named for what it actually exercises: the fixture is not ambiently
    // resolvable, so this covers the on-disk load path, not the ambient rethrow.
    // The ambient branch is pinned directly in the isModuleNotFound tests below.
    const broken = path.join(tmpRoot, "ambient")
    installFakePackage(broken, "altimate-ambient-broken", "throw new Error('boom')")
    process.env["ALTIMATE_DRIVER_DIR"] = broken

    let error: unknown
    try {
      await loadOptionalDriver("postgres", "altimate-ambient-broken")
    } catch (e) {
      error = e
    }

    expect(error).not.toBeInstanceOf(DriverNotInstalledError)
    expect((error as Error).message).toContain("failed to load")
    expect((error as Error).message).toContain("boom")
  })

  test("reports a broken install as a load failure, not as missing", async () => {
    // A package that is present but throws on import used to be reported as
    // "not installed", sending users to reinstall something already there.
    installFakePackage(tmpRoot, "altimate-broken-sdk", "throw new Error('native binding is for another platform')")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot

    let error: unknown
    try {
      await loadOptionalDriver("postgres", "altimate-broken-sdk")
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DriverNotInstalledError)
    expect((error as Error).message).toContain("failed to load")
  })
})

describe("isDriverInstalled", () => {
  test("is false for a driver with no packages under the given roots", () => {
    const empty = path.join(tmpRoot, "empty", "node_modules")
    fs.mkdirSync(empty, { recursive: true })

    expect(isDriverInstalled("oracle", [empty])).toBe(false)
  })

  test("is true once the package is present", () => {
    installFakePackage(tmpRoot, "oracledb", "module.exports = {}")

    expect(isDriverInstalled("oracle", [path.join(tmpRoot, "node_modules")])).toBe(true)
  })
})

describe("driver catalogue", () => {
  test("every driver has a label and at least one package", () => {
    for (const driver of Object.keys(DRIVER_PACKAGES) as Array<keyof typeof DRIVER_PACKAGES>) {
      expect(driverLabel(driver).length).toBeGreaterThan(0)
      expect(DRIVER_PACKAGES[driver].length).toBeGreaterThan(0)
    }
  })

  test("covers every driver module that loads an optional SDK", () => {
    // Guards against adding a driver file without registering its package —
    // the resolver would then have nothing to install or search for.
    const expected = [
      "postgres",
      "redshift",
      "snowflake",
      "bigquery",
      "databricks",
      "mysql",
      "sqlserver",
      "oracle",
      "duckdb",
      "mongodb",
      "clickhouse",
      "trino",
    ].sort()

    expect(Object.keys(DRIVER_PACKAGES).sort()).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// Regression cover for the consensus-review criticals (PR #1122)
// ---------------------------------------------------------------------------

describe("installOptionalDriver arguments", () => {
  test("saves to the manifest so installs are additive", () => {
    // Verified on npm 11.12.1: with `--no-save`, installing mysql2 into a prefix
    // that already had pg printed "added 12 packages, and removed 14 packages".
    // Every previously installed driver is pruned as extraneous, re-creating the
    // exact "driver not installed" bug this module exists to fix.
    const args = npmInstallArgs(["mysql2"])

    expect(args).toContain("--save")
    expect(args).not.toContain("--no-save")
  })

  test("passes every requested package through", () => {
    expect(npmInstallArgs(["pg", "@types/pg"]).slice(-2)).toEqual(["pg", "@types/pg"])
  })
})

describe("isModuleNotFound", () => {
  // Pinned directly: deleting this predicate left the behavioural tests passing,
  // because their fixtures are not ambiently resolvable and so never reach it.
  test("recognises the Node resolution error code", () => {
    const err = Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" })
    expect(isModuleNotFound(err)).toBe(true)
  })

  test("recognises the CommonJS resolution error code", () => {
    expect(isModuleNotFound(Object.assign(new Error("nope"), { code: "MODULE_NOT_FOUND" }))).toBe(true)
  })

  test("recognises the message Bun emits inside bunfs", () => {
    expect(isModuleNotFound(new Error("Cannot find package 'pg' from '/$bunfs/root/index.js'"))).toBe(true)
    expect(isModuleNotFound(new Error("Cannot find module 'mysql2/promise'"))).toBe(true)
  })

  test("a missing transitive dependency is NOT the driver going missing", () => {
    // Observed for real when importing pg's entry inside a compiled binary:
    // `Cannot find package 'pg-protocol' from '.../pg/lib/connection.js'`.
    // pg is installed; its dependency tree is incomplete. Classifying that as
    // "not installed" sends the user to reinstall what they already have.
    const transitive = new Error("Cannot find package 'pg-protocol' from '/x/node_modules/pg/lib/connection.js'")

    expect(isModuleNotFound(transitive, "pg")).toBe(false)
    // Same error with no specifier context stays conservative.
    expect(isModuleNotFound(transitive)).toBe(true)
  })

  test("the driver's own absence still counts as missing", () => {
    const own = new Error("Cannot find package 'pg' from '/$bunfs/root/index.js'")

    expect(isModuleNotFound(own, "pg")).toBe(true)
    // Subpath specifiers resolve against their package name.
    expect(isModuleNotFound(new Error("Cannot find module 'mysql2'"), "mysql2/promise")).toBe(true)
  })

  test("does NOT classify a load-time failure as missing", () => {
    // The distinction that matters: a package that resolves but throws while
    // initialising (broken native binding) must not be reported as absent.
    expect(isModuleNotFound(new Error("dlopen failed: wrong architecture"))).toBe(false)
    expect(isModuleNotFound(new TypeError("x is not a function"))).toBe(false)
    expect(isModuleNotFound(undefined)).toBe(false)
  })
})

describe("half-installed packages", () => {
  test("an empty package directory does not count as installed", () => {
    // An interrupted or half-deleted install leaves a bare directory behind.
    // Counting it as installed made warehouse_install_driver answer "already
    // installed, no action taken", so the driver could never be repaired.
    const root = path.join(tmpRoot, "node_modules")
    fs.mkdirSync(path.join(root, "pg"), { recursive: true })

    expect(resolveOptionalPackage("pg", [root])).toBeUndefined()
    expect(isDriverInstalled("postgres", [root])).toBe(false)
  })

  test("a directory with a manifest but no entry file does not count as installed", () => {
    const root = path.join(tmpRoot, "node_modules")
    const dir = path.join(root, "oracledb")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "oracledb", main: "index.js" }))

    expect(resolveOptionalPackage("oracledb", [root])).toBeUndefined()
  })

  test("a directory with no manifest is not a package, even if a subpath file exists", () => {
    // Subpath probing looks for physical files (mysql2/promise.js), so without
    // the manifest check a bare directory holding one would resolve as an
    // installed package.
    const root = path.join(tmpRoot, "node_modules")
    fs.mkdirSync(path.join(root, "mysql2"), { recursive: true })
    fs.writeFileSync(path.join(root, "mysql2", "promise.js"), "module.exports = {}")

    expect(resolveOptionalPackage("mysql2/promise", [root])).toBeUndefined()
  })

  test("keeps searching later roots when an earlier one is half-installed", () => {
    const broken = path.join(tmpRoot, "broken", "node_modules")
    fs.mkdirSync(path.join(broken, "pg"), { recursive: true })
    const good = path.join(tmpRoot, "good")
    installFakePackage(good, "pg", "module.exports = { which: 'good' }")

    const resolved = resolveOptionalPackage("pg", [broken, path.join(good, "node_modules")])

    expect(resolved).toBeDefined()
    expect(resolved!.includes(path.join("good", "node_modules"))).toBe(true)
  })
})

describe("shellQuote", () => {
  test("leaves ordinary paths alone", () => {
    expect(shellQuote("/Users/x/.local/share/altimate-code/drivers")).toBe(
      "/Users/x/.local/share/altimate-code/drivers",
    )
  })

  test("quotes a path with spaces so the printed command is copy-pasteable", () => {
    // The install hint is meant to be pasted; an unquoted path with spaces
    // splits and npm receives the wrong --prefix.
    expect(shellQuote("/Users/x/My Drive/drivers")).toBe("'/Users/x/My Drive/drivers'")
  })

  test("escapes embedded single quotes", () => {
    expect(shellQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`)
  })
})

describe("repairing a broken install", () => {
  test("force skips the resolution-only early return and rebuilds", async () => {
    // The bug this pins: installOptionalDriver short-circuited on
    // isDriverInstalled, a resolution-only check, so a caller that had detected
    // a present-but-unloadable copy got back `installed: true` with npm never
    // run — the repair path was unreachable.
    installFakePackage(tmpRoot, "oracledb", "module.exports = {}")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot

    const calls: string[][] = []
    const runNpm = async (args: string[]) => {
      calls.push(args)
      // Re-create what a real install would leave behind.
      installFakePackage(tmpRoot, "oracledb", "module.exports = { repaired: true }")
      return { code: 0, output: "" }
    }

    const asIs = await installOptionalDriver("oracle", { runNpm })
    expect(asIs.alreadyPresent).toBe(true)
    expect(calls).toEqual([])

    const forced = await installOptionalDriver("oracle", { force: true, runNpm })
    expect(forced.alreadyPresent).toBe(false)
    expect(forced.installed).toBe(true)
    expect(calls.length).toBe(1)
  })

  test("a repair deletes the broken copy first, because npm will not overwrite it", async () => {
    // Verified against npm 11.12.1: with the package already recorded in the
    // manifest, `npm install` answers "up to date" and rewrites nothing, even
    // with --force. Unless the broken directory is removed, the repair is a
    // no-op that reports success.
    installFakePackage(tmpRoot, "oracledb", "throw new Error('corrupt')")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot
    const pkgDir = path.join(tmpRoot, "node_modules", "oracledb")

    let presentWhenNpmRan = true
    const runNpm = async () => {
      presentWhenNpmRan = fs.existsSync(pkgDir)
      installFakePackage(tmpRoot, "oracledb", "module.exports = {}")
      return { code: 0, output: "" }
    }

    await installOptionalDriver("oracle", { force: true, runNpm })

    expect(presentWhenNpmRan).toBe(false)
  })

  test("a failed repair is reported as a failure, not a success", async () => {
    installFakePackage(tmpRoot, "oracledb", "throw new Error('corrupt')")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot

    const result = await installOptionalDriver("oracle", {
      force: true,
      runNpm: async () => ({ code: 1, output: "network unreachable" }),
    })

    expect(result.installed).toBe(false)
    expect(result.error).toContain("network unreachable")
  })

  test("concurrent installs against one directory do not overlap", async () => {
    // Awaiting the in-flight promise released every queued caller at once, so
    // with three or more installs the later ones still ran npm concurrently.
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot
    let active = 0
    let maxActive = 0
    const runNpm = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
      return { code: 0, output: "" }
    }

    await Promise.all([
      installOptionalDriver("oracle", { force: true, runNpm }),
      installOptionalDriver("oracle", { force: true, runNpm }),
      installOptionalDriver("oracle", { force: true, runNpm }),
      installOptionalDriver("oracle", { force: true, runNpm }),
    ])

    expect(maxActive).toBe(1)
  })

  test("normal callers recheck readiness inside the queue", async () => {
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot
    let calls = 0
    let ready = false
    const runNpm = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      installFakePackage(tmpRoot, "oracledb", "module.exports = {}")
      ready = true
      return { code: 0, output: "" }
    }
    const install = () => _testing.installOptionalDriver("oracle", { runNpm }, () => ready)

    const [first, second] = await Promise.all([install(), install()])

    expect(calls).toBe(1)
    expect(first.alreadyPresent).toBe(false)
    expect(second.alreadyPresent).toBe(true)
  })

  test("a non-force caller waits for a forced repair and then rechecks", async () => {
    installFakePackage(tmpRoot, "oracledb", "throw new Error('broken')")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot
    const repairStarted = deferred<void>()
    const releaseRepair = deferred<void>()
    let followerRanNpm = false

    const repair = installOptionalDriver("oracle", {
      force: true,
      runNpm: async () => {
        repairStarted.resolve()
        await releaseRepair.promise
        installFakePackage(tmpRoot, "oracledb", "module.exports = { repaired: true }")
        return { code: 0, output: "" }
      },
    })
    const follower = installOptionalDriver("oracle", {
      runNpm: async () => {
        followerRanNpm = true
        return { code: 1, output: "should not run" }
      },
    })

    await repairStarted.promise
    let followerSettled = false
    void follower.then(() => (followerSettled = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(followerSettled).toBe(false)

    releaseRepair.resolve()
    const [repairResult, followerResult] = await Promise.all([repair, follower])
    expect(repairResult.installed).toBe(true)
    expect(followerResult.alreadyPresent).toBe(true)
    expect(followerRanNpm).toBe(false)
  })

  test("a follower rechecks and installs after a failed forced repair", async () => {
    installFakePackage(tmpRoot, "oracledb", "throw new Error('broken')")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot
    const repairStarted = deferred<void>()
    const releaseRepair = deferred<void>()

    const managedInstalled = () => isDriverInstalled("oracle", [path.join(tmpRoot, "node_modules")])
    const repair = _testing.installOptionalDriver(
      "oracle",
      {
        force: true,
        runNpm: async () => {
          repairStarted.resolve()
          await releaseRepair.promise
          return { code: 1, output: "repair failed" }
        },
      },
      managedInstalled,
    )
    const follower = _testing.installOptionalDriver(
      "oracle",
      {
        runNpm: async () => {
          installFakePackage(tmpRoot, "oracledb", "module.exports = {}")
          return { code: 0, output: "" }
        },
      },
      managedInstalled,
    )

    await repairStarted.promise
    releaseRepair.resolve()
    const [repairResult, followerResult] = await Promise.all([repair, follower])
    expect(repairResult.installed).toBe(false)
    expect(followerResult.installed).toBe(true)
    expect(followerResult.alreadyPresent).toBe(false)
  })

  test("npm success is verified against the managed directory, not an ambient copy", async () => {
    const managed = path.join(tmpRoot, "managed")
    const ambient = path.join(tmpRoot, "ambient")
    process.env["ALTIMATE_DRIVER_DIR"] = managed
    process.env["NODE_PATH"] = path.join(ambient, "node_modules")
    installFakePackage(ambient, "oracledb", "throw new Error('wrong architecture')")

    expect(isDriverInstalled("oracle")).toBe(true)
    const result = await installOptionalDriver("oracle", {
      force: true,
      runNpm: async () => ({ code: 0, output: "npm claimed success without installing anything" }),
    })

    expect(result.installed).toBe(false)
    expect(result.error).toContain("still not resolvable")
  })
})

describe("a broken ambient copy does not hide a good one on disk", () => {
  // The ambient branch needs an import that resolves and then throws. Injecting
  // the importer reaches it without writing a throwing package into this
  // package's real node_modules, which a killed test run would leave behind.
  const brokenAmbient = async (spec: string) => {
    if (!spec.startsWith("file:")) throw new TypeError("native binding is for another platform")
    return import(/* @vite-ignore */ spec)
  }

  test("recovers from the managed root when the ambient copy throws on import", async () => {
    installFakePackage(tmpRoot, "altimate-recovered-sdk", "module.exports = { marker: 'managed' }")
    process.env["ALTIMATE_DRIVER_DIR"] = tmpRoot

    const mod: any = await loadOptionalDriver("postgres", "altimate-recovered-sdk", brokenAmbient)

    expect(mod.marker ?? mod.default?.marker).toBe("managed")
  })

  test("reports the ambient load failure when no healthy copy exists", async () => {
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "empty")
    delete process.env["ALTIMATE_BIN_DIR"]
    delete process.env["NODE_PATH"]

    let error: unknown
    try {
      await loadOptionalDriver("postgres", "altimate-absent-sdk", brokenAmbient)
    } catch (e) {
      error = e
    }

    // Broken, not absent — the user must not be told to install what they have.
    expect(error).not.toBeInstanceOf(DriverNotInstalledError)
    expect((error as Error).message).toContain("native binding is for another platform")
  })
})

describe("shellQuote on Windows", () => {
  test("uses double quotes cmd.exe understands", () => {
    // POSIX single-quoting is not runnable in cmd.exe or PowerShell, so the
    // printed install command was broken on Windows for any path with a space.
    expect(shellQuote("C:\\Users\\x\\My Data\\drivers", "win32")).toBe('"C:\\Users\\x\\My Data\\drivers"')
  })

  test("leaves an ordinary Windows path unquoted", () => {
    expect(shellQuote("C:\\Users\\x\\drivers", "win32")).toBe("C:\\Users\\x\\drivers")
  })
})

describe("manual-install hints are copy-pasteable", () => {
  test("the npm-missing branch quotes the directory", async () => {
    // A third --prefix site lived here and was missed twice: the previous
    // version of this suite asserted "every printed --prefix is quoted" while
    // only ever exercising DriverNotInstalledError.
    process.env["ALTIMATE_DRIVER_DIR"] = path.join(tmpRoot, "My Drivers")

    // force, because snowflake-sdk is a real workspace dependency and the
    // resolution check would otherwise short-circuit before npm is reached.
    const result = await installOptionalDriver("snowflake", {
      force: true,
      runNpm: async () => ({ code: 127, output: "npm: command not found" }),
    })

    expect(result.installed).toBe(false)
    const prefix = /--prefix (\S+)/.exec(result.error ?? "")?.[1]
    expect(prefix).toBeDefined()
    expect(prefix!.startsWith("'") || prefix!.startsWith('"')).toBe(true)
  })

  test("DriverNotInstalledError quotes the directory", () => {
    process.env["ALTIMATE_DRIVER_DIR"] = "/Users/John Doe/Library/drivers"

    const err = new DriverNotInstalledError("snowflake", DRIVER_PACKAGES.snowflake, [])
    const prefix = /--prefix (\S+)/.exec(err.message)?.[1]

    expect(prefix).toBeDefined()
    // shellQuote emits double quotes on win32 and single quotes elsewhere, so a
    // hardcoded `'` assertion fails on a Windows runner. The sibling npm-missing
    // test above already accepts both; mirror it.
    expect(prefix!.startsWith("'") || prefix!.startsWith('"')).toBe(true)
  })

  test("no source builds a --prefix hint without shellQuote", () => {
    // Structural, because the behavioural tests can only cover the sites someone
    // remembered to write a case for. This fails when a NEW unquoted hint is
    // added anywhere, which is how the third site slipped through.
    const sources = [
      path.join(import.meta.dir, "..", "src", "resolve.ts"),
      path.join(import.meta.dir, "..", "..", "opencode", "src", "altimate", "tools", "warehouse-install-driver.ts"),
      path.join(import.meta.dir, "..", "..", "opencode", "src", "altimate", "tools", "warehouse-add.ts"),
    ]

    const offenders: string[] = []
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8")
      for (const match of text.matchAll(/--prefix \$\{([^}]*)\}/g)) {
        if (!match[1]!.includes("shellQuote")) offenders.push(`${path.basename(file)}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe("killTree", () => {
  test("waits for a stubborn descendant after the shell leader exits", async () => {
    if (process.platform === "win32") return
    const child = spawn(
      "/bin/sh",
      ["-c", "(trap '' TERM; printf ready; while :; do sleep 1; done) & trap 'exit 0' TERM; wait"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    )
    const pid = child.pid!
    await once(child.stdout!, "data")

    const groupAlive = () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }

    try {
      const result = await _testing.killTree(child, { termGraceMs: 25, totalTimeoutMs: 2_000, pollMs: 5 })
      expect(result.verified).toBe(true)
      expect(groupAlive()).toBe(false)
    } finally {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
  })

  test("escalates and returns unverified at one absolute deadline", async () => {
    const child = fakeChild()
    const signals: NodeJS.Signals[] = []
    let now = 100
    const result = await _testing.killTree(child as any, {
      platform: "linux",
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      groupAlive: () => true,
      signalGroup: (_pid, signal) => signals.push(signal),
      termGraceMs: 20,
      totalTimeoutMs: 50,
      pollMs: 7,
    })

    expect(result.verified).toBe(false)
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(now).toBe(150)
  })

  test("is awaitable when the child never started", async () => {
    const dead = spawn("this-binary-does-not-exist-anywhere", [], { stdio: "ignore" })
    dead.on("error", () => {})
    await expect(_testing.killTree(dead)).resolves.toEqual({ verified: true })
  })

  test("only a zero taskkill exit verifies a Windows tree", async () => {
    const success = await _testing.killTree(fakeChild() as any, {
      platform: "win32",
      taskkill: async () => ({ code: 0 }),
    })
    const failedChild = fakeChild()
    const failure = await _testing.killTree(failedChild as any, {
      platform: "win32",
      taskkill: async () => ({ code: 1, detail: "access denied" }),
      processAlive: () => false,
    })

    expect(success).toEqual({ verified: true })
    expect(failure).toEqual({ verified: false, detail: "access denied" })
    expect(failedChild.killedSignals).toEqual(["SIGKILL"])
  })
})

describe("runTaskkill", () => {
  function taskkillProcess() {
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean; killed: boolean }
    killer.killed = false
    killer.kill = () => {
      killer.killed = true
      return true
    }
    return killer
  }

  test.each([
    [0, true],
    [1, false],
  ] as const)("handles close code %i", async (code, verified) => {
    const killer = taskkillProcess()
    const spawned = (() => killer as any) as typeof spawn
    const resultPromise = _testing.runTaskkill(42, 100, spawned)
    queueMicrotask(() => killer.emit("close", code))
    const result = await resultPromise

    expect(result.code === 0).toBe(verified)
  })

  test("handles an asynchronous spawn error", async () => {
    const killer = taskkillProcess()
    const spawned = (() => killer as any) as typeof spawn
    const resultPromise = _testing.runTaskkill(42, 100, spawned)
    queueMicrotask(() => killer.emit("error", new Error("taskkill missing")))

    expect(await resultPromise).toEqual({ code: null, detail: "taskkill missing" })
  })

  test("bounds a taskkill process that never closes", async () => {
    const killer = taskkillProcess()
    const spawned = (() => killer as any) as typeof spawn
    const result = await _testing.runTaskkill(42, 5, spawned)

    expect(result.timedOut).toBe(true)
    expect(killer.killed).toBe(true)
  })
})

describe("runNpm timeout", () => {
  test("a child close cannot settle while teardown is still running", async () => {
    const child = fakeChild()
    const teardownStarted = deferred<void>()
    const releaseTeardown = deferred<void>()
    const resultPromise = _testing.runNpm([], tmpRoot, 1, {
      spawnProcess: (() => child as any) as typeof spawn,
      killTree: async () => {
        teardownStarted.resolve()
        child.emit("close", 0)
        await releaseTeardown.promise
        return { verified: true }
      },
    })

    await teardownStarted.promise
    let settled = false
    void resultPromise.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)

    releaseTeardown.resolve()
    const result = await resultPromise
    expect(result.code).toBe(124)
    expect(result.output).toContain("Timed out")
  })

  test("an unexpected teardown rejection still settles as a timeout", async () => {
    const child = fakeChild()
    const result = await _testing.runNpm([], tmpRoot, 1, {
      spawnProcess: (() => child as any) as typeof spawn,
      killTree: async () => {
        throw new Error("cleanup exploded")
      },
    })

    expect(result.code).toBe(124)
    expect(result.output).toContain("could not be verified")
    expect(result.output).toContain("cleanup exploded")
  })
})

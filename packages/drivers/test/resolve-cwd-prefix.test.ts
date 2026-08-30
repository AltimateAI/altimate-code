import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  enclosingNodeModulesRoots,
  loadOptionalDriver,
  repairCwdPrefixedPath,
  searchRootsFromError,
} from "../src/resolve"

// A globally installed CLI (`npm install -g`, package tree under
// /usr/lib/node_modules/altimate-code) run from an unrelated directory reported:
//
//   DuckDB driver found at duckdb but failed to load: ENOENT … open
//   '<cwd>/usr/lib/node_modules/altimate-code/node_modules/duckdb/package.json'
//
// Two defects in one line. The runtime concatenated the working directory onto
// an already-absolute path, and our message then named the bare specifier as
// though it were a location on disk — so it read as "found it, could not load
// it" when in fact nothing had been found at all.
//
// Real directories on disk here, because the whole mechanism is path existence.
//
// The end-to-end tests deliberately use specifiers that exist *nowhere* except
// the tree the test builds. `driverSearchRoots()` includes roots derived from
// execPath and this module's own location, which in-tree reach the repository's
// own `packages/drivers/node_modules` — where a real `duckdb` is installed. A
// test asking for `duckdb` would therefore resolve it from the repository no
// matter what the harvesting code did, and pass while proving nothing. A unique
// specifier cannot be satisfied by any root but the harvested one.

let root = ""
let pkgRoot = ""
let nodeModules = ""

const HARVESTED_PKG = "altimate-harvest-probe"
const ABSENT_PKG = "altimate-absent-probe"

/** Build a minimal but real installed package tree. */
function writePackage(dir: string, name: string, main: string, body: string) {
  const pkgDir = path.join(dir, name)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", main }))
  fs.writeFileSync(path.join(pkgDir, main), body)
  return pkgDir
}

/** An ENOENT of the reported shape, naming `real` with the cwd concatenated on. */
function cwdPrefixedEnoent(real: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${process.cwd()}${real}'`), {
    code: "ENOENT",
  })
}

describe("cwd concatenated onto an absolute path", () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-cwd-")))
    pkgRoot = path.join(root, "lib", "node_modules", "altimate-code")
    nodeModules = path.join(pkgRoot, "node_modules")
    fs.mkdirSync(nodeModules, { recursive: true })
    writePackage(nodeModules, "duckdb", "index.js", "module.exports = { Database: function () {} }\n")
    writePackage(nodeModules, HARVESTED_PKG, "index.js", "module.exports = { marker: 'from-harvested-root' }\n")
  })

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  test("repairs a path whose absolute form exists", () => {
    const real = path.join(nodeModules, "duckdb", "package.json")
    const mangled = process.cwd() + real
    expect(repairCwdPrefixedPath(mangled)).toBe(real)
  })

  test("leaves a path that exists alone", () => {
    const real = path.join(nodeModules, "duckdb", "package.json")
    expect(repairCwdPrefixedPath(real)).toBeUndefined()
  })

  test("leaves a legitimately nested path under cwd alone", () => {
    // `<cwd>/node_modules/x` de-prefixes to `/node_modules/x`, which does not
    // exist — so the repair must decline rather than invent a root.
    const nested = path.join(process.cwd(), "node_modules", "definitely-not-here", "package.json")
    expect(repairCwdPrefixedPath(nested)).toBeUndefined()
  })

  test("declines when the de-prefixed path does not exist either", () => {
    const mangled = process.cwd() + path.join(root, "nope", "package.json")
    expect(repairCwdPrefixedPath(mangled)).toBeUndefined()
  })

  test("reports the driver failure when the working directory is unavailable", async () => {
    // process.cwd() throws ENOENT once the working directory is removed out from
    // under the process. Repair and diagnostics both run *while a driver failure
    // is being formatted*, so an unavailable cwd must degrade to "no repair"
    // rather than replace the fault the reader needs with an unrelated ENOENT
    // raised by the reporting path itself.
    //
    // The condition is forced rather than staged: deleting a real working
    // directory does not make process.cwd() throw on macOS, so a test that
    // removed a directory would silently assert nothing on this platform.
    const realCwd = process.cwd.bind(process)
    process.cwd = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" })
    }
    try {
      const real = path.join(nodeModules, "duckdb", "package.json")
      expect(repairCwdPrefixedPath(`/somewhere${real}`)).toBeUndefined()

      const ambient = Object.assign(new Error("ENOENT: no such file or directory, open '/nowhere/pkg.json'"), {
        code: "ENOENT",
      })
      let message = ""
      try {
        await loadOptionalDriver("duckdb", ABSENT_PKG, async () => {
          throw ambient
        })
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      // The driver fault survives, and the diagnostics say plainly that the
      // process could not see its own working directory.
      expect(message).toContain("failed to load from the default module resolution")
      expect(message).toContain("cwd=<unavailable>")
      expect(message).not.toContain("uv_cwd")
    } finally {
      process.cwd = realCwd
    }
  })

  test("does not mistake a sibling directory sharing a prefix for the cwd", () => {
    // cwd `/a/work` against `/a/workspace/…` shares a textual prefix but is a
    // different directory; de-prefixing there would invent a nonsense path.
    const sibling = `${process.cwd()}space`
    expect(repairCwdPrefixedPath(path.join(sibling, "lib", "pkg.json"))).toBeUndefined()
  })

  test("harvests the node_modules root the runtime named", () => {
    const error = cwdPrefixedEnoent(path.join(nodeModules, "duckdb", "package.json"))
    expect(searchRootsFromError(error)).toContain(nodeModules)
  })

  test("harvests nothing from an error naming no usable path", () => {
    expect(searchRootsFromError(new Error("something went wrong"))).toEqual([])
    expect(searchRootsFromError(new Error("open '/no/such/place/pkg/package.json'"))).toEqual([])
  })

  test("loads a package from the location the failing runtime named", async () => {
    // Reproduces the reported failure exactly: ambient resolution throws ENOENT
    // naming the correct absolute path with cwd concatenated on, and nothing
    // else on this machine can see that tree.
    const ambient = cwdPrefixedEnoent(path.join(nodeModules, HARVESTED_PKG, "package.json"))

    let call = 0
    const importer = async (spec: string) => {
      call++
      if (call === 1) throw ambient
      return await import(/* @vite-ignore */ spec)
    }

    const mod: any = await loadOptionalDriver("duckdb", HARVESTED_PKG, importer)
    // Identity, not shape: proves the harvested root is what satisfied the load.
    expect((mod.default ?? mod).marker).toBe("from-harvested-root")
  })

  test("does not claim a location when nothing was found", async () => {
    const ambient = Object.assign(new Error("ENOENT: no such file or directory, open '/nowhere/pkg.json'"), {
      code: "ENOENT",
    })
    const importer = async () => {
      throw ambient
    }

    let message = ""
    try {
      await loadOptionalDriver("duckdb", ABSENT_PKG, importer)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    // The old text was `found at duckdb but failed to load: …`, naming the bare
    // specifier as a place on disk.
    expect(message).not.toContain(`found at ${ABSENT_PKG}`)
    expect(message).toContain("failed to load from the default module resolution")
  })
})

describe("enclosing node_modules roots", () => {
  test("finds the root in a platform-native path", () => {
    expect(enclosingNodeModulesRoots("/a/node_modules/pkg/index.js", "/")).toEqual(["/a/node_modules"])
  })

  test("returns every enclosing root, innermost first", () => {
    // A quoted path often runs through a driver's own dependency. The innermost
    // root holds that dependency; the *outer* one holds the driver being looked
    // for, so returning only the innermost left the driver unfindable.
    expect(enclosingNodeModulesRoots("/opt/node_modules/duckdb/node_modules/node-addon-api/x.js", "/")).toEqual([
      "/opt/node_modules/duckdb/node_modules",
      "/opt/node_modules",
    ])
  })

  test("returns nothing when the path names no node_modules", () => {
    expect(enclosingNodeModulesRoots("/a/b/index.js", "/")).toEqual([])
  })

  test("handles a Windows path quoted with forward slashes", () => {
    // Windows runtimes quote both shapes. The marker is built from the platform
    // separator, so without normalisation a forward-slash path would never match
    // a backslash marker and nothing would be harvested at all.
    expect(enclosingNodeModulesRoots("C:/app/node_modules/pkg/index.js", "\\")).toEqual(["C:\\app\\node_modules"])
  })

  test("handles a Windows path quoted with backslashes", () => {
    expect(enclosingNodeModulesRoots("C:\\app\\node_modules\\pkg\\index.js", "\\")).toEqual(["C:\\app\\node_modules"])
  })

  test("handles a Windows path with mixed separators", () => {
    expect(enclosingNodeModulesRoots("C:\\app/node_modules\\pkg/index.js", "\\")).toEqual(["C:\\app\\node_modules"])
  })
})

describe("harvested roots do not preempt the managed installation", () => {
  const PRIORITY_PKG = "altimate-priority-probe"
  let managedRoot = ""
  let strayRoot = ""
  let savedDriverDir: string | undefined

  beforeAll(() => {
    savedDriverDir = process.env["ALTIMATE_DRIVER_DIR"]
    managedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-managed-")))
    strayRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-stray-")))
    writePackage(path.join(managedRoot, "node_modules"), PRIORITY_PKG, "index.js", "module.exports={marker:'managed'}\n")
    writePackage(path.join(strayRoot, "node_modules"), PRIORITY_PKG, "index.js", "module.exports={marker:'stray'}\n")
    process.env["ALTIMATE_DRIVER_DIR"] = managedRoot
  })

  afterAll(() => {
    if (savedDriverDir === undefined) delete process.env["ALTIMATE_DRIVER_DIR"]
    else process.env["ALTIMATE_DRIVER_DIR"] = savedDriverDir
    for (const dir of [managedRoot, strayRoot]) if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  test("prefers the driver we installed over a copy the error happened to name", async () => {
    // A harvested root is evidence about wherever the runtime pointed, which may
    // be a stale or broken copy. driverSearchRoots() puts the managed install
    // first precisely so a driver we installed wins; harvesting must not undo
    // that by jumping the queue.
    const ambient = Object.assign(
      new Error(
        `ENOENT: no such file or directory, open '${path.join(strayRoot, "node_modules", PRIORITY_PKG, "package.json")}'`,
      ),
      { code: "ENOENT" },
    )
    let call = 0
    const importer = async (spec: string) => {
      call++
      if (call === 1) throw ambient
      return await import(/* @vite-ignore */ spec)
    }

    const mod: any = await loadOptionalDriver("duckdb", PRIORITY_PKG, importer)
    expect((mod.default ?? mod).marker).toBe("managed")
  })
})

describe("harvested roots respect the workspace boundary", () => {
  let workspace = ""
  let outside = ""
  let outsideModules = ""
  const originalCwd = process.cwd()

  beforeAll(() => {
    // Its own tree: the first describe's afterAll has already removed that one
    // by the time this block runs.
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-outside-")))
    outsideModules = path.join(outside, "node_modules")
    writePackage(outsideModules, "duckdb", "index.js", "module.exports = {}\n")
  })

  afterAll(() => {
    if (outside) fs.rmSync(outside, { recursive: true, force: true })
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
    workspace = ""
  })

  test("refuses a node_modules inside the working directory", () => {
    // driverSearchRoots() deliberately never searches project node_modules:
    // importing a workspace-controlled SDK during a warehouse read/test would
    // bypass the permission boundary and can expose resolved credentials.
    // Mining a path out of an error message must not route around that.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-ws-")))
    const projectModules = path.join(workspace, "node_modules")
    writePackage(projectModules, "duckdb", "index.js", "module.exports = {}\n")
    process.chdir(workspace)

    const error = new Error(`ENOENT: no such file or directory, open '${path.join(projectModules, "duckdb", "package.json")}'`)
    expect(searchRootsFromError(error)).not.toContain(projectModules)
    expect(searchRootsFromError(error)).toEqual([])
  })

  test("refuses a node_modules in an ancestor of the working directory", () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-ws-")))
    const ancestorModules = path.join(workspace, "node_modules")
    writePackage(ancestorModules, "duckdb", "index.js", "module.exports = {}\n")
    const nested = path.join(workspace, "packages", "app")
    fs.mkdirSync(nested, { recursive: true })
    process.chdir(nested)

    const error = new Error(`ENOENT: no such file or directory, open '${path.join(ancestorModules, "duckdb", "package.json")}'`)
    expect(searchRootsFromError(error)).not.toContain(ancestorModules)
  })

  test("refuses a symlinked root whose target is inside the working directory", () => {
    // The containment check must compare real paths. `isDirectory` follows
    // symlinks, so a link whose lexical path sits outside the workspace but
    // whose target sits inside it would otherwise pass a lexical exclusion and
    // import workspace-controlled code anyway.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-ws-")))
    const real = path.join(workspace, "inside")
    writePackage(path.join(real, "node_modules"), "duckdb", "index.js", "module.exports = {}\n")
    // The link lives outside the workspace and points back into it.
    const linkHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-link-")))
    const link = path.join(linkHome, "node_modules")
    fs.symlinkSync(path.join(real, "node_modules"), link, "dir")
    process.chdir(workspace)

    try {
      const error = new Error(`ENOENT: no such file or directory, open '${path.join(link, "duckdb", "package.json")}'`)
      expect(searchRootsFromError(error)).toEqual([])
    } finally {
      fs.rmSync(linkHome, { recursive: true, force: true })
    }
  })

  test("harvests nothing at all when the working directory cannot be established", () => {
    // Fail closed. With no cwd there is nothing to compare a root against, and
    // treating that as "not workspace content" would admit every root an error
    // names — turning the one case where the process cannot see its own
    // filesystem into the case with no boundary at all.
    const realCwd = process.cwd.bind(process)
    process.cwd = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" })
    }
    try {
      const error = new Error(
        `ENOENT: no such file or directory, open '${path.join(outsideModules, "duckdb", "package.json")}'`,
      )
      expect(searchRootsFromError(error)).toEqual([])
    } finally {
      process.cwd = realCwd
    }
  })

  test("still harvests a root outside the workspace", () => {
    // The exclusion must not swallow the case the harvesting exists for.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-ws-")))
    process.chdir(workspace)

    const error = new Error(
      `ENOENT: no such file or directory, open '${path.join(outsideModules, "duckdb", "package.json")}'`,
    )
    expect(searchRootsFromError(error)).toContain(outsideModules)
  })
})

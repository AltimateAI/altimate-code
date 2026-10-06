import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  ensurePackages,
  installPackagesLocked,
  packagesSatisfied,
  withPackagesLock,
} from "../src/packages"

const WORKER = join(import.meta.dir, "fixture", "packages-worker.ts")
const PKG = "mypkg"

let root = ""

function writeProject(opts: { lock?: string; packages?: string } = {}) {
  writeFileSync(join(root, "dbt_project.yml"), "name: proj\nversion: '1.0'\nconfig-version: 2\nprofile: proj\n")
  writeFileSync(join(root, "packages.yml"), opts.packages ?? `packages:\n  - package: acme/${PKG}\n    version: 1.0.0\n`)
  if (opts.lock) writeFileSync(join(root, "package-lock.yml"), opts.lock)
}

function lockFor(version: string) {
  return `packages:\n- package: acme/${PKG}\n  version: ${version}\nsha1_hash: abc\n`
}

/** What `dbt deps` leaves behind for a healthy install. */
function installPackage(version = "1.0.0", name = PKG) {
  const dir = join(root, "dbt_packages", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "dbt_project.yml"), `name: ${name}\nversion: '${version}'\n`)
}

function counter() {
  let calls = 0
  return {
    install: async () => {
      calls++
      installPackage()
    },
    get calls() {
      return calls
    },
  }
}

const stateDir = () => join(root, "target", ".altimate-dbt")

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dbt-pkgs-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("packagesSatisfied / ensurePackages: when to install", () => {
  test("no packages declared: nothing to do, installer never called", async () => {
    writeFileSync(join(root, "dbt_project.yml"), "name: proj\n")
    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("none")
    expect(c.calls).toBe(0)
  })

  test("declared but not installed: installs once, then skips", async () => {
    writeProject()
    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("installed")
    expect((await ensurePackages(root, c.install)).action).toBe("skipped")
    expect((await ensurePackages(root, c.install)).action).toBe("skipped")
    expect(c.calls).toBe(1)
  })

  test("packages already installed by something else and matching the lock: not reinstalled", async () => {
    // e.g. an image built with `dbt deps`: no stamp from us, but the install is current.
    writeProject({ lock: lockFor("1.0.0") })
    installPackage("1.0.0")
    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("skipped")
    expect(c.calls).toBe(0)
  })

  test("the version inside an installed hub package is not compared with the lock (hub packages report stale versions)", async () => {
    // dbt_utils locked at 1.3.0 installs with `version: 0.1.0` in its dbt_project.yml.
    writeProject({ lock: lockFor("1.3.0") })
    installPackage("0.1.0")
    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("skipped")
    expect(c.calls).toBe(0)
  })

  test("a declared hub package whose directory is missing: reinstalls", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    installPackage("1.0.0", "other")
    expect(packagesSatisfied(root).ok).toBe(false)
  })

  test("package directory without dbt_project.yml (the corruption seen in the benchmark): reinstalls", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    installPackage()
    const c = counter()
    await ensurePackages(root, c.install) // stamps a good install
    rmSync(join(root, "dbt_packages", PKG, "dbt_project.yml"))
    expect(packagesSatisfied(root).ok).toBe(false)
    expect((await ensurePackages(root, c.install)).action).toBe("installed")
    expect(existsSync(join(root, "dbt_packages", PKG, "dbt_project.yml"))).toBe(true)
  })

  test("declarations changed since the last install: reinstalls", async () => {
    writeProject()
    const c = counter()
    await ensurePackages(root, c.install)
    writeFileSync(join(root, "packages.yml"), `packages:\n  - package: acme/${PKG}\n    version: 1.1.0\n`)
    expect((await ensurePackages(root, c.install)).action).toBe("installed")
    expect(c.calls).toBe(2)
  })

  test("non-hub (local/git) packages: verified by count without a stamp, by stamp afterwards", async () => {
    writeProject({ packages: "packages:\n  - local: ../elsewhere\n" })
    const c = counter()
    expect(packagesSatisfied(root).ok).toBe(false) // nothing installed
    installPackage("0.1.0", "elsewhere")
    expect(packagesSatisfied(root).ok).toBe(true)
    await ensurePackages(root, c.install)
    expect(c.calls).toBe(0)
  })

  test("honours packages-install-path from dbt_project.yml", async () => {
    writeProject()
    writeFileSync(
      join(root, "dbt_project.yml"),
      "name: proj\nconfig-version: 2\nprofile: proj\npackages-install-path: deps_here\n",
    )
    const dir = join(root, "deps_here", PKG)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "dbt_project.yml"), "name: mypkg\nversion: '1.0.0'\n")
    expect(packagesSatisfied(root).ok).toBe(true)
  })
})

describe("crash and failure recovery", () => {
  test("an install that throws leaves the project marked unfinished; the next call repairs it", async () => {
    writeProject()
    await expect(
      ensurePackages(root, async () => {
        mkdirSync(join(root, "dbt_packages", PKG), { recursive: true }) // half-installed
        throw new Error("network down")
      }),
    ).rejects.toThrow("network down")
    expect(existsSync(join(stateDir(), "packages.dirty"))).toBe(true)
    expect(packagesSatisfied(root).ok).toBe(false)

    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("installed")
    expect(existsSync(join(stateDir(), "packages.dirty"))).toBe(false)
    expect(packagesSatisfied(root).ok).toBe(true)
  })

  test("dirty marker forces a reinstall even when every package directory looks complete", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    installPackage("1.0.0")
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), "packages.dirty"), "{}")
    const c = counter()
    expect((await ensurePackages(root, c.install)).action).toBe("installed")
    expect(c.calls).toBe(1)
  })

  test("a deps run that finishes with an empty or incomplete package directory is not recorded as good", async () => {
    writeProject()
    await expect(ensurePackages(root, async () => {})).rejects.toThrow("incomplete")
    expect(existsSync(join(stateDir(), "packages.stamp.json"))).toBe(false)
    expect(existsSync(join(stateDir(), "packages.dirty"))).toBe(true)
  })
})

describe("lock", () => {
  test("is exclusive and released afterwards", async () => {
    writeProject()
    const order: string[] = []
    const a = withPackagesLock(root, async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 200))
      order.push("a-end")
    })
    await new Promise((r) => setTimeout(r, 50))
    const b = withPackagesLock(root, async () => {
      order.push("b-start")
    })
    await Promise.all([a, b])
    expect(order).toEqual(["a-start", "a-end", "b-start"])
    expect(existsSync(join(stateDir(), "packages.lock"))).toBe(false)
  })

  test("a lock left by a process that no longer exists is broken immediately", async () => {
    writeProject()
    const lockDir = join(stateDir(), "packages.lock")
    mkdirSync(lockDir, { recursive: true })
    // A pid that is certainly not running: spawn and reap a child.
    const dead = spawn(process.execPath, ["-e", "0"])
    await new Promise((r) => dead.on("close", r))
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: dead.pid, host: require("os").hostname(), token: "x", startedAt: Date.now() }),
    )
    const started = Date.now()
    await withPackagesLock(root, async () => {}, { staleMs: 60_000 })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a lock whose owner is alive but has stopped heartbeating is broken after staleMs", async () => {
    writeProject()
    const lockDir = join(stateDir(), "packages.lock")
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid + 1, host: "some-other-host", token: "x", startedAt: 0 }),
    )
    const old = new Date(Date.now() - 10_000)
    utimesSync(lockDir, old, old)
    await withPackagesLock(root, async () => {}, { staleMs: 1_000 })
  })

  test("a live, heartbeating owner is waited for, not broken", async () => {
    writeProject()
    let holderDone = false
    const holder = withPackagesLock(
      root,
      async () => {
        await new Promise((r) => setTimeout(r, 600)) // longer than staleMs: only the heartbeat keeps it alive
        holderDone = true
      },
      { staleMs: 300, heartbeatMs: 50 },
    )
    await new Promise((r) => setTimeout(r, 100))
    let waiterSawHolderDone = false
    await withPackagesLock(root, async () => (waiterSawHolderDone = holderDone), { staleMs: 300, heartbeatMs: 50 })
    await holder
    expect(waiterSawHolderDone).toBe(true)
  })

  test("gives up with a clear error when the lock is never released", async () => {
    writeProject()
    const lockDir = join(stateDir(), "packages.lock")
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, host: "h", token: "x", startedAt: 0 }))
    await expect(withPackagesLock(root, async () => {}, { staleMs: 60_000, maxWaitMs: 300 })).rejects.toThrow(
      "timed out",
    )
  })

  test("explicit install (altimate-dbt deps) runs under the lock, clears the dirty marker and does not claim success", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    await installPackagesLocked(root, async () => installPackage())
    expect(packagesSatisfied(root).ok).toBe(true)
    expect(existsSync(join(stateDir(), "packages.dirty"))).toBe(false)
    expect(existsSync(join(stateDir(), "packages.stamp.json"))).toBe(false)
  })

  test("an explicit install whose dbt deps failed on an empty directory returns dbt's result and leaves the dirty marker", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    const failed = { stderr: "Runtime Error: could not reach hub.getdbt.com" }
    const result = await installPackagesLocked(root, async () => failed)
    expect(result).toBe(failed)
    expect(existsSync(join(stateDir(), "packages.dirty"))).toBe(true)
    expect(packagesSatisfied(root).ok).toBe(false)
  })

  test("a plain file in the install path is not an incomplete package", async () => {
    writeProject({ lock: lockFor("1.0.0") })
    installPackage("1.0.0")
    writeFileSync(join(root, "dbt_packages", "README.md"), "notes")
    expect(packagesSatisfied(root).ok).toBe(true)
  })

  test("a packages.yml edited after the lock was written is not satisfied by the old install", () => {
    writeProject({ lock: lockFor("1.0.0") })
    installPackage("1.0.0")
    expect(packagesSatisfied(root).ok).toBe(true)
    const later = new Date(Date.now() + 10_000)
    utimesSync(join(root, "packages.yml"), later, later)
    expect(packagesSatisfied(root)).toMatchObject({ ok: false, reason: expect.stringContaining("newer") })
  })
})

describe("concurrent callers", () => {
  test("many in-process callers install exactly once and all return with packages complete", async () => {
    writeProject()
    let installs = 0
    const seen: boolean[] = []
    const slow = async () => {
      installs++
      const dir = join(root, "dbt_packages", PKG)
      mkdirSync(dir, { recursive: true })
      await new Promise((r) => setTimeout(r, 150))
      writeFileSync(join(dir, "dbt_project.yml"), "name: mypkg\nversion: '1.0.0'\n")
    }
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await ensurePackages(root, slow)
        seen.push(existsSync(join(root, "dbt_packages", PKG, "dbt_project.yml")))
      }),
    )
    expect(installs).toBe(1)
    expect(seen).toEqual(Array(8).fill(true))
  })

  function runWorker(mode?: "crash") {
    const logFile = join(root, "worker.log")
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const c = spawn(process.execPath, [WORKER, root, logFile, PKG, ...(mode ? [mode] : [])], { stdio: "ignore" })
      c.on("close", (code, signal) => resolve({ code, signal }))
    })
  }
  const readLog = () => (existsSync(join(root, "worker.log")) ? readFileSync(join(root, "worker.log"), "utf-8").trim().split("\n") : [])

  test("separate processes started together: one install, nobody sees a broken package directory", async () => {
    writeProject()
    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker()))
    expect(results.every((r) => r.code === 0)).toBe(true)
    const lines = readLog()
    expect(lines.filter((l) => l.startsWith("install")).length).toBe(1)
    expect(lines.filter((l) => l.startsWith("ready")).length).toBe(8)
    expect(lines.filter((l) => l.startsWith("BROKEN")).length).toBe(0)
  }, 30_000)

  test("a process killed in the middle of an install does not poison the project", async () => {
    writeProject()
    const crashed = await runWorker("crash")
    expect(crashed.signal).toBe("SIGKILL")
    // Package directory exists but is incomplete, lock and dirty marker are left behind.
    expect(existsSync(join(root, "dbt_packages", PKG))).toBe(true)
    expect(existsSync(join(root, "dbt_packages", PKG, "dbt_project.yml"))).toBe(false)
    expect(existsSync(join(stateDir(), "packages.lock"))).toBe(true)

    // Recovery: several processes arrive at once; the dead owner's lock is broken, the install repeats once.
    const results = await Promise.all(Array.from({ length: 4 }, () => runWorker()))
    expect(results.every((r) => r.code === 0)).toBe(true)
    const lines = readLog()
    expect(lines.filter((l) => l.startsWith("BROKEN")).length).toBe(0)
    expect(lines.filter((l) => l.startsWith("ready")).length).toBe(4)
    expect(lines.filter((l) => l.startsWith("install")).length).toBe(2) // the crashed one + one repair
    expect(packagesSatisfied(root).ok).toBe(true)
  }, 30_000)
})

describe("adapter wiring", () => {
  test("the dbt integration library is told not to run `dbt deps` itself", () => {
    // adapter.ts cannot be imported under bun (python-bridge), so assert on the source. The
    // library default is true; leaving it on reintroduces the unsynchronised install from
    // every process. The behavioural check is test/packages-real-dbt.test.ts.
    const src = readFileSync(join(import.meta.dir, "..", "src", "adapter.ts"), "utf-8")
    expect(src).toMatch(/getInstallDepsOnProjectInitialization:\s*\(\)\s*=>\s*false/)
  })
})

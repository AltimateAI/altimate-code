import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Log } from "../../src/util/log"
import {
  runStartupUpgradeCheck,
  scheduleStartupUpgradeCheck,
  STARTUP_UPGRADE_DELAY_MS,
  type StartupUpgradeDeps,
} from "../../src/cli/cmd/serve-upgrade-check"
import { compareVersions, isValidVersion } from "../../src/cli/upgrade"

Log.init({ print: false })

const serveUpgradeSource = readFileSync(join(import.meta.dir, "../../src/cli/cmd/serve-upgrade-check.ts"), "utf8")
const serveSource = readFileSync(join(import.meta.dir, "../../src/cli/cmd/serve.ts"), "utf8")
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const serveUpgradeCode = stripComments(serveUpgradeSource)

describe("PR #940 serve startup upgrade trigger", () => {
  test("runStartupUpgradeCheck invokes the upgrade runner exactly once inside the cwd instance", async () => {
    const originalCwd = process.cwd()
    const tempRoot = mkdtempSync(join(tmpdir(), "serve-upgrade-940-"))
    const workspace = join(tempRoot, "workspace")
    mkdirSync(workspace)

    const events: string[] = []
    const deps: StartupUpgradeDeps = {
      provide: async (directory, fn) => {
        events.push(`provide:${directory}`)
        const result = await fn()
        events.push("provide:resolved")
        return result
      },
      run: async () => {
        events.push("run")
        return "ignored result"
      },
    }

    try {
      process.chdir(workspace)
      const expectedCwd = process.cwd()
      await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
      expect(events).toEqual([`provide:${expectedCwd}`, "run", "provide:resolved"])
    } finally {
      process.chdir(originalCwd)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("upgrade runner rejection is swallowed after provide starts, so serve cannot crash", async () => {
    let provideCalls = 0
    let runCalls = 0
    let callbackResolved = false
    const deps: StartupUpgradeDeps = {
      provide: async (_directory, fn) => {
        provideCalls++
        await fn()
        callbackResolved = true
      },
      run: async () => {
        runCalls++
        throw new Error("registry timeout")
      },
    }

    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(provideCalls).toBe(1)
    expect(runCalls).toBe(1)
    expect(callbackResolved).toBe(true)
  })

  test("synchronous upgrade runner throw is also non-fatal to serve startup", async () => {
    let runCalls = 0
    const deps: StartupUpgradeDeps = {
      provide: async (_directory, fn) => fn(),
      run: (() => {
        runCalls++
        throw new Error("config parse failed")
      }) as StartupUpgradeDeps["run"],
    }

    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(runCalls).toBe(1)
  })

  test("instance provider rejection is swallowed and does not attempt upgrade outside an instance", async () => {
    let runCalls = 0
    const deps: StartupUpgradeDeps = {
      provide: async () => {
        throw new Error("bootstrap failed")
      },
      run: async () => {
        runCalls++
      },
    }

    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(runCalls).toBe(0)
  })

  test("provider failure after the upgrade callback is still non-fatal", async () => {
    const events: string[] = []
    const deps: StartupUpgradeDeps = {
      provide: async (_directory, fn) => {
        events.push("provide:start")
        await fn()
        events.push("provide:after-fn")
        throw new Error("late dispose-like failure")
      },
      run: async () => {
        events.push("run")
      },
    }

    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(events).toEqual(["provide:start", "run", "provide:after-fn"])
  })

  test("scheduler uses the documented one-shot settle delay and unreferences the timer", () => {
    const originalSetTimeout = globalThis.setTimeout
    const calls: Array<{ delay: number; unrefCalled: boolean; callbackType: string }> = []

    ;(globalThis as any).setTimeout = (callback: unknown, delay: number) => {
      const call = { delay, unrefCalled: false, callbackType: typeof callback }
      calls.push(call)
      return {
        unref() {
          call.unrefCalled = true
        },
      }
    }

    try {
      scheduleStartupUpgradeCheck()
    } finally {
      ;(globalThis as any).setTimeout = originalSetTimeout
    }

    // v0.8.8: the settle delay is jittered (base + random*base*5) so a fleet
    // restarting together does not stampede the GitHub releases API at once.
    // Exactly one timer is scheduled, unref'd, with a function callback, and its
    // delay sits in the documented [base, base*6) window.
    expect(calls.length).toBe(1)
    expect(calls[0].unrefCalled).toBe(true)
    expect(calls[0].callbackType).toBe("function")
    expect(calls[0].delay).toBeGreaterThanOrEqual(STARTUP_UPGRADE_DELAY_MS)
    expect(calls[0].delay).toBeLessThan(STARTUP_UPGRADE_DELAY_MS * 6)
    expect(STARTUP_UPGRADE_DELAY_MS).toBe(1000)
  })

  test("serve handler schedules the check only after the listener is created and never awaits it", () => {
    const listenIndex = serveSource.indexOf("const server = await Server.listen(opts)")
    const scheduleIndex = serveSource.indexOf("scheduleStartupUpgradeCheck()")
    const foreverWaitIndex = serveSource.indexOf("await new Promise(() => {})")

    expect(listenIndex).toBeGreaterThan(-1)
    expect(scheduleIndex).toBeGreaterThan(listenIndex)
    expect(scheduleIndex).toBeLessThan(foreverWaitIndex)
    expect(serveSource.match(/scheduleStartupUpgradeCheck\(\)/g)?.length).toBe(1)
    expect(serveSource).not.toContain("await scheduleStartupUpgradeCheck()")
  })

  test("serve startup check uses the shared cwd Instance and does not bootstrap-and-dispose server state", () => {
    expect(serveUpgradeSource).toContain("Instance.provide({ directory, init: InstanceBootstrap, fn })")
    expect(serveUpgradeSource).toContain("deps.provide(process.cwd(),")
    expect(serveUpgradeCode).not.toMatch(/\bInstance\.dispose\s*\(/)
    expect(serveUpgradeCode).not.toMatch(/\bbootstrap\s*\(/)
  })

  test("default startup check delegates to the real upgrade implementation without module mocking", () => {
    expect(serveUpgradeSource).toContain('import { upgrade } from "../upgrade"')
    expect(serveUpgradeSource).toContain("run: upgrade")
    expect(serveUpgradeSource).not.toMatch(/\bmock\.module\s*\(/)
  })

  test("startup wrapper has both failure boundaries: upgrade failure and instance failure", () => {
    expect(serveUpgradeSource).toContain('deps.run().catch((err) => log.error("startup upgrade check failed"')
    expect(serveUpgradeSource).toContain('log.error("startup upgrade instance failed"')
    expect(serveUpgradeSource).toContain("export async function runStartupUpgradeCheck")
  })

  test("version comparison prevents downgrade or equal-version work for v-prefixed and prerelease boundaries", () => {
    expect(isValidVersion("v0.8.7")).toBe(true)
    expect(compareVersions("0.8.7", "v0.8.7")).toBe(0)
    expect(compareVersions("0.8.8", "0.8.7")).toBe(1)
    expect(compareVersions("0.8.7", "0.8.8")).toBe(-1)
    expect(compareVersions("0.8.8-beta.1", "0.8.7")).toBe(1)
    expect(compareVersions("0.8.8", "0.8.8-beta.1")).toBe(1)
  })

  test("malformed versions are treated as equal by compareVersions for safe no-downgrade defaults", () => {
    expect(isValidVersion("../../../0.8.9")).toBe(false)
    expect(isValidVersion("0.8")).toBe(false)
    expect(compareVersions("not-a-version", "0.8.7")).toBe(0)
    expect(compareVersions("0.8.7", "latest; rm -rf /")).toBe(0)
  })

  test("changed serve-upgrade source does not shell out or interpolate install commands", () => {
    expect(serveUpgradeSource).not.toMatch(/\bexec(File|Sync)?\b/)
    expect(serveUpgradeSource).not.toMatch(/\bspawn(Sync)?\b/)
    expect(serveUpgradeSource).not.toContain("Bun.spawn")
    expect(serveUpgradeSource).not.toContain("$(")
  })
})

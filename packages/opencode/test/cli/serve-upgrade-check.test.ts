import { beforeEach, describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { runStartupUpgradeCheck, STARTUP_UPGRADE_DELAY_MS, type StartupUpgradeDeps } from "../../src/cli/cmd/serve-upgrade-check"

Log.init({ print: false })

// No mock.module here: it is process-global in bun and would clobber
// ../upgrade / ../../project/instance for every other test in the run. The
// collaborators are injected instead.
describe("serve-upgrade-check", () => {
  let runCalls: number
  let runShouldThrow: boolean
  let provideCalls: number
  let provideDirectory: string | undefined

  function makeDeps(): StartupUpgradeDeps {
    return {
      provide: async (directory, fn) => {
        provideCalls++
        provideDirectory = directory
        return fn()
      },
      run: async () => {
        runCalls++
        if (runShouldThrow) throw new Error("boom")
      },
    }
  }

  beforeEach(() => {
    runCalls = 0
    runShouldThrow = false
    provideCalls = 0
    provideDirectory = undefined
  })

  test("runs upgrade() once inside the process.cwd() instance", async () => {
    await runStartupUpgradeCheck(makeDeps())
    expect(runCalls).toBe(1)
    expect(provideCalls).toBe(1)
    expect(provideDirectory).toBe(process.cwd())
  })

  test("resolves without throwing when upgrade() rejects", async () => {
    runShouldThrow = true
    // Must not reject — a flaky network/registry can't take the server down.
    await expect(runStartupUpgradeCheck(makeDeps())).resolves.toBeUndefined()
    expect(runCalls).toBe(1)
  })

  test("resolves without throwing when provide() itself rejects", async () => {
    const deps: StartupUpgradeDeps = {
      provide: async () => {
        throw new Error("instance boom")
      },
      run: async () => {
        runCalls++
      },
    }
    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(runCalls).toBe(0)
  })

  test("uses a short, sane settle delay", () => {
    expect(STARTUP_UPGRADE_DELAY_MS).toBeGreaterThan(0)
    expect(STARTUP_UPGRADE_DELAY_MS).toBeLessThanOrEqual(5000)
  })
})

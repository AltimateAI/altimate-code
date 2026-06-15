import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// State the mocks record so each test can assert orchestration.
let upgradeCalls = 0
let upgradeShouldThrow = false
let provideDirectory: string | undefined
let provideCalls = 0

// Mirror the real Instance.provide contract just enough: capture the directory
// key and run the supplied fn (no real instance, no dispose).
mock.module("../../src/project/instance", () => ({
  Instance: {
    provide: async (input: { directory: string; fn: () => Promise<unknown> }) => {
      provideCalls++
      provideDirectory = input.directory
      return input.fn()
    },
  },
}))

mock.module("../../src/project/bootstrap", () => ({
  InstanceBootstrap: async () => {},
}))

mock.module("../../src/cli/upgrade", () => ({
  upgrade: async () => {
    upgradeCalls++
    if (upgradeShouldThrow) throw new Error("boom")
  },
}))

const { runStartupUpgradeCheck, STARTUP_UPGRADE_DELAY_MS } = await import("../../src/cli/cmd/serve-upgrade-check")

describe("serve-upgrade-check", () => {
  beforeEach(() => {
    upgradeCalls = 0
    upgradeShouldThrow = false
    provideDirectory = undefined
    provideCalls = 0
  })

  test("runs upgrade() once inside the process.cwd() instance", async () => {
    await runStartupUpgradeCheck()
    expect(upgradeCalls).toBe(1)
    expect(provideCalls).toBe(1)
    expect(provideDirectory).toBe(process.cwd())
  })

  test("resolves without throwing when upgrade() rejects", async () => {
    upgradeShouldThrow = true
    // Must not reject — a flaky network/registry can't take the server down.
    await expect(runStartupUpgradeCheck()).resolves.toBeUndefined()
    expect(upgradeCalls).toBe(1)
  })

  test("uses a short, sane settle delay", () => {
    expect(STARTUP_UPGRADE_DELAY_MS).toBeGreaterThan(0)
    expect(STARTUP_UPGRADE_DELAY_MS).toBeLessThanOrEqual(5000)
  })
})

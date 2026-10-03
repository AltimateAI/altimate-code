// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  readScheduleState, recordReflection, resolveRecoveryLimits, scheduleStateFile,
} from "../../../src/altimate/learn/schedule-state"

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-schedule-state-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

describe("recovery limits", () => {
  test("defaults to three reflections and five minutes", () => {
    expect(resolveRecoveryLimits(undefined, {})).toEqual({
      recovery_max_reflections: 3, recovery_max_seconds: 300,
    })
  })

  test("environment overrides project config and zero disables recovery", () => {
    const config = { recovery_max_reflections: 5, recovery_max_seconds: 600 }
    expect(resolveRecoveryLimits(config, {})).toEqual(config)
    expect(resolveRecoveryLimits(config, {
      ALTIMATE_LEARN_RECOVERY_MAX_REFLECTIONS: "2", ALTIMATE_LEARN_RECOVERY_MAX_SECONDS: "45",
    })).toEqual({ recovery_max_reflections: 2, recovery_max_seconds: 45 })
    expect(resolveRecoveryLimits(config, {
      ALTIMATE_LEARN_RECOVERY_MAX_REFLECTIONS: "0", ALTIMATE_LEARN_RECOVERY_MAX_SECONDS: "0",
    })).toEqual({ recovery_max_reflections: 0, recovery_max_seconds: 0 })
    expect(resolveRecoveryLimits(config, {
      ALTIMATE_LEARN_RECOVERY_MAX_REFLECTIONS: " ", ALTIMATE_LEARN_RECOVERY_MAX_SECONDS: "",
    })).toEqual(config)
  })

  test("rejects negative, fractional, nonnumeric, infinite and unsafe limits", () => {
    for (const key of ["recovery_max_reflections", "recovery_max_seconds"] as const) {
      for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        expect(() => resolveRecoveryLimits({ [key]: value }, {})).toThrow("nonnegative safe integer")
      for (const value of ["-1", "0.5", "oops", "Infinity", "9007199254740992"])
        expect(() => resolveRecoveryLimits({}, { [`ALTIMATE_LEARN_${key.toUpperCase()}`]: value }))
          .toThrow("nonnegative safe integer")
    }
  })
})

describe("persisted reflection state", () => {
  test.each(["success", "failure"] as const)("persists usage for %s records", async (result) => {
    const usage = { inputTokens: 300, outputTokens: 75, estimatedCost: 0.0009 }
    await recordReflection(root, "session", result, "reflection result", undefined, 1_000, usage)
    expect((await readScheduleState(root)).lastReflection).toMatchObject({ result, usage })
    expect(JSON.parse(await fs.readFile(scheduleStateFile(root), "utf8")).lastReflection.usage).toEqual(usage)
  })

  test("reading an unused project leaves its filesystem untouched", async () => {
    expect(await readScheduleState(root)).toEqual({ recoveries: {} })
    expect(await fs.readdir(root)).toEqual([])
  })

  test("persists last reflection and exponential failure backoff across reads", async () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z")
    await recordReflection(root, "session", "failure", "provider unavailable", undefined, now)
    expect(await readScheduleState(root)).toEqual({
      lastReflection: {
        at: "2026-10-02T12:00:00.000Z", sessionID: "session", result: "failure", summary: "provider unavailable",
      },
      recoveries: { session: { failures: 1, retryAt: now + 60_000 } },
    })
    await recordReflection(root, "session", "failure", "retry unavailable", undefined, now + 60_000)
    const state = await readScheduleState(root)
    expect(state.recoveries.session).toEqual({ failures: 2, retryAt: now + 60_000 + 120_000 })
    expect(state.lastReflection).toMatchObject({ result: "failure", summary: "retry unavailable" })
    expect(JSON.parse(await fs.readFile(scheduleStateFile(root), "utf8"))).toEqual(state)
    if (process.platform !== "win32") expect((await fs.stat(scheduleStateFile(root))).mode & 0o777).toBe(0o600)
  })

  test("failure backoff stops growing after one day", async () => {
    const now = 1_000
    for (let failure = 1; failure <= 13; failure++)
      await recordReflection(root, "session", "failure", "unavailable", undefined, now)
    expect((await readScheduleState(root)).recoveries.session).toEqual({
      failures: 13, retryAt: now + 24 * 60 * 60 * 1_000,
    })
  })

  test("success clears only that session's backoff and the next failure starts at one minute", async () => {
    await recordReflection(root, "session", "failure", "unavailable", undefined, 1_000)
    await recordReflection(root, "session", "failure", "unavailable", undefined, 2_000)
    await recordReflection(root, "other", "failure", "unavailable", undefined, 3_000)
    await recordReflection(root, "session", "success", "2 candidate lessons", undefined, 4_000)
    expect(await readScheduleState(root)).toEqual({
      lastReflection: {
        at: new Date(4_000).toISOString(), sessionID: "session", result: "success", summary: "2 candidate lessons",
      },
      recoveries: { other: { failures: 1, retryAt: 63_000 } },
    })
    await recordReflection(root, "session", "failure", "unavailable again", undefined, 5_000)
    expect((await readScheduleState(root)).recoveries.session).toEqual({ failures: 1, retryAt: 65_000 })
  })

  test("concurrent reflection results do not lose failure counts", async () => {
    await Promise.all(Array.from({ length: 4 }, () =>
      recordReflection(root, "session", "failure", "unavailable", undefined, 1_000),
    ))
    expect((await readScheduleState(root)).recoveries.session).toEqual({ failures: 4, retryAt: 481_000 })
  })

  test("reflection summaries are redacted and clipped before persistence", async () => {
    const sensitive = "sk-abcdef1234567890XYZ"
    await recordReflection(root, "session", "failure", `provider rejected ${sensitive} ${"x".repeat(3_000)}`)
    const summary = (await readScheduleState(root)).lastReflection!.summary
    expect(summary).not.toContain(sensitive)
    expect(summary.length).toBeLessThanOrEqual(2_000)
    expect(await fs.readFile(scheduleStateFile(root), "utf8")).not.toContain(sensitive)
  })

  test("named playbooks keep independent reflection state", async () => {
    await recordReflection(root, "session", "failure", "default unavailable", undefined, 1_000)
    await recordReflection(root, "session", "success", "custom ready", "custom-rules", 2_000)
    expect((await readScheduleState(root)).recoveries.session.failures).toBe(1)
    expect((await readScheduleState(root, "custom-rules")).recoveries).toEqual({})
    expect((await readScheduleState(root, "custom-rules")).lastReflection?.summary).toBe("custom ready")
  })
})

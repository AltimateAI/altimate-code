import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

describe("completion validator dispatch", () => {
  const base = {
    active: true,
    result: "continue" as const,
    finish: "stop",
    hasError: false,
    validatorCount: 1,
    explicitDone: false,
  }

  test("an overflowing explicit-DONE turn still runs validators before terminal acceptance", () => {
    expect(SessionPrompt.shouldDispatchValidators({ ...base, result: "stop", explicitDone: true })).toBe(true)
  })

  test("other terminal outcomes and compaction machinery do not run validators", () => {
    expect(SessionPrompt.shouldDispatchValidators({ ...base, result: "stop" })).toBe(false)
    expect(SessionPrompt.shouldDispatchValidators({ ...base, result: "compact" })).toBe(false)
  })
})

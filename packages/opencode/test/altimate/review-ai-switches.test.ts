import { describe, test, expect } from "bun:test"
import { AI_SWITCH_DEFAULTS, AI_SWITCH_ENV, envSwitch, resolveAiSwitches, switchOn } from "../../src/altimate/review/ai-switches"
import { DEFAULT_REVIEW_CONFIG, aiLaneEnabled, parseReviewConfig, policyHash } from "../../src/altimate/review/config"
import { aiInputBudget } from "../../src/altimate/review/ai-review"

describe("AI switches", () => {
  test("env 1/0 override, anything else defers", () => {
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "1" })).toBe(true)
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "0" })).toBe(false)
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "maybe" })).toBeUndefined()
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "" })).toBeUndefined()
    expect(envSwitch("coverage", {})).toBeUndefined()
  })

  test("common boolean spellings are accepted, so `=false` still turns a switch off", () => {
    for (const v of ["true", "TRUE", "on", "yes", " 1 "]) expect(envSwitch("verify", { ALTIMATE_REVIEW_AI_VERIFY: v })).toBe(true)
    for (const v of ["false", "False", "off", "no", "0"]) expect(envSwitch("verify", { ALTIMATE_REVIEW_AI_VERIFY: v })).toBe(false)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "false" }).verify).toBe(false)
  })

  test("a value that is not a boolean is ignored with a warning naming the variable", () => {
    const write0 = process.stderr.write
    let err = ""
    ;(process.stderr as any).write = (s: string) => ((err += s), true)
    try {
      expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "disabled" }).verify).toBe(true)
    } finally {
      ;(process.stderr as any).write = write0
    }
    expect(err).toContain("ALTIMATE_REVIEW_AI_VERIFY=disabled")
  })

  test("env wins over config, config over the default", () => {
    const cfg = { ai: { coverage: true, focused: false } }
    expect(resolveAiSwitches(cfg, {}).coverage).toBe(true)
    expect(resolveAiSwitches(cfg, { ALTIMATE_REVIEW_AI_COVERAGE: "0" }).coverage).toBe(false)
    expect(resolveAiSwitches(cfg, { ALTIMATE_REVIEW_AI_FOCUSED: "1" }).focused).toBe(true)
    expect(resolveAiSwitches({ ai: true }, {})).toEqual(AI_SWITCH_DEFAULTS)
  })

  test("without resolved switches only the env variable counts", () => {
    expect(switchOn("verify", undefined, {})).toBe(false)
    expect(switchOn("verify", undefined, { ALTIMATE_REVIEW_AI_VERIFY: "1" })).toBe(true)
    expect(switchOn("verify", { verify: false }, { ALTIMATE_REVIEW_AI_VERIFY: "1" })).toBe(false)
  })

  test("every switch has an env variable", () => {
    expect(Object.keys(AI_SWITCH_ENV).sort()).toEqual(Object.keys(AI_SWITCH_DEFAULTS).sort())
  })

  test("the input budget follows the switches", () => {
    expect(aiInputBudget({}, { coverage: true }).coverage).toBeDefined()
    expect(aiInputBudget({}, { coverage: false }).coverage).toBeUndefined()
    expect(aiInputBudget({ ALTIMATE_REVIEW_AI_FOCUSED: "1" }).focused).toBeDefined()
    expect(aiInputBudget({}, { focused: true }).focused).toBeDefined()
  })
})

describe("`ai:` in .altimate/review.yml", () => {
  test("boolean and object forms", () => {
    expect(aiLaneEnabled(parseReviewConfig("ai: false"))).toBe(false)
    expect(aiLaneEnabled(parseReviewConfig("ai: true"))).toBe(true)
    expect(aiLaneEnabled(parseReviewConfig("ai:\n  enabled: false"))).toBe(false)
    const cfg = parseReviewConfig("ai:\n  coverage: false\n  verify: true")
    expect(aiLaneEnabled(cfg)).toBe(true)
    expect(resolveAiSwitches(cfg, {}).verify).toBe(true)
    expect(resolveAiSwitches(cfg, {}).coverage).toBe(false)
  })

  test("the default policy hash is unchanged by the object form", () => {
    expect(DEFAULT_REVIEW_CONFIG.ai).toBe(true)
    expect(policyHash(parseReviewConfig("mode: comment"))).toBe(policyHash(DEFAULT_REVIEW_CONFIG))
    // The object form hashes as written: an empty object or a set switch is a different policy.
    const empty = parseReviewConfig("ai: {}")
    expect(aiLaneEnabled(empty)).toBe(true)
    expect(resolveAiSwitches(empty, {})).toEqual(AI_SWITCH_DEFAULTS)
    expect(policyHash(parseReviewConfig("ai:\n  verify: false"))).not.toBe(policyHash(DEFAULT_REVIEW_CONFIG))
  })

  test("an unknown key under `ai:` fails the load and names the key", () => {
    expect(() => parseReviewConfig("ai:\n  enable: false")).toThrow(/unrecognized_keys[\s\S]*"enable"/)
  })
})

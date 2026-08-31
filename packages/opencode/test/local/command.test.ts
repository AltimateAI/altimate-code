import { describe, expect, test } from "bun:test"

import { withOverrides, type LocalArgs } from "../../src/local/command"
import { BUNDLED_RECIPES, type LlamaRecipeTier } from "../../src/local/recipes"

const llamaTier = BUNDLED_RECIPES.models[0]!.tiers.find((tier) => tier.name === "gpu-24gb-discrete")! as LlamaRecipeTier
if (llamaTier.engine !== "llama.cpp") throw new Error("expected a llama.cpp tier fixture")

function args(overrides: Partial<LocalArgs> = {}): LocalArgs {
  return { ...overrides }
}

describe("withOverrides", () => {
  test("passes through the tier unchanged when no overrides are given", () => {
    const result = withOverrides(llamaTier, args())
    expect(result.ctx).toBe(llamaTier.ctx)
    expect(result.parallel).toBe(llamaTier.parallel)
  })

  test("accepts integer --ctx/--parallel that divide evenly", () => {
    const result = withOverrides(llamaTier, args({ ctx: 65536, parallel: 2 }))
    expect(result.ctx).toBe(65536)
    expect(result.parallel).toBe(2)
  })

  test("rejects --ctx that does not divide evenly across --parallel", () => {
    expect(() => withOverrides(llamaTier, args({ ctx: 65536, parallel: 3 }))).toThrow(/positive integers/)
  })

  test("rejects non-positive --ctx or --parallel", () => {
    expect(() => withOverrides(llamaTier, args({ ctx: 0, parallel: 1 }))).toThrow(/positive integers/)
    expect(() => withOverrides(llamaTier, args({ ctx: 65536, parallel: 0 }))).toThrow(/positive integers/)
  })

  // A non-integer can pass the divisibility check by coincidence (or even
  // fail it in a confusing way) while still being an invalid value to hand
  // llama-server as a slot/context count.
  test("rejects a non-integer --ctx even when it happens to divide evenly", () => {
    expect(() => withOverrides(llamaTier, args({ ctx: 1000.5, parallel: 1 }))).toThrow(/positive integers/)
  })

  test("rejects a non-integer --parallel", () => {
    expect(() => withOverrides(llamaTier, args({ ctx: 65536, parallel: 2.5 }))).toThrow(/positive integers/)
  })

  test("applies --effort and --temperature overrides", () => {
    const result = withOverrides(llamaTier, args({ effort: "xhigh", temperature: 0.3 }))
    expect(result.agent.reasoning_effort).toBe("xhigh")
    expect(result.agent.temperature).toBe(0.3)
  })

  test("rejects a negative --temperature", () => {
    expect(() => withOverrides(llamaTier, args({ temperature: -0.1 }))).toThrow(/non-negative/)
  })

  test("--mtp false drops the tier's MTP config", () => {
    const result = withOverrides(llamaTier, args({ mtp: false }))
    expect(result.mtp).toBeUndefined()
  })
})

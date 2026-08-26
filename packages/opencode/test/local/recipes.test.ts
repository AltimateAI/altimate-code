import { describe, expect, test } from "bun:test"

import { BUNDLED_RECIPES, validateRecipes } from "../../src/local/recipes"

describe("local recipe schema", () => {
  test("accepts the bundled schema-v1 snapshot", () => {
    const recipes = validateRecipes(structuredClone(BUNDLED_RECIPES))
    expect(recipes.schema).toBe(1)
    expect(recipes.models[0]?.revision).toBe("4ca720788d1e01f1bff70c033e0d0028fd02e502")
    expect(recipes.models[0]?.tiers.map((tier) => tier.name)).toContain("mac-64gb-unified")
  })

  test("rejects an unknown schema version", () => {
    const input = structuredClone(BUNDLED_RECIPES) as any
    input.schema = 2
    expect(() => validateRecipes(input)).toThrow("recipes.schema must be 1")
  })

  test("rejects an unpinned model revision", () => {
    const input = structuredClone(BUNDLED_RECIPES) as any
    input.models[0].revision = "main"
    expect(() => validateRecipes(input)).toThrow("must be a pinned 40-character commit")
  })

  test("accepts explicit TODO checksum placeholders but rejects arbitrary values", () => {
    const accepted = structuredClone(BUNDLED_RECIPES) as any
    accepted.models[0].tiers[0].sha256 = "TODO_MODEL_SHA256"
    expect(validateRecipes(accepted).models[0]?.tiers[0]?.name).toBe("laptop-24gb")

    const rejected = structuredClone(BUNDLED_RECIPES) as any
    rejected.models[0].tiers[0].sha256 = "unknown"
    expect(() => validateRecipes(rejected)).toThrow("must be a sha256 or a TODO_* placeholder")
  })

  test("rejects context that cannot divide across parallel slots", () => {
    const input = structuredClone(BUNDLED_RECIPES) as any
    input.models[0].tiers[0].parallel = 3
    expect(() => validateRecipes(input)).toThrow("ctx must divide evenly")
  })
})

import { describe, expect, test } from "bun:test"

import { BUNDLED_RECIPES, selectModel, validateRecipes } from "../../src/local/recipes"

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

  // fetchModelArtifacts joins model.id directly into a filesystem path with no
  // further sanitization — a remote (pinned-by-sha256, but not otherwise
  // trusted) recipe containing path separators here could write outside the
  // managed model cache directory.
  test("rejects a model id containing path separators", () => {
    const traversal = structuredClone(BUNDLED_RECIPES) as any
    traversal.models[0].id = "../../etc"
    expect(() => validateRecipes(traversal)).toThrow(/must not contain path separators/)

    const slash = structuredClone(BUNDLED_RECIPES) as any
    slash.models[0].id = "foo/bar"
    expect(() => validateRecipes(slash)).toThrow(/must not contain path separators/)

    const dotdot = structuredClone(BUNDLED_RECIPES) as any
    dotdot.models[0].id = ".."
    expect(() => validateRecipes(dotdot)).toThrow(/must not contain path separators/)
  })

  test("rejects a docker tier container_port outside the valid port range", () => {
    const dockerModel = structuredClone(BUNDLED_RECIPES) as any
    const dockerTier = dockerModel.models[0].tiers.find((tier: any) => tier.engine === "docker-sglang")
    expect(dockerTier).toBeDefined()
    dockerTier.container_port = 70000
    expect(() => validateRecipes(dockerModel)).toThrow(/container_port must be between 1 and 65535/)
  })
})

describe("selectModel", () => {
  test("defaults to the first registry entry", () => {
    const recipes = validateRecipes(structuredClone(BUNDLED_RECIPES))
    expect(selectModel(recipes).id).toBe(recipes.models[0]!.id)
  })

  test("selects a model by id", () => {
    const recipes = validateRecipes(structuredClone(BUNDLED_RECIPES))
    const id = recipes.models[0]!.id
    expect(selectModel(recipes, id).id).toBe(id)
  })

  test("rejects an unknown id and lists what is available", () => {
    const recipes = validateRecipes(structuredClone(BUNDLED_RECIPES))
    expect(() => selectModel(recipes, "no-such-model")).toThrow(/Unknown local model.*Available/)
  })
})

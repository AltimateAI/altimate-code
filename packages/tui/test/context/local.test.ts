import { expect, test } from "bun:test"
import {
  allowsManagedBaseDefault,
  ALTIMATE_BASE_MODEL,
  isExistingBigPickleSelection,
  LEGACY_BIG_PICKLE_MODEL,
  migrateLegacyRecentModels,
  parseModel,
  recentModels,
  shouldMigrateLegacyDefault,
} from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("distinguishes an existing Big Pickle user from a fresh catalogue fallback", () => {
  expect(isExistingBigPickleSelection(LEGACY_BIG_PICKLE_MODEL, [], false)).toBe(false)
  expect(isExistingBigPickleSelection(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], false)).toBe(true)
  expect(isExistingBigPickleSelection(LEGACY_BIG_PICKLE_MODEL, [], true)).toBe(true)
  expect(
    isExistingBigPickleSelection({ providerID: "openai", modelID: "gpt-5" }, [LEGACY_BIG_PICKLE_MODEL], false),
  ).toBe(false)
})

test("honors project provider allowlists during Big Pickle default migration", () => {
  expect(allowsManagedBaseDefault(undefined)).toBe(true)
  expect(allowsManagedBaseDefault({})).toBe(true)
  expect(allowsManagedBaseDefault({ openai: {} })).toBe(false)
  expect(allowsManagedBaseDefault({ "altimate-free": {} })).toBe(false)

  expect(shouldMigrateLegacyDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], false, {})).toBe(true)
  expect(
    shouldMigrateLegacyDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], false, { openai: {} }),
  ).toBe(false)
  expect(shouldMigrateLegacyDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], true, {})).toBe(false)
})

test("replaces Big Pickle recents while preserving every unrelated model and order", () => {
  expect(
    migrateLegacyRecentModels([
      { providerID: "anthropic", modelID: "claude-sonnet" },
      LEGACY_BIG_PICKLE_MODEL,
      { providerID: "openai", modelID: "gpt-5" },
      LEGACY_BIG_PICKLE_MODEL,
      ALTIMATE_BASE_MODEL,
      null,
      "malformed",
      { providerID: "missing-model-id" },
    ]),
  ).toEqual([
    ALTIMATE_BASE_MODEL,
    { providerID: "anthropic", modelID: "claude-sonnet" },
    { providerID: "openai", modelID: "gpt-5" },
  ])
})

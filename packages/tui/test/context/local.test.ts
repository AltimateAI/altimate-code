import { expect, test } from "bun:test"
import {
  allowsManagedBaseDefault,
  ALTIMATE_BASE_MODEL,
  isConfirmedExplicitSelection,
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

test("preserves a deliberate re-selection of Big Pickle made through a picker after registration", () => {
  // A user who already registered Altimate Base can still open `/model` and pick Big Pickle on
  // purpose. That choice lands in the exact same `model`/`recent` fields the retired implicit
  // default used, so `isConfirmedExplicitSelection` is the only thing that can tell them apart —
  // it must be true here, and `shouldMigrateLegacyDefault` must then refuse to overwrite it.
  const explicit = isConfirmedExplicitSelection(LEGACY_BIG_PICKLE_MODEL, LEGACY_BIG_PICKLE_MODEL)
  expect(explicit).toBe(true)
  expect(shouldMigrateLegacyDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], explicit, {})).toBe(false)
})

test("does not confirm an explicit selection once the current model has moved on", () => {
  // The marker only vouches for the CURRENT selection. Once the user picks something else (or an
  // older session restores a different model), a stale marker must not immunize whatever is
  // current now — including a genuinely implicit Big Pickle default.
  expect(isConfirmedExplicitSelection(LEGACY_BIG_PICKLE_MODEL, ALTIMATE_BASE_MODEL)).toBe(false)
  expect(isConfirmedExplicitSelection(LEGACY_BIG_PICKLE_MODEL, undefined)).toBe(false)
  expect(isConfirmedExplicitSelection(undefined, LEGACY_BIG_PICKLE_MODEL)).toBe(false)

  const notExplicit = isConfirmedExplicitSelection(LEGACY_BIG_PICKLE_MODEL, ALTIMATE_BASE_MODEL)
  expect(shouldMigrateLegacyDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL], notExplicit, {})).toBe(true)
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

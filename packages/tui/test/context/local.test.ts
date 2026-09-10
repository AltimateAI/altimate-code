import { expect, test } from "bun:test"
import {
  allowsManagedBaseDefault,
  ALTIMATE_BASE_MODEL,
  isConfirmedExplicitSelection,
  isExistingBigPickleSelection,
  // altimate_change start — fixes #1301: broaden legacy-default migration eligibility
  isFreeZenModel,
  shouldOfferManagedBaseDefault,
  // altimate_change end
  // altimate_change start — fixes #1301 (Codex review, P2): usable-free-default predicate
  isUsableFreeDefault,
  // altimate_change end
  // altimate_change start — fixes #1301 (Codex review round 2, P1): migration correctness
  isOwnPastPickOfFreeDefault,
  shouldMoveAgentModelDuringMigration,
  // altimate_change end
  LEGACY_BIG_PICKLE_MODEL,
  migrateLegacyRecentModels,
  parseModel,
  recentModels,
  shouldMigrateLegacyDefault,
} from "../../src/context/local"
import type { ConnectedProviderShape } from "../../src/util/connected"

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

// altimate_change start — fixes #1301: offer Altimate Base to every user riding an implicit free
// OpenCode Zen default, not only the retired Big Pickle id.
const NEMOTRON = { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" } as const
const ZEN_PAID = { providerID: "opencode", modelID: "zen-paid" } as const

function providersFixture(): ConnectedProviderShape[] {
  return [
    {
      id: "opencode",
      models: {
        "nemotron-3.5-lightning-free": { cost: undefined },
        "big-pickle": { cost: { input: 0 } },
        "zen-paid": { cost: { input: 3 } },
      },
    },
    {
      id: "anthropic",
      models: {
        "claude-sonnet": { cost: { input: 3 } },
      },
    },
  ]
}

test("identifies a free OpenCode Zen model regardless of cost being zero or absent", () => {
  const providers = providersFixture()
  expect(isFreeZenModel(NEMOTRON, providers)).toBe(true)
  expect(isFreeZenModel(LEGACY_BIG_PICKLE_MODEL, providers)).toBe(true)
})

test("does not treat a paid Zen model, another provider, or a missing catalogue entry as free", () => {
  const providers = providersFixture()
  expect(isFreeZenModel(ZEN_PAID, providers)).toBe(false)
  expect(isFreeZenModel({ providerID: "anthropic", modelID: "claude-sonnet" }, providers)).toBe(false)
  expect(isFreeZenModel({ providerID: "opencode", modelID: "does-not-exist" }, providers)).toBe(false)
  expect(isFreeZenModel(undefined, providers)).toBe(false)
})

test("offers Altimate Base for an implicit free default but never for an explicit one or an allowlisted project", () => {
  const isFree = (model: { providerID: string; modelID: string }) =>
    isFreeZenModel(model, providersFixture()) || model.modelID === LEGACY_BIG_PICKLE_MODEL.modelID

  // Implicit free Zen default (the case the old Big-Pickle-only, recent-gated check missed).
  expect(shouldOfferManagedBaseDefault(NEMOTRON, false, {}, isFree)).toBe(true)
  // Implicit Big Pickle default still qualifies too.
  expect(shouldOfferManagedBaseDefault(LEGACY_BIG_PICKLE_MODEL, false, {}, isFree)).toBe(true)
  // A deliberate (picker-driven or CLI/config) choice is never overridden.
  expect(shouldOfferManagedBaseDefault(NEMOTRON, true, {}, isFree)).toBe(false)
  // A project provider allowlist that excludes the managed provider is respected.
  expect(shouldOfferManagedBaseDefault(NEMOTRON, false, { anthropic: {} }, isFree)).toBe(false)
  // No current model at all (e.g. no provider connected) has nothing to offer.
  expect(shouldOfferManagedBaseDefault(undefined, false, {}, isFree)).toBe(false)
})

test("migrateLegacyRecentModels also drops the previous free default so cycling cannot bounce back onto it", () => {
  expect(
    migrateLegacyRecentModels(
      [NEMOTRON, { providerID: "anthropic", modelID: "claude-sonnet" }, LEGACY_BIG_PICKLE_MODEL],
      NEMOTRON,
    ),
  ).toEqual([ALTIMATE_BASE_MODEL, { providerID: "anthropic", modelID: "claude-sonnet" }])
  // Without a `previous`, behavior is unchanged from before (only Big Pickle is dropped).
  expect(migrateLegacyRecentModels([NEMOTRON, LEGACY_BIG_PICKLE_MODEL])).toEqual([ALTIMATE_BASE_MODEL, NEMOTRON])
})
// altimate_change end

// altimate_change start — fixes #1301 (Codex review, P1): explicitness must be judged against
// the SAME model eligibility is judged against (`fallbackModel()`, the launch default), not
// `currentModel()` — which can be a session-restored model unrelated to the launch default.
test("explicitness must be checked against the launch default, not a session-restored model", () => {
  const isFree = (model: { providerID: string; modelID: string }) => isFreeZenModel(model, providersFixture())
  const explicitDefault = NEMOTRON
  const fallbackModel = NEMOTRON // the launch default the user explicitly chose
  const restoredSessionModel = { providerID: "anthropic", modelID: "claude-sonnet" } // an unrelated open conversation

  // Correct: explicitness checked against the SAME model eligibility evaluates (`fallbackModel`).
  // `usesImplicitFreeDefault()` in local.tsx now does exactly this via `hasExplicitDefault()`.
  const explicitAgainstFallback = isConfirmedExplicitSelection(fallbackModel, explicitDefault)
  expect(explicitAgainstFallback).toBe(true)
  expect(shouldOfferManagedBaseDefault(fallbackModel, explicitAgainstFallback, {}, isFree)).toBe(false)

  // The bug this guards against: checking explicitness against `currentModel()` — here standing
  // in for a restored session on a different, unrelated conversation — finds no match,
  // misclassifies the deliberate Nemotron pick as implicit, and `usesImplicitFreeDefault()` would
  // wrongly become eligible to migrate, overwriting the restored conversation's model with Base.
  const explicitAgainstRestoredSession = isConfirmedExplicitSelection(restoredSessionModel, explicitDefault)
  expect(explicitAgainstRestoredSession).toBe(false)
  expect(shouldOfferManagedBaseDefault(fallbackModel, explicitAgainstRestoredSession, {}, isFree)).toBe(true)
})
// altimate_change end

// altimate_change start — fixes #1301 (Codex review, P2): a free default the user chose on
// purpose, or already declined migrating away from, is usable — not "un-onboarded".
test("isUsableFreeDefault: usable when explicit or previously declined, never when neither", () => {
  const isValid = () => true
  const isFree = (model: { providerID: string; modelID: string }) => isFreeZenModel(model, providersFixture())

  // Explicitly chosen, never declined: usable.
  expect(isUsableFreeDefault(NEMOTRON, isValid, isFree, true, false)).toBe(true)
  // Not explicit, but a previous decline is on record (kv key or model.json flag): usable.
  expect(isUsableFreeDefault(NEMOTRON, isValid, isFree, false, true)).toBe(true)
  // Neither explicit nor declined: still "un-onboarded" — not usable.
  expect(isUsableFreeDefault(NEMOTRON, isValid, isFree, false, false)).toBe(false)
  // A paid/non-free model is never usable via this path regardless of explicitness/decline.
  expect(isUsableFreeDefault(ZEN_PAID, isValid, isFree, true, true)).toBe(false)
  // An invalid (no longer offered) model is never usable.
  expect(isUsableFreeDefault(NEMOTRON, () => false, isFree, true, true)).toBe(false)
  // No current model at all.
  expect(isUsableFreeDefault(undefined, isValid, isFree, true, true)).toBe(false)
})
// altimate_change end

// altimate_change start — fixes #1301 (Codex review round 2, P1): `migrateLegacyDefault()` in
// local.tsx is closure-internal and needs `LocalProvider`/`SyncProvider`/SDK mocks to exercise
// directly (the existing dialog test harness in dialog-altimate-base.test.tsx does not go through
// this function at all — it mounts the dialog with a stubbed `onDecline`, never accept). Per
// review guidance, this is the pure-function test standing in for that: it exercises the EXACT
// predicate `migrateLegacyDefault()` now calls (`shouldMoveAgentModelDuringMigration`), not a
// hand-rolled comparison, so a change to that predicate's logic is caught here even without a
// full-context test.
test("shouldMoveAgentModelDuringMigration: only moves a conversation still on the implicit default", () => {
  const previous = NEMOTRON // the implicit free default being migrated away from
  const restoredSession = { providerID: "anthropic", modelID: "claude-sonnet" } // an unrelated open conversation

  // Still on the implicit default (the common case: no session restored) — migrate it.
  expect(shouldMoveAgentModelDuringMigration(previous, previous)).toBe(true)
  // No current model at all (e.g. agent has no per-agent model set yet) — nothing to preserve.
  expect(shouldMoveAgentModelDuringMigration(undefined, previous)).toBe(true)
  // A restored conversation on a DIFFERENT model must be left alone — this is the regression:
  // migration is a decision about the DEFAULT, not about overwriting an unrelated open thread.
  expect(shouldMoveAgentModelDuringMigration(restoredSession, previous)).toBe(false)
  // No captured `previous` at all (should not happen in practice — `usesLegacyDefault()` already
  // requires a defined `fallbackModel()` — but fail closed rather than move an unrelated model).
  expect(shouldMoveAgentModelDuringMigration(restoredSession, undefined)).toBe(false)
})

test("isOwnPastPickOfFreeDefault: an older picker-written recent is the user's own pick, not implicit", () => {
  // An older Nemotron recent (predates the `explicitDefault` marker) is still the user's own past
  // pick — silent migration when Base is registered must not sweep it up without asking.
  expect(isOwnPastPickOfFreeDefault(NEMOTRON, [NEMOTRON, { providerID: "anthropic", modelID: "claude-sonnet" }])).toBe(
    true,
  )
  // Not in recents at all: a genuinely implicit default, silent migration proceeds as before.
  expect(isOwnPastPickOfFreeDefault(NEMOTRON, [{ providerID: "anthropic", modelID: "claude-sonnet" }])).toBe(false)
  expect(isOwnPastPickOfFreeDefault(NEMOTRON, [])).toBe(false)
  // Big Pickle is deliberately excluded — recents written before this distinction existed were
  // always silently migrated, and that stays unchanged ("today's behaviour").
  expect(isOwnPastPickOfFreeDefault(LEGACY_BIG_PICKLE_MODEL, [LEGACY_BIG_PICKLE_MODEL])).toBe(false)
  // No current model at all.
  expect(isOwnPastPickOfFreeDefault(undefined, [NEMOTRON])).toBe(false)
})
// altimate_change end

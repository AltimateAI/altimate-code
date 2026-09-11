import { expect, test } from "bun:test"
// altimate_change — cubic review (3986532221): the real, module-level onboarding signals, to
// test the app.tsx call site's discriminator computation against the ACTUAL production functions
// rather than only the pure `shouldSkipOnboardingAtStartup` predicate in isolation.
import {
  markFirstRunActive,
  markSetupComplete,
  resetSetupComplete,
  useFirstRunOpenedThisLaunch,
  useSetupComplete,
} from "../../src/component/altimate-onboarding"
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
  // altimate_change start — Kilo review round 6: kv.ready gate for hasUsableFreeDefault()
  hasUsableFreeDefaultGated,
  // altimate_change end
  // altimate_change start — Kilo review round 6: app.tsx startup onboarding-skip discriminator
  shouldSkipOnboardingAtStartup,
  // altimate_change end
  // altimate_change start — fixes #1301 (Codex review round 2, P1): migration correctness
  isOwnPastPickOfFreeDefault,
  shouldMoveAgentModelDuringMigration,
  // altimate_change end
  // altimate_change start — PR #1302 Codex review round 2
  isLegacyBigPickleModel,
  isMigrationStillEligibleAfterCapture,
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

// altimate_change start — PR #1302 Codex review round 2, P1: `cycle()` (the recent-model
// shortcut) sets `explicitDefault` to whichever model was cycled TO, without reordering
// `recent` — so `fallbackModel()` (the LAUNCH default) can still resolve to the model cycled
// FROM. Usability (`hasUsableFreeDefault()`) must therefore compare explicitness against
// `currentModel()` (`hasExplicitModel()`'s comparison), not `fallbackModel()`
// (`hasExplicitDefault()`'s — the right comparison for MIGRATION eligibility, the wrong one for
// "is the model in use right now usable").
test("readiness after cycling: explicitness must be judged against the model in use, not the launch default", () => {
  const isFree = (model: { providerID: string; modelID: string }) =>
    isLegacyBigPickleModel(model) || isFreeZenModel(model, providersFixture())
  const launchDefault = NEMOTRON // A: what fallbackModel() still resolves to after cycling
  const cycledTo = LEGACY_BIG_PICKLE_MODEL // B: the current model, and what explicitDefault now is

  // Correct: explicitness checked against the model actually in use sees the deliberate cycle
  // and stays usable — this is `hasExplicitModel()`'s comparison.
  const explicitAgainstCurrent = isConfirmedExplicitSelection(cycledTo, cycledTo)
  expect(explicitAgainstCurrent).toBe(true)
  expect(isUsableFreeDefault(cycledTo, () => true, isFree, explicitAgainstCurrent, false)).toBe(true)

  // The bug this guards against: checking explicitness against the LAUNCH default instead
  // (`hasExplicitDefault()`'s comparison) finds no match — `explicitDefault` is B, not A — so
  // usability wrongly flips false for a model the user just deliberately picked, flipping
  // `useReady()` true→false and reopening the picker (clearing the prompt) on the next submit.
  const explicitAgainstLaunchDefault = isConfirmedExplicitSelection(launchDefault, cycledTo)
  expect(explicitAgainstLaunchDefault).toBe(false)
  expect(isUsableFreeDefault(cycledTo, () => true, isFree, explicitAgainstLaunchDefault, false)).toBe(false)
})
// altimate_change end

// altimate_change start — round 6 review (cursor 3986044810/3986264141, cubic 3986055646,
// kilo 3986171198, all independently converging): `cycle()` now passes `{ explicit: true,
// recent: true }` so the cycled-to model moves to the FRONT of `recent` — the only state
// headless/ACP default resolution (`Provider.readDefaultModelState()`,
// `defaultModelFromConfig()`) reads. A prior fix instead made `fallbackModel()` prefer a
// persisted `explicitDefault` over `recent`'s order, without teaching the server about that
// TUI-only marker at all — so the TUI and server could resolve two different launch defaults
// from the same `model.json` after a cycle. Reverted; `recent`'s order is the single source of
// truth for every surface.
test("cycling persists the launch default via recents order, not a TUI-only marker", () => {
  const recent = [NEMOTRON, LEGACY_BIG_PICKLE_MODEL]
  const cycledTo = LEGACY_BIG_PICKLE_MODEL // B: what cycle(1) from NEMOTRON selects

  // This mirrors exactly what `cycle()` → `selectModel(val, { recent: true })` persists:
  // `recentModels(cycledTo, recent)` moves B to the front, same as any other deliberate pick
  // (`cycleFavorite`, `/model`) already does.
  const persisted = recentModels(cycledTo, recent)
  expect(persisted).toEqual([LEGACY_BIG_PICKLE_MODEL, NEMOTRON])

  // `fallbackModel()`'s `recent` loop (TUI) and `Provider.readDefaultModelState()` /
  // `defaultModelFromConfig()` (headless/ACP, server-side) all resolve the launch default to the
  // FIRST valid entry in `recent` — so after a cycle, every surface reading the same persisted
  // array agrees on B, with no separate marker for the server to not know about.
  expect(persisted[0]).toEqual(cycledTo)
})
// altimate_change end

// altimate_change start — Kilo review round 6 (3986171192) / Codex HOLD finding 1: `hasUsableFreeDefault()`
// used to read the kv migration-decline key with no `kv.ready` gate. A pre-0.11.x decliner whose
// refusal lives ONLY in kv (no `explicitDefault`, no picker-written recent, legacy Big Pickle so
// `hasOwnPickOfImplicitDefault()` is also false) reads as "not declined" before kv hydrates.
// A FIRST fix attempt made an unready kv read as `true` ("assume usable") — Codex caught that
// going the WRONG direction: it makes `useReady()` true immediately, before onboarding/migration
// ever runs, so `--prompt` (or a fast manual submit) sails straight through to the implicit
// public Zen default — trading a false negative (discarded input) for a false positive (skipped
// onboarding/migration), which is worse. The correct third state is `"pending"`, not a boolean
// guess either way — see `hasUsableFreeDefaultGated`'s declaration in local.tsx, and
// `useReadyPending()`/the submit-gate defer logic in component/prompt/index.tsx for how the ONE
// caller that must see `"pending"` (the prompt submit gate) uses it to defer without discarding.
test("hasUsableFreeDefault reports 'pending' (not a boolean guess) while kv is unready", () => {
  // kv not ready yet: neither `true` nor `false` — explicitly "don't know yet."
  expect(hasUsableFreeDefaultGated(false, () => false)).toBe("pending")
  expect(hasUsableFreeDefaultGated(false, () => true)).toBe("pending")
  // kv ready: the underlying computation is authoritative.
  expect(hasUsableFreeDefaultGated(true, () => false)).toBe(false)
  expect(hasUsableFreeDefaultGated(true, () => true)).toBe(true)
})
// altimate_change end

// altimate_change start — Kilo review round 6 (3986171188): app.tsx's startup effect used to
// latch "no onboarding needed this launch" purely off `hasExistingLegacySelection() ||
// hasUsableFreeDefault()`, skipping the `onboardingReady()` branch (funnel telemetry +
// `openScanGate()`) even when THIS launch's own impatient-user setup — not a returning user's
// persisted state — is what made that true. `setupCompleteThisLaunch` is the fix.
test("shouldSkipOnboardingAtStartup: a same-launch setup must not swallow the onboardingReady() branch", () => {
  // A genuine returning user: legacy/free-default signal true, but nothing was set up THIS
  // launch — skip onboarding, as before.
  expect(shouldSkipOnboardingAtStartup(true, false, false)).toBe(true)
  expect(shouldSkipOnboardingAtStartup(false, true, false)).toBe(true)

  // The regression this guards: an impatient first-run user's own submit-before-ready flow made
  // `hasUsableFreeDefault()` (or `hasExistingLegacySelection()`) true THIS launch, via
  // `setupComplete()`. Must NOT skip — `onboardingReady()` needs to see this to fire telemetry
  // and the scan gate.
  expect(shouldSkipOnboardingAtStartup(true, false, true)).toBe(false)
  expect(shouldSkipOnboardingAtStartup(false, true, true)).toBe(false)

  // Neither signal true: nothing to skip either way.
  expect(shouldSkipOnboardingAtStartup(false, false, false)).toBe(false)
  expect(shouldSkipOnboardingAtStartup(false, false, true)).toBe(false)
})
// altimate_change end

// altimate_change start — cubic review (3986532221): the fix above still passed a bare
// `setupComplete()` at the app.tsx call site, which is a GLOBAL flag `markSetupComplete()` sets
// for ANY model selection, not only a first-run one. A RETURNING user (existing
// legacy/free-default selection) who does an ordinary `/model` switch while app.tsx's startup
// effect is still settling made `setupComplete()` true too, which used to fall through to the
// `onboardingReady()` branch and fire `onboarding_started`/`onboarding_completed`/
// `scan_gate_shown` telemetry plus `openScanGate()` for a routine model change — not a first run.
// `firstRunOpenedThisLaunch()` (altimate-onboarding.tsx) is a one-way latch set only when the
// first-run picker itself actually opens THIS launch (app.tsx's own fallthrough, or the prompt
// gate's equivalent in component/prompt/index.tsx); `setupComplete() && firstRunOpenedThisLaunch()`
// — what app.tsx now actually passes — is the correct "did first-run genuinely complete this
// launch" signal. These tests exercise the REAL production signals (not synthetic booleans),
// asserting `shouldSkipOnboardingAtStartup` receives the correctly-computed discriminator: `skip
// === true` means app.tsx's startup effect returns BEFORE ever reaching the telemetry/scan-gate
// branch, so it is the direct proxy for "no onboarding telemetry, no scan gate" at this call site.
test("a returning user's routine /model switch during the startup race window fires no onboarding telemetry or scan gate", () => {
  resetSetupComplete()
  try {
    // Returning user: has an existing legacy/free-default selection (`hasExistingLegacySelection`
    // true below). They switch models via an ORDINARY `/model` pick — NOT through the first-run
    // picker — while app.tsx's startup effect is still settling. `markSetupComplete()` fires for
    // this exactly as it does for every model pick, first-run or not.
    markSetupComplete()
    const setupComplete = useSetupComplete()
    const firstRunOpenedThisLaunch = useFirstRunOpenedThisLaunch()
    expect(setupComplete()).toBe(true)
    expect(firstRunOpenedThisLaunch()).toBe(false)

    // Mirrors app.tsx's actual call site exactly.
    const skip = shouldSkipOnboardingAtStartup(true, false, setupComplete() && firstRunOpenedThisLaunch())
    expect(skip).toBe(true)
  } finally {
    resetSetupComplete()
  }
})

test("a genuine impatient first-run completion (the prompt gate opened this launch) still fires the onboardingReady() branch", () => {
  resetSetupComplete()
  try {
    // The prompt gate (component/prompt/index.tsx's `!ready()` branch) — or app.tsx's own
    // startup fallthrough — actually opened the first-run picker THIS launch...
    markFirstRunActive()
    // ...and the user picked a free model there, completing it.
    markSetupComplete()
    const setupComplete = useSetupComplete()
    const firstRunOpenedThisLaunch = useFirstRunOpenedThisLaunch()
    expect(setupComplete()).toBe(true)
    expect(firstRunOpenedThisLaunch()).toBe(true)

    const skip = shouldSkipOnboardingAtStartup(false, true, setupComplete() && firstRunOpenedThisLaunch())
    expect(skip).toBe(false)
  } finally {
    resetSetupComplete()
  }
})
// altimate_change end

// altimate_change start — PR #1302 Codex review round 2, P2: `migrateLegacyDefault({ from })`'s
// captured `from` must not bypass free-model validation entirely.
test("isMigrationStillEligibleAfterCapture: only the launch-default-unchanged or registration-induced-Base transitions stay eligible", () => {
  const from = NEMOTRON

  // Still exactly `from`: the ordinary case (nothing changed while the dialog was open).
  expect(isMigrationStillEligibleAfterCapture(from, from, false, {})).toBe(true)
  // Registration itself moved the launch default to Base: the expected post-registration state.
  expect(isMigrationStillEligibleAfterCapture(ALTIMATE_BASE_MODEL, from, false, {})).toBe(true)
  // A provider refresh moved the launch default to some OTHER (in particular PAID) model for an
  // unrelated reason — this must NOT stay eligible, or accept would insert Base on top of a
  // default that changed out from under it.
  expect(isMigrationStillEligibleAfterCapture(ZEN_PAID, from, false, {})).toBe(false)
  expect(
    isMigrationStillEligibleAfterCapture({ providerID: "anthropic", modelID: "claude-sonnet" }, from, false, {}),
  ).toBe(false)
  // Explicit or allowlist-excluded still block it regardless of which model `fallbackModel()` is.
  expect(isMigrationStillEligibleAfterCapture(from, from, true, {})).toBe(false)
  expect(isMigrationStillEligibleAfterCapture(from, from, false, { anthropic: {} })).toBe(false)
  // No current fallback at all (e.g. no provider connected any more).
  expect(isMigrationStillEligibleAfterCapture(undefined, from, false, {})).toBe(false)
})
// altimate_change end

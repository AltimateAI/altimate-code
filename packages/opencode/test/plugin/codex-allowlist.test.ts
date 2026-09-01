// Regression coverage for the ChatGPT-subscription (OAuth) model filter
// in packages/opencode/src/plugin/codex.ts — the ACTIVE plugin wired
// via plugin/index.ts.
//
// The allowlist is a verified truth table, not a guess. Every id in
// VERIFIED_ACCEPTED and VERIFIED_REJECTED below was probed against the live
// backend (POST https://chatgpt.com/backend-api/codex/responses) on a ChatGPT
// Pro credential, using our own `originator: altimate` client identity over
// plain HTTP. Accepted ids returned HTTP 200; rejected ids returned
// 400 {"detail":"The '<id>' model is not supported when using Codex with a
// ChatGPT account."}
//
// Ids asserted OUTSIDE those two lists were NOT probed and are not claimed to
// have been:
//   * older codex ids (gpt-5.1-codex, gpt-5.1-codex-max, …). These ARE present
//     in the bundled provider/models-snapshot.ts, so on a cold cache they do
//     reach the loader and this filter does drop them. That drop is deliberate
//     and fail-closed, not verified — see the "OLDER CODEX IDS" note on
//     OAUTH_ALLOWED_MODELS. Asserting them here pins the current behaviour;
//     it does not claim the backend rejects them.
//   * obviously-unrelated ids (claude-*, gemini-*, gpt-4o) and invented names,
//     which are pure shape assertions against a substring rule creeping back.
// The probe scope, the unprobed catalog ids, and the cold-cache caveat are all
// recorded on OAUTH_ALLOWED_MODELS in src/plugin/codex.ts.
//
// Two directions of breakage this file guards:
//   * false positives — an id offered in the picker that 400s at request time
//     (previously gpt-5.2, gpt-5.6, gpt-5.3-codex)
//   * false negatives — a working subscription model hidden from the picker
//     (previously the gpt-5.6 sol/luna/terra variants, i.e. the current
//     flagship models)
//
// Supersedes the narrower framing of issue #1132, which added plain gpt-5.6 to
// the allowlist on catalog presence alone. The backend rejects that id; only
// its sol/luna/terra variants are actually served on the subscription.
//
// Sibling file plugin/openai/codex.ts is an in-progress refactor of the
// same plugin, currently NOT wired via plugin/index.ts, and NOT covered
// by this file — it has its own separate ``ALLOWED_MODELS`` + a
// ``parseFloat > 5.4`` fallback in its ``models()`` filter, and its
// existing test file (test/plugin/codex.test.ts) already covers its
// OAuth-flow + JWT parsing internals. When that refactor is wired,
// adopting ``shouldAllowOAuthModel`` here (and expanding this file's
// coverage to the newly-active filter) is followup work.
import { describe, expect, test } from "bun:test"
import { OAUTH_ALLOWED_MODELS, disallowedOAuthModelKeys, shouldAllowOAuthModel } from "../../src/plugin/codex"

/** Verified HTTP 200 on a ChatGPT Pro subscription credential. */
const VERIFIED_ACCEPTED = ["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]

/** Retired from the ChatGPT-subscription picker on 2026-08-31T19:00:00Z.
 *
 * Both probed HTTP 200 before the deadline, so they are not in
 * VERIFIED_REJECTED — they stopped being offered rather than being refused.
 * Source: `openai/codex`'s shipped codex-rs/models-manager/models.json marks
 * both `visibility: "hide"` with `upgrade.retirement_at: "2026-08-31T19:00:00Z"`.
 * Replacements (gpt-5.4 -> gpt-5.6-terra, gpt-5.4-mini -> gpt-5.6-luna) are in
 * VERIFIED_ACCEPTED above.
 *
 * These are still live API models, so models.dev keeps them and the catalog
 * will not drop them for us — the allowlist is what has to. */
const RETIRED_FROM_SUBSCRIPTION = ["gpt-5.4", "gpt-5.4-mini"]

/** Verified HTTP 400 "not supported when using Codex with a ChatGPT account". */
const VERIFIED_REJECTED = [
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5-pro",
  "gpt-5.6",
]

describe("OAUTH_ALLOWED_MODELS — verified subscription truth table", () => {
  test("every id verified as accepted is allowlisted", () => {
    // False negatives hide working models from the picker. The sol/luna/terra
    // variants are the current flagship subscription models — a previous
    // revision excluded them on the untested assumption that they were
    // API-tier-only, which cost users access to models they already pay for.
    for (const id of VERIFIED_ACCEPTED) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(true)
    }
  })

  test("every id verified as rejected stays out of the allowlist", () => {
    // False positives are worse than a missing model: the id shows up in the
    // picker, the user selects it, and the request dies with an opaque 400.
    for (const id of VERIFIED_REJECTED) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(false)
    }
  })

  test("the allowlist contains nothing beyond the verified-accepted set", () => {
    // Trip-wire against speculative additions. To add an id here, probe it
    // against the live endpoint first and land it in VERIFIED_ACCEPTED too.
    expect([...OAUTH_ALLOWED_MODELS].sort()).toEqual([...VERIFIED_ACCEPTED].sort())
  })

  test("ids retired from the subscription picker are not offered", () => {
    // gpt-5.4 / gpt-5.4-mini retired 2026-08-31T19:00:00Z. They remain live API
    // models, so models.dev still lists them and the catalog will not remove
    // them for us — if they were still allowlisted they would sit in the
    // subscription picker and fail at request time.
    for (const id of RETIRED_FROM_SUBSCRIPTION) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(false)
      expect(shouldAllowOAuthModel(id)).toBe(false)
    }
  })

  test("each retired id's documented replacement is offered", () => {
    // The point of removing them is that users land somewhere that works.
    expect(shouldAllowOAuthModel("gpt-5.6-terra")).toBe(true) // replaces gpt-5.4
    expect(shouldAllowOAuthModel("gpt-5.6-luna")).toBe(true) // replaces gpt-5.4-mini
  })
})

describe("shouldAllowOAuthModel — behavior of the filter itself", () => {
  // Behavior-level coverage: even if a refactor stops passing
  // OAUTH_ALLOWED_MODELS through, the filter function is what the
  // loader actually calls, so this catches breakage the constant-only
  // tests above would miss.

  test("verified-accepted ids pass", () => {
    for (const id of VERIFIED_ACCEPTED) {
      expect(shouldAllowOAuthModel(id)).toBe(true)
    }
  })

  test("verified-rejected ids are filtered out", () => {
    for (const id of VERIFIED_REJECTED) {
      expect(shouldAllowOAuthModel(id)).toBe(false)
    }
  })

  test("a 'codex' substring does not grant access on its own", () => {
    // Regression barrier for the removed `modelId.includes("codex")`
    // auto-allow. The backend accepts gpt-5.3-codex-spark but rejects
    // gpt-5.3-codex, so no substring rule can express the real policy —
    // reintroducing one puts broken ids back in the picker.
    expect(shouldAllowOAuthModel("gpt-5.3-codex")).toBe(false)
    expect(shouldAllowOAuthModel("gpt-5.1-codex")).toBe(false)
    expect(shouldAllowOAuthModel("gpt-5.1-codex-max")).toBe(false)
    expect(shouldAllowOAuthModel("codex-hypothetical-future-name")).toBe(false)
    // ...while the one codex id that IS accepted still passes, by exact match.
    expect(shouldAllowOAuthModel("gpt-5.3-codex-spark")).toBe(true)
  })

  test("completely unrelated ids are rejected", () => {
    for (const id of ["claude-3.5-sonnet", "gemini-2.5-pro", "gpt-4o", "gpt-4-turbo", ""]) {
      expect(shouldAllowOAuthModel(id)).toBe(false)
    }
  })
})

describe("disallowedOAuthModelKeys — what the loader actually deletes", () => {
  const model = (apiId?: string) => (apiId === undefined ? {} : { api: { id: apiId } })

  test("a config alias of a supported model is kept, keyed by its alias", () => {
    // The bug this guards: the loader used to match the MAP KEY. Config models
    // are folded into the provider database before auth loaders run, so
    // `provider.openai.models.fast-spark.id = "gpt-5.3-codex-spark"` arrives
    // keyed `fast-spark` with the real id on `api.id`. Matching the key deleted
    // a model the backend serves.
    const models = {
      "fast-spark": model("gpt-5.3-codex-spark"),
      "my-flagship": model("gpt-5.6-sol"),
    }
    expect(disallowedOAuthModelKeys(models)).toEqual([])
  })

  test("an alias of an unsupported model is still deleted", () => {
    // The alias must not become a way to smuggle a rejected id past the filter
    // — it is the api.id that reaches the backend, so that is what is judged.
    const models = {
      "totally-fine-name": model("gpt-5.6"),
      "gpt-5.6-sol": model("gpt-5.6-sol"),
    }
    expect(disallowedOAuthModelKeys(models)).toEqual(["totally-fine-name"])
  })

  test("api.id wins over the key in both directions", () => {
    const models = {
      // key allowed, api.id rejected -> delete
      "gpt-5.6-sol": model("gpt-5.6"),
      // key rejected, api.id allowed -> keep
      "gpt-5.6": model("gpt-5.6-sol"),
    }
    expect(disallowedOAuthModelKeys(models)).toEqual(["gpt-5.6-sol"])
  })

  test("falls back to the key when api.id is absent", () => {
    // The database backfills api.id only AFTER this hook runs, so the field can
    // be missing despite the type. Behaviour must degrade to the old key match,
    // not throw and not allow everything through.
    const models = {
      "gpt-5.6-sol": model(undefined),
      "gpt-5.6": model(undefined),
      // gpt-5.4 is retired from the subscription picker, so it is deleted too.
      "gpt-5.4": { api: {} },
      "gpt-5.2": { api: {} },
    }
    expect(disallowedOAuthModelKeys(models).sort()).toEqual(["gpt-5.2", "gpt-5.4", "gpt-5.6"])
  })

  test("the catalog set resolves identically whether matched by key or api.id", () => {
    // Every models.dev catalog entry has key === api.id (checked against
    // https://models.dev/api.json), so this change is behaviour-preserving for
    // catalog models — only aliases move. Guards against a future refactor
    // quietly changing which flagship models the picker offers.
    const catalog = Object.fromEntries([...VERIFIED_ACCEPTED, ...VERIFIED_REJECTED].map((id) => [id, model(id)]))
    expect(disallowedOAuthModelKeys(catalog).sort()).toEqual([...VERIFIED_REJECTED].sort())
  })

  test("an empty model map yields nothing to delete", () => {
    expect(disallowedOAuthModelKeys({})).toEqual([])
  })

  test("older codex ids from the bundled snapshot are dropped, deliberately", () => {
    // These five are absent from live models.dev but ARE in the bundled
    // provider/models-snapshot.ts, which is the catalog on a cold cache
    // (ModelsDev.Data resolves disk cache -> snapshot -> fetch). So they do
    // reach this filter and the removed includes("codex") rule used to offer
    // them. None was probed; they are excluded fail-closed.
    //
    // This test pins that as a DECISION, not a discovery. If any of them is
    // ever probed, move it into VERIFIED_ACCEPTED or VERIFIED_REJECTED and
    // delete it from here.
    const unprobedSnapshotCodexIds = [
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2-codex",
    ]
    for (const id of unprobedSnapshotCodexIds) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(false)
      expect(VERIFIED_ACCEPTED).not.toContain(id)
      expect(VERIFIED_REJECTED).not.toContain(id)
    }
    const models = Object.fromEntries(unprobedSnapshotCodexIds.map((id) => [id, model(id)]))
    expect(disallowedOAuthModelKeys(models).sort()).toEqual([...unprobedSnapshotCodexIds].sort())
  })
})

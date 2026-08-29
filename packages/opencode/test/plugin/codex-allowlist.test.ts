// Regression coverage for the ChatGPT-subscription (OAuth) model filter
// in packages/opencode/src/plugin/codex.ts — the ACTIVE plugin wired
// via plugin/index.ts.
//
// The allowlist is a verified truth table, not a guess. Every id asserted
// below was probed against the live backend
// (POST https://chatgpt.com/backend-api/codex/responses) on a ChatGPT Pro
// credential, using our own `originator: altimate` client identity over plain
// HTTP. Accepted ids returned HTTP 200; rejected ids returned
// 400 {"detail":"The '<id>' model is not supported when using Codex with a
// ChatGPT account."}
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
import { OAUTH_ALLOWED_MODELS, shouldAllowOAuthModel } from "../../src/plugin/codex"

/** Verified HTTP 200 on a ChatGPT Pro subscription credential. */
const VERIFIED_ACCEPTED = [
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]

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

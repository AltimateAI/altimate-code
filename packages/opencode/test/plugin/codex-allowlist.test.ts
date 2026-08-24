// Regression coverage for the ChatGPT-subscription (OAuth) model filter
// in packages/opencode/src/plugin/codex.ts — the ACTIVE plugin wired
// via plugin/index.ts.
//
// Filed as issue #1132: GPT 5.6 was released but the allowlist stopped
// at 5.4, so users on ChatGPT Pro/Plus (Codex tier) couldn't pick it in
// the model picker even though the underlying models.dev catalog had it.
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

describe("OAUTH_ALLOWED_MODELS — subscription model picker regression barrier", () => {
  test("issue #1132: gpt-5.6 is present", () => {
    // If this fails again, someone dropped gpt-5.6 from the non-codex
    // allowlist without moving forward to a newer generation — rejecting
    // a shipped OpenAI model users have subscription access to.
    expect(OAUTH_ALLOWED_MODELS.has("gpt-5.6")).toBe(true)
  })

  test("gpt-5.5 is present (added alongside 5.6 for parity)", () => {
    expect(OAUTH_ALLOWED_MODELS.has("gpt-5.5")).toBe(true)
  })

  test("prior non-codex generations stay allowlisted (no accidental removal)", () => {
    for (const id of ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"]) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(true)
    }
  })

  test("codex-tagged variants are NOT in the non-codex set (they're auto-allowed instead)", () => {
    // The non-codex set is deliberately minimal — every codex-tagged id
    // is auto-allowed by shouldAllowOAuthModel's `includes("codex")` check
    // below, so listing them here would be redundant + a maintenance trap.
    for (const id of ["gpt-5.1-codex", "gpt-5.2-codex", "gpt-5.3-codex"]) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(false)
    }
  })

  test("allowlist does NOT include API-tier-only variants (defensive)", () => {
    // Pro / luna / sol / terra variants ship on models.dev but aren't
    // confirmed available on the ChatGPT-subscription (Codex) tier —
    // showing them in the picker would surface a request-time failure.
    // If OpenAI extends subscription coverage to them, add them here
    // deliberately (with a link to the announcement).
    for (const id of [
      "gpt-5.4-pro",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(false)
    }
  })

  test("allowlist size never regresses below current baseline", () => {
    // Trip-wire: if someone truncates the allowlist by mistake (or in
    // a bad rebase), the count drops and this test catches it before
    // shipping. Bump when a real new addition lands.
    expect(OAUTH_ALLOWED_MODELS.size).toBeGreaterThanOrEqual(5)
  })
})

describe("shouldAllowOAuthModel — behavior of the filter itself", () => {
  // Behavior-level coverage: even if a refactor stops passing
  // OAUTH_ALLOWED_MODELS through, the filter function is what the
  // loader actually calls, so this catches breakage the constant-only
  // tests above would miss. (cubic P3 catch.)

  test("allowlist members pass (spot-check each generation)", () => {
    for (const id of ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6"]) {
      expect(shouldAllowOAuthModel(id)).toBe(true)
    }
  })

  test("codex-tagged ids pass regardless of exact allowlist membership", () => {
    // Any id containing "codex" auto-passes — covers gpt-5.1-codex,
    // gpt-5.3-codex-spark, plus any future codex variant OpenAI ships.
    for (const id of [
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.3-codex-xhigh",
      "codex-hypothetical-future-name",
    ]) {
      expect(shouldAllowOAuthModel(id)).toBe(true)
    }
  })

  test("API-tier-only variants are rejected (the whole point of the filter)", () => {
    // These are the models the previous parseFloat > 5.4 fallback in
    // plugin/openai/codex.ts was incorrectly admitting; the shared
    // filter must reject them so the picker stays honest about what
    // the subscription actually accepts.
    for (const id of [
      "gpt-5.4-pro",
      "gpt-5.4-nano",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]) {
      expect(shouldAllowOAuthModel(id)).toBe(false)
    }
  })

  test("completely unrelated ids are rejected", () => {
    for (const id of [
      "claude-3.5-sonnet",
      "gemini-2.5-pro",
      "gpt-4o",
      "gpt-4-turbo",
      "",
    ]) {
      expect(shouldAllowOAuthModel(id)).toBe(false)
    }
  })
})

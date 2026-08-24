// Regression coverage for the ChatGPT-subscription (OAuth) allowlist in
// packages/opencode/src/plugin/codex.ts.
//
// Filed as issue #1132: GPT 5.6 was released but the allowlist stopped
// at 5.4, so users on ChatGPT Pro/Plus (Codex tier) couldn't pick it in
// the model picker even though the underlying models.dev catalog had it.
//
// Sibling test file test/plugin/codex.test.ts covers `plugin/openai/codex.ts`
// (a parallel implementation currently NOT wired into plugin/index.ts).
// This file covers the ACTIVE plugin at `plugin/codex.ts`.
import { describe, expect, test } from "bun:test"
import { OAUTH_ALLOWED_MODELS } from "../../src/plugin/codex"

describe("codex OAUTH_ALLOWED_MODELS — subscription model picker regression barrier", () => {
  test("issue #1132: gpt-5.6 is present", () => {
    // If this test starts failing again, someone dropped gpt-5.6 from
    // the allowlist without moving forward to a newer generation —
    // rejecting a shipped OpenAI model users have subscription access to.
    expect(OAUTH_ALLOWED_MODELS.has("gpt-5.6")).toBe(true)
  })

  test("gpt-5.5 is present (added alongside 5.6 for parity)", () => {
    expect(OAUTH_ALLOWED_MODELS.has("gpt-5.5")).toBe(true)
  })

  test("prior generations stay allowlisted (no accidental removal)", () => {
    for (const id of [
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]) {
      expect(OAUTH_ALLOWED_MODELS.has(id)).toBe(true)
    }
  })

  test("allowlist does NOT include API-tier-only variants (defensive)", () => {
    // Pro / luna / sol / terra variants ship on models.dev but are not
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
    // A trip-wire: if someone truncates the allowlist by mistake (or in
    // a bad rebase), the count drops and this test catches it before
    // shipping. Bump when a real new addition lands.
    expect(OAUTH_ALLOWED_MODELS.size).toBeGreaterThanOrEqual(10)
  })
})

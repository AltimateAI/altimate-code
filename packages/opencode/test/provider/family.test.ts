import { describe, expect, test } from "bun:test"
import { familyVendor } from "../../src/provider/family"

// Locks the contract for the shared family→vendor classifier introduced for
// #888 J1. The model registry uses *specific* family values like
// `claude-sonnet`, `claude-haiku`, `gemini-pro`, `gemini-flash`, etc., not the
// coarse `anthropic`/`gemini`/`openai` literals — so exact-match logic in the
// previous version silently fell through to PROMPT_CODEX on any altimate-
// backend gateway path that exposed a Claude model.
describe("familyVendor", () => {
  test.each([
    // Coarse vendor literals.
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["openai-compatible", "openai"],
    ["gemini", "gemini"],
    ["claude", "anthropic"],
    ["gpt", "openai"],
    // Specific names that the model registry actually emits.
    ["claude-sonnet", "anthropic"],
    ["claude-haiku", "anthropic"],
    ["claude-opus", "anthropic"],
    ["gemini-pro", "gemini"],
    ["gemini-flash", "gemini"],
    ["gemini-flash-lite", "gemini"],
    ["gpt-codex", "openai"],
    ["gpt-codex-mini", "openai"],
    // Case-insensitivity.
    ["ANTHROPIC", "anthropic"],
    ["Claude-Sonnet", "anthropic"],
    ["GEMINI-PRO", "gemini"],
    ["GPT", "openai"],
  ] as const)("classifies %p as %p", (family, expected) => {
    expect(familyVendor(family)).toBe(expected)
  })

  test.each([undefined, "", "unknown-future-family", "kimi", "qwen", "llama"])("returns undefined for %p", (family) => {
    expect(familyVendor(family)).toBeUndefined()
  })
})

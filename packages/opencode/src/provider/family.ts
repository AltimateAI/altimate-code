// altimate_change start — shared vendor classifier for `model.family` values.
//
// `model.family` is a free-form string in the Model schema; the model registry
// (`packages/opencode/test/tool/fixtures/models-api.json`) uses *specific*
// values like `claude-sonnet`, `claude-haiku`, `gemini-pro`, `gemini-flash`,
// `gpt-codex`, etc. — never the coarse `anthropic`/`gemini`/`openai` literals.
// Routing code that exact-matches against the coarse names silently misses
// real models, recreating the GH #887 misrouting class on any altimate-backend
// gateway path that exposes Claude or Gemini models. Use this helper to map a
// specific family value to its vendor bucket.
//
// Reviewer-driven addition (PR #888 review thread, J1 from the multi-LLM
// panel). Keep this the single source of truth so the prompt-routing and the
// hoist-decision both interpret family the same way.

export type Vendor = "anthropic" | "gemini" | "openai"

export function familyVendor(family: string | undefined): Vendor | undefined {
  if (!family) return undefined
  const f = family.toLowerCase()
  if (f === "anthropic" || f === "claude" || f.startsWith("claude-")) return "anthropic"
  if (f === "gemini" || f.startsWith("gemini-")) return "gemini"
  if (f === "openai" || f === "openai-compatible" || f === "gpt" || f.startsWith("gpt-")) return "openai"
  return undefined
}
// altimate_change end

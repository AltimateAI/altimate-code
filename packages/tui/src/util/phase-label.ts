// altimate_change start (AI-7519) — phase → user-facing label lookup.
//
// The backend publishes `session.phase` events keyed by internal span names
// (e.g. `bootstrap.resolve-tools`). This helper maps them to short honest
// labels the TUI renders next to the busy spinner during the pre-first-visible
// window (target: <10s to first visible response).
//
// Unknown phases fall back to "Thinking..." — a safe default that matches what
// Cursor / Claude Code / Codex CLI show. Add entries as new spans get wrapped
// with SessionPrompt.traceSpan.

const PHASE_LABELS: Record<string, string> = {
  // bootstrap sub-steps that fire once at session start
  "bootstrap.session-get": "Loading session...",
  "bootstrap.config-get": "Loading config...",
  "bootstrap.fingerprint-detect": "Detecting project shape...",
  "bootstrap.telemetry-init": "Preparing telemetry...",
  // per-turn (also runs on bootstrap step===1)
  "bootstrap.resolve-tools": "Discovering tools...",
}

export function phaseLabel(phase: string | undefined): string {
  if (!phase) return "Thinking..."
  return PHASE_LABELS[phase] ?? "Thinking..."
}
// altimate_change end

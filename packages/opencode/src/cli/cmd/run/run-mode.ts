// `altimate-code run` implies run mode. External drivers (CI, headless
// harnesses) invoke `run` without exporting ALTIMATE_RUN_MODE, which used to
// leave run-mode-only mechanisms (DONE-termination gate, starvation-breaker
// directives, doom-loop escalation ladder) disarmed. The run command applies
// this default at handler startup; interactive TUI/serve entrypoints never
// call it, so their behavior is unchanged.
//
// Opt-out: any explicit non-blank value is preserved — exporting
// ALTIMATE_RUN_MODE=0 (or "false") before launching `run` disables run mode.
// A blank/whitespace value is treated as unset, mirroring the
// ALTIMATE_NON_INTERACTIVE convention, so a stray `export ALTIMATE_RUN_MODE=`
// cannot silently disable termination.
export function applyRunModeDefault(env: Record<string, string | undefined>, opts: { attach?: boolean } = {}) {
  // --attach: the agent runs on the remote (possibly interactive) server, so
  // the local env var would be a no-op locally and must not leak run-mode
  // semantics into other tools that consult it.
  if (opts.attach) return
  if (env["ALTIMATE_RUN_MODE"]?.trim()) return
  env["ALTIMATE_RUN_MODE"] = "1"
}

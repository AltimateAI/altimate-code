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
export function applyRunModeDefault(
  env: Record<string, string | undefined>,
  opts: { attach?: boolean; resumed?: boolean } = {},
) {
  // --attach: the agent runs on the remote (possibly interactive) server, so
  // the local env var would be a no-op locally and must not leak run-mode
  // semantics into other tools that consult it.
  if (opts.attach) return
  // A resumed run (`--continue`, `--session`, or `--fork`) starts from a
  // session that already holds earlier invocations' messages. Run mode
  // otherwise pins the session's FIRST user message as the authoritative task,
  // which for a resumed session is a previous — possibly completed or
  // conflicting — request rather than the one this invocation supplied. The
  // marker lets the pin selector fall back to the latest substantive
  // instruction for exactly these sessions. Set before the run-mode early
  // return so an explicitly exported ALTIMATE_RUN_MODE=1 gets it too.
  if (opts.resumed) env["ALTIMATE_RUN_RESUMED"] = "1"
  if (env["ALTIMATE_RUN_MODE"]?.trim()) return
  env["ALTIMATE_RUN_MODE"] = "1"
}

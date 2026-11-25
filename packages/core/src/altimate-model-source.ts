// altimate_change start — the single definition of a config-backed model source label.
//
// Model selection errors name where the model came from ("config (model)", 'agent "x" config (model)',
// "CLI --model", ...). Server, CLI and TUI all decide from that label whether to point at the config
// files, so the rule lives here once.
export const CONFIG_MODEL_SOURCE_SUFFIX = "config (model)"

/** Whether a source label names a config setting the user can correct. */
export function isConfigModelSource(source: string | undefined) {
  return source?.endsWith(CONFIG_MODEL_SOURCE_SUFFIX) === true
}
// altimate_change end

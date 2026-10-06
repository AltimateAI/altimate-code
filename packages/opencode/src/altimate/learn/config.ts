// altimate_change - new file

interface LearnConfig {
  enabled?: boolean
  capture?: boolean
  auto_reflect?: boolean
  model?: string
}

function booleanFlag(value: string | undefined): boolean | undefined {
  if (value === "1" || value?.toLowerCase() === "true") return true
  if (value === "0" || value?.toLowerCase() === "false") return false
  return undefined
}

/** The global switch defaults on; env overrides config in both directions. */
export function learnEnabled(cfg?: { enabled?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return booleanFlag(env["ALTIMATE_LEARN"]) ?? cfg?.enabled ?? true
}

/** Capture remains opt-in and cannot override the global learning switch. */
export function captureEnabled(cfg?: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return learnEnabled(cfg, env) && (booleanFlag(env["ALTIMATE_LEARN_CAPTURE"]) ?? cfg?.capture === true)
}

/** Auto-reflect needs capture: without signals there is nothing to reflect on. */
export function autoReflectEnabled(cfg?: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return captureEnabled(cfg, env) && (booleanFlag(env["ALTIMATE_LEARN_AUTO"]) ?? cfg?.auto_reflect === true)
}

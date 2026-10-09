// altimate_change - new file

interface LearnConfig {
  enabled?: boolean
  capture?: boolean
  auto_reflect?: boolean
  auto_promote?: boolean
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

/** Auto-promote needs automatic reflection: it only promotes candidates that reflection just staged. */
export function autoPromoteEnabled(cfg?: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return autoReflectEnabled(cfg, env) && (booleanFlag(env["ALTIMATE_LEARN_AUTO_PROMOTE"]) ?? cfg?.auto_promote === true)
}

export interface AutoPromoteLimits {
  auto_promote_max_changes: number
  auto_promote_daily: number
}

export const DEFAULT_AUTO_PROMOTE_LIMITS: Readonly<AutoPromoteLimits> = {
  auto_promote_max_changes: 3,
  auto_promote_daily: 5,
}

export function resolveAutoPromoteLimits(
  config: Partial<AutoPromoteLimits> = {},
  env: NodeJS.ProcessEnv = process.env,
): AutoPromoteLimits {
  const limits = { ...DEFAULT_AUTO_PROMOTE_LIMITS }
  for (const key of Object.keys(limits) as (keyof AutoPromoteLimits)[]) {
    const variable = `ALTIMATE_LEARN_${key.toUpperCase()}`
    const override = env[variable]?.trim()
    const value = override ? Number(override) : (config[key] ?? limits[key])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`learn.${key} / ${variable} must be a nonnegative safe integer.`)
    limits[key] = value
  }
  return limits
}

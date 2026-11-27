// altimate_change - new file: what the AI review lane does, resolved once per review
//
// Each switch is set by, in order: its env variable (`1`/`true`/`on`/`yes` on,
// `0`/`false`/`off`/`no` off; any other value is ignored with a warning), the
// `ai:` object in `.altimate/review.yml` (read from the base branch), then the
// product default. `reviewPullRequest` resolves the switches and passes them
// down; code called without them (direct callers, unit tests) reads only the
// env variable, as before, so an unset variable means off there.
import type { ReviewConfig } from "./config"

export type AiSwitchName = "coverage" | "contextCard" | "focused" | "otherFiles" | "pythonFiles" | "verify"

export type AiSwitches = Record<AiSwitchName, boolean>

/** The env variable that overrides each switch. */
export const AI_SWITCH_ENV: Record<AiSwitchName, string> = {
  coverage: "ALTIMATE_REVIEW_AI_COVERAGE",
  contextCard: "ALTIMATE_REVIEW_AI_CONTEXT_CARD",
  focused: "ALTIMATE_REVIEW_AI_FOCUSED",
  otherFiles: "ALTIMATE_REVIEW_AI_OTHER_FILES",
  pythonFiles: "ALTIMATE_REVIEW_AI_PYTHON_FILES",
  verify: "ALTIMATE_REVIEW_AI_VERIFY",
}

/**
 * Product defaults when neither env nor config sets a switch: the configuration measured
 * together (wider input, related files batched, context cards, the verifier). Each one is
 * opt-out with `ai: { <switch>: false }` or its env variable set to `0`.
 */
export const AI_SWITCH_DEFAULTS: AiSwitches = {
  coverage: true,
  contextCard: true,
  focused: true,
  otherFiles: true,
  pythonFiles: true,
  verify: true,
}

type Env = Record<string, string | undefined>

const ENV_TRUE = new Set(["1", "true", "on", "yes"])
const ENV_FALSE = new Set(["0", "false", "off", "no"])

/** The env override for a switch: true for `1`/`true`/`on`/`yes`, false for `0`/`false`/`off`/`no`
 *  (case-insensitive), undefined otherwise. */
export function envSwitch(name: AiSwitchName, env: Env = process.env): boolean | undefined {
  const v = env[AI_SWITCH_ENV[name]]?.trim().toLowerCase()
  if (v === undefined) return undefined
  return ENV_TRUE.has(v) ? true : ENV_FALSE.has(v) ? false : undefined
}

/** Every switch for one review: env, then the `ai:` config object, then the default. */
export function resolveAiSwitches(cfg: Pick<ReviewConfig, "ai">, env: Env = process.env): AiSwitches {
  const configured = typeof cfg.ai === "object" ? cfg.ai : {}
  const out = { ...AI_SWITCH_DEFAULTS }
  for (const name of Object.keys(AI_SWITCH_ENV) as AiSwitchName[]) {
    const fromEnv = envSwitch(name, env)
    const raw = env[AI_SWITCH_ENV[name]]
    if (fromEnv === undefined && raw?.trim())
      process.stderr.write(`⚠️  ignoring ${AI_SWITCH_ENV[name]}=${raw}: use 1/0 (or true/false, on/off, yes/no)\n`)
    out[name] = fromEnv ?? configured[name] ?? AI_SWITCH_DEFAULTS[name]
  }
  return out
}

/** A switch from resolved switches when given, else from its env variable alone (unset = off). */
export function switchOn(name: AiSwitchName, switches: Partial<AiSwitches> | undefined, env: Env = process.env): boolean {
  return switches?.[name] ?? envSwitch(name, env) ?? false
}

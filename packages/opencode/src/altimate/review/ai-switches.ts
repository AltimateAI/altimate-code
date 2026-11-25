// altimate_change - new file: what the AI review lane does, resolved once per review
//
// Each switch is set by, in order: its env variable (`1`/`true`/`on`/`yes` on,
// `0`/`false`/`off`/`no` off; any other value is ignored with a warning), the
// `ai:` object in `.altimate/review.yml` (read from the base branch), then the
// product default. `reviewPullRequest` resolves the switches and passes them
// down; code called without them (direct callers, unit tests) reads only the
// env variable, as before, so an unset variable means off there.
import type { ReviewConfig } from "./config"

export type AiSwitchName =
  | "coverage"
  | "contextCard"
  | "focused"
  | "otherFiles"
  | "pythonFiles"
  | "verify"
  | "conventions"
  | "rulesOff"
  | "verifyRules"

export type AiSwitches = Record<AiSwitchName, boolean>

/** The env variable that overrides each switch. */
export const AI_SWITCH_ENV: Record<AiSwitchName, string> = {
  coverage: "ALTIMATE_REVIEW_AI_COVERAGE",
  contextCard: "ALTIMATE_REVIEW_AI_CONTEXT_CARD",
  focused: "ALTIMATE_REVIEW_AI_FOCUSED",
  otherFiles: "ALTIMATE_REVIEW_AI_OTHER_FILES",
  pythonFiles: "ALTIMATE_REVIEW_AI_PYTHON_FILES",
  verify: "ALTIMATE_REVIEW_AI_VERIFY",
  conventions: "ALTIMATE_REVIEW_CONVENTIONS",
  rulesOff: "ALTIMATE_REVIEW_RULES_OFF",
  verifyRules: "ALTIMATE_REVIEW_AI_VERIFY_RULES",
}

/**
 * Product defaults when neither env nor config sets a switch: the configuration measured
 * together (wider input, related files batched, context cards, the verifier, the team
 * conventions). Each one is opt-out with `ai: { <switch>: false }` or its env variable set to `0`.
 */
export const AI_SWITCH_DEFAULTS: AiSwitches = {
  coverage: true,
  contextCard: true,
  focused: true,
  otherFiles: true,
  pythonFiles: true,
  verify: true,
  conventions: true,
  rulesOff: true,
  verifyRules: true,
}

type Env = Record<string, string | undefined>

const ENV_TRUE = new Set(["1", "true", "on", "yes"])
const ENV_FALSE = new Set(["0", "false", "off", "no"])
/** Extra env spellings: `ALTIMATE_REVIEW_AI_VERIFY_RULES=drop_refuted|off`. */
const ENV_ON: Partial<Record<AiSwitchName, string>> = { verifyRules: "drop_refuted" }
const ENV_OFF: Partial<Record<AiSwitchName, string>> = { verifyRules: "off" }

/** The env override for a switch: true for `1`/`true`/`on`/`yes`, false for `0`/`false`/`off`/`no`
 *  (case-insensitive) or a switch's own spelling, undefined otherwise. */
export function envSwitch(name: AiSwitchName, env: Env = process.env): boolean | undefined {
  const raw = env[AI_SWITCH_ENV[name]]
  // `ALTIMATE_REVIEW_RULES_OFF=<file>` names a replacement list: the switch is on.
  if (name === "rulesOff" && raw && raw !== "0") return true
  const v = raw?.trim().toLowerCase()
  if (v !== undefined && v === ENV_ON[name]) return true
  if (v !== undefined && v === ENV_OFF[name]) return false
  return envBool(raw)
}

/** An env value as a boolean: `1`/`true`/`on`/`yes` true, `0`/`false`/`off`/`no` false (trimmed,
 *  any case), undefined for anything else or unset. */
export function envBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase()
  if (v === undefined) return undefined
  return ENV_TRUE.has(v) ? true : ENV_FALSE.has(v) ? false : undefined
}

const WARNED = new Set<string>()

/** Every switch for one review: env, then the `ai:` config object, then the default. */
export function resolveAiSwitches(
  cfg: Pick<ReviewConfig, "ai">,
  env: Env = process.env,
  opts: { warn?: boolean } = {},
): AiSwitches {
  const configured = typeof cfg.ai === "object" ? cfg.ai : {}
  const out = { ...AI_SWITCH_DEFAULTS }
  for (const name of Object.keys(AI_SWITCH_ENV) as AiSwitchName[]) {
    const fromEnv = envSwitch(name, env)
    const raw = env[AI_SWITCH_ENV[name]]
    // Once per value per process: `--all-projects` resolves the switches for every project.
    const warning = `${AI_SWITCH_ENV[name]}=${raw}`
    // No warning for a lane that will not run (`warn: false`).
    if (opts.warn !== false && fromEnv === undefined && raw?.trim() && !WARNED.has(warning)) {
      WARNED.add(warning)
      process.stderr.write(`⚠️  ignoring ${AI_SWITCH_ENV[name]}=${raw}: use 1/0 (or true/false, on/off, yes/no)\n`)
    }
    out[name] = fromEnv ?? configured[name] ?? AI_SWITCH_DEFAULTS[name]
  }
  return out
}

/** A switch from resolved switches when given, else from its env variable alone (unset = off). */
export function switchOn(name: AiSwitchName, switches: Partial<AiSwitches> | undefined, env: Env = process.env): boolean {
  return switches?.[name] ?? envSwitch(name, env) ?? false
}

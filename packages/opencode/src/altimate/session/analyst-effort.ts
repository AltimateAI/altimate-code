import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

/** Reasoning effort the analyst requests when neither the user nor the agent config chooses one. */
export const ANALYST_DEFAULT_EFFORT = "high"
/** Overrides the analyst default effort (low, medium, high, xhigh, max); "off" sends no effort option. */
export const ANALYST_EFFORT_ENV = "ALTIMATE_ANALYST_EFFORT"

const EFFORT_KEYS = ["effort", "reasoningEffort", "thinking", "thinkingConfig", "reasoningConfig", "reasoning"]

const DISABLED = new Set(["", "off", "none", "default"])

function adaptive(options: Record<string, any> | undefined): boolean {
  return [options?.thinking, options?.reasoningConfig, options?.modelParams?.thinking].some(
    (value) => value?.type === "adaptive",
  )
}

/**
 * Default request options that raise the analyst's reasoning effort on adaptive-thinking models.
 * Without them the provider applies its own default effort, which can be lower than the analyst needs.
 * An explicit variant (from the request or the agent's `variant` config), or `effort`/`thinking` in the
 * agent's or model's `options`, takes precedence; the run-budget effort downgrade still applies afterwards.
 */
export function analystEffortOptions(input: {
  agent: { name: string; options?: Record<string, any> }
  model: Provider.Model
  variant?: string
  small?: boolean
}): Record<string, any> {
  if (input.small || input.variant || input.agent.name !== "analyst") return {}
  // llm.ts merges this after the model options, so a per-model choice must win here too.
  const configured = [input.agent.options ?? {}, input.model.options ?? {}]
  if (configured.some((options) => EFFORT_KEYS.some((key) => key in options))) return {}
  const effort = (process.env[ANALYST_EFFORT_ENV] ?? ANALYST_DEFAULT_EFFORT).trim().toLowerCase()
  if (DISABLED.has(effort) || !input.model.capabilities.reasoning) return {}
  const options = ProviderTransform.variants(input.model)[effort]
  return adaptive(options) ? options! : {}
}

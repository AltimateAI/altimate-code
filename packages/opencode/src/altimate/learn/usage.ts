// altimate_change - new file
import type { Provider } from "@/provider/provider"
import type { GenerateUsage } from "./reflect"

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  estimatedCost: number
}

export type UsageModel = { cost?: Provider.Model["cost"]; api?: Pick<Provider.Model["api"], "npm"> }

/** Use the same accounting as the session processor, including its SDK compatibility fields. */
export async function accountUsage(model: UsageModel, usage: GenerateUsage, metadata = usage.providerMetadata): Promise<UsageSummary> {
  // Loading the session lazily avoids a cycle through the learning hooks during startup.
  const { Session } = await import("@/session")
  const accounted = Session.getUsage({
    // Session accounting only reads cost metadata and the provider's SDK name.
    model: { ...model, api: model.api ?? { npm: "" } } as Provider.Model,
    usage: {
      // Accounted callbacks retain original counts so import estimates can fill missing values
      // without normalizing Anthropic's cache counters a second time.
      inputTokens: usage.rawUsage?.inputTokens ?? usage.inputTokens,
      outputTokens: usage.rawUsage?.outputTokens ?? usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens,
      // AI SDK v6 reports inputTokens inclusive of cache for Anthropic/Bedrock; the uncached count lets
      // Session.getUsage bill each token class once.
      ...(usage.inputTokenDetails?.noCacheTokens !== undefined
        ? { inputTokenDetails: { noCacheTokens: usage.inputTokenDetails.noCacheTokens } }
        : {}),
    },
    metadata,
  })
  return {
    inputTokens: accounted.tokens.inputTotal,
    outputTokens: accounted.tokens.output,
    estimatedCost: usage.estimatedCost ?? accounted.cost,
  }
}

export function createUsageTracker() {
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }
  const add = (value: GenerateUsage) => {
    usage.inputTokens += value.inputTokens ?? 0
    usage.outputTokens += value.outputTokens ?? 0
    usage.estimatedCost += value.estimatedCost ?? 0
  }
  return { usage, add }
}

export function formatUsage(usage: UsageSummary): string {
  return `Tokens: ${usage.inputTokens} input, ${usage.outputTokens} output. Estimated cost: $${usage.estimatedCost.toFixed(6)}.`
}

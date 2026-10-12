import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"

/** Disabled-thinking SDKs discard reasoning; omit the assistant if that would leave it empty. */
export function budgetMessages(
  messages: ModelMessage[],
  model: Provider.Model,
  options: Record<string, any>,
): ModelMessage[] {
  const disabled = [options.thinking, options.reasoningConfig, options.modelParams?.thinking].some(
    (value) => value?.type === "disabled",
  )
  const anthropic =
    model.api.npm === "@ai-sdk/anthropic" ||
    model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    (model.api.npm === "@ai-sdk/amazon-bedrock" && model.api.id.includes("anthropic")) ||
    (model.api.npm === "@ai-sdk/gateway" && model.api.id.startsWith("anthropic/"))
  if (!disabled && !anthropic) return messages
  const result: ModelMessage[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      result.push(message)
      continue
    }
    const content = message.content.filter((part) => {
      if (part.type !== "reasoning") return true
      if (disabled) return false
      // A soft abort can arrive before the provider signs its reasoning block, even with effort downgrade off.
      const metadata = part.providerOptions?.[model.api.npm === "@ai-sdk/amazon-bedrock" ? "bedrock" : "anthropic"] as
        | Record<string, unknown>
        | undefined
      return metadata?.signature != null || metadata?.redactedData != null
    })
    if (content.length) result.push({ ...message, content })
  }
  return result
}

/** Apply only to this request: configured model/agent variants remain reusable by other runs. */
export function applyBudgetEffort(model: Provider.Model, options: Record<string, any>): Record<string, any> {
  if (!model.capabilities.reasoning) return options

  // Use the provider's supported matrix, not custom variants (which may redefine "low").
  const variants = ProviderTransform.variants(model)
  const lowest = variants.minimal ?? variants.low ?? variants.none ?? Object.values(variants)[0]
  const id = model.api.id.toLowerCase()
  const npm = model.api.npm
  const anthropic =
    npm === "@ai-sdk/anthropic" ||
    npm === "@ai-sdk/google-vertex/anthropic" ||
    (npm === "@ai-sdk/gateway" && id.startsWith("anthropic/"))

  if (anthropic) {
    const result: Record<string, any> = { ...options, ...lowest, thinking: { type: "disabled" } }
    // Older Claude models use a token budget instead of supporting an effort field.
    if (!lowest?.effort) delete result.effort
    return result
  }

  if (npm === "@ai-sdk/amazon-bedrock" && id.includes("anthropic")) {
    const effort = lowest?.reasoningConfig?.maxReasoningEffort
    const additional = { ...options.additionalModelRequestFields, thinking: { type: "disabled" } }
    if (effort) additional.output_config = { ...additional.output_config, effort }
    else if (additional.output_config) {
      additional.output_config = { ...additional.output_config }
      delete additional.output_config.effort
    }
    // Bedrock's SDK leaves raw additional fields unchanged when reasoningConfig is disabled.
    return {
      ...options,
      reasoningConfig: { type: "disabled", ...(effort ? { maxReasoningEffort: effort } : {}) },
      additionalModelRequestFields: additional,
    }
  }

  if (
    (npm === "@ai-sdk/google" ||
      npm === "@ai-sdk/google-vertex" ||
      (npm === "@ai-sdk/gateway" && id.startsWith("google/"))) &&
    id.includes("2.5")
  ) {
    // https://ai.google.dev/gemini-api/docs/generate-content/thinking: Pro cannot disable thinking.
    return { ...options, thinkingConfig: { thinkingBudget: id.includes("pro") ? 128 : 0 } }
  }

  if (!lowest) return options
  // Mistral's SDK exposes a none/high toggle; the catalog offers only the enabled variant.
  if (npm === "@ai-sdk/mistral") return { ...options, reasoningEffort: "none" }
  // Shallow replacement deliberately drops stale high budgets nested in reasoning/thinking options.
  // SAP wraps its controls alongside unrelated model parameters, which must be preserved.
  if (lowest.modelParams) {
    const modelParams = { ...options.modelParams, ...lowest.modelParams }
    if (id.includes("anthropic")) modelParams.thinking = { type: "disabled" }
    return { ...options, modelParams }
  }
  return { ...options, ...lowest }
}

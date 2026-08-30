import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"
// altimate_change start — output-token clamp needs prompt sizing and a logger
import { Token } from "@/util/token"
import { Log } from "@/util/log"
// altimate_change end

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000
  // altimate_change start — logger for the output-token clamp below
  const log = Log.create({ service: "provider.transform" })
  // altimate_change end
  // altimate_change start — keep OpenAI encrypted reasoning include values consistent across transforms
  const INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"] as const

  export function sanitizeSurrogates(content: string) {
    return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  }
  // altimate_change end

  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/github-copilot":
        return "copilot"
      case "@ai-sdk/azure":
        return "azure"
      case "@ai-sdk/openai":
        return "openai"
      // altimate_change start — Bedrock Mantle and Cloudflare gateway expose OpenAI-compatible option namespaces
      case "@ai-sdk/amazon-bedrock/mantle":
        return "openai"
      // altimate_change end
      case "@ai-sdk/amazon-bedrock":
        return "bedrock"
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/google-vertex":
        return "vertex"
      case "@ai-sdk/google":
        return "google"
      case "@ai-sdk/gateway":
        return "gateway"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
      // altimate_change start — ai-gateway-provider wraps @ai-sdk/openai-compatible
      case "ai-gateway-provider":
        return "openaiCompatible"
      // altimate_change end
    }
    return undefined
  }

  function normalizeMessages(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
  ): ModelMessage[] {
    // altimate_change start — replace lone UTF-16 surrogates before provider serialization
    const sanitizeToolResultOutput = (content: any) => {
      if (content.output?.type === "text" || content.output?.type === "error-text") {
        content.output.value = sanitizeSurrogates(content.output.value)
      }
      if (content.output?.type === "content") {
        content.output.value = content.output.value.map((item: any) => {
          if (item.type === "text") item.text = sanitizeSurrogates(item.text)
          return item
        })
      }
      return content
    }

    msgs = msgs.map((msg) => {
      switch (msg.role) {
        case "tool":
          if (!Array.isArray(msg.content)) return msg
          msg.content = msg.content.map((content: any) =>
            content.type === "tool-result" ? sanitizeToolResultOutput(content) : content,
          )
          return msg

        case "system":
          msg.content = sanitizeSurrogates(msg.content)
          return msg

        case "user":
          if (typeof msg.content === "string") {
            msg.content = sanitizeSurrogates(msg.content)
          } else {
            msg.content = msg.content.map((content: any) => {
              if (content.type === "text") content.text = sanitizeSurrogates(content.text)
              return content
            })
          }
          return msg

        case "assistant":
          if (typeof msg.content === "string") {
            msg.content = sanitizeSurrogates(msg.content)
          } else {
            msg.content = msg.content.map((content: any) => {
              if (content.type === "text" || content.type === "reasoning") {
                content.text = sanitizeSurrogates(content.text)
              }
              if (content.type === "tool-result") return sanitizeToolResultOutput(content)
              return content
            })
          }
          return msg
      }
    })
    // altimate_change end

    // Anthropic rejects messages with empty content - filter out empty string messages
    // and remove empty text/reasoning parts from array content
    if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text") {
              return part.text !== ""
            }
            // altimate_change start — preserve signed empty reasoning blocks returned by Anthropic/Bedrock
            if (part.type === "reasoning") {
              const providerKey = model.api.npm === "@ai-sdk/amazon-bedrock" ? "bedrock" : "anthropic"
              const opts = (part.providerOptions as any)?.[providerKey]
              return part.text.trim().length > 0 || opts?.signature != null || opts?.redactedData != null
            }
            // altimate_change end
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    if (model.api.id.includes("claude")) {
      const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part) => {
              if (part.type === "tool-call" || part.type === "tool-result") {
                return { ...part, toolCallId: scrub(part.toolCallId) }
              }
              return part
            }),
          }
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part) => {
              if (part.type === "tool-result") {
                return { ...part, toolCallId: scrub(part.toolCallId) }
              }
              return part
            }),
          }
        }
        return msg
      })
    }
    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      // altimate_change start — upstream_fix: use locale-safe Devstral model detection
      model.api.id.toLowerCase().includes("devstral")
      // altimate_change end
    ) {
      const scrub = (id: string) => {
        return id
          .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
          .substring(0, 9) // Take first 9 characters
          .padEnd(9, "0") // Pad with zeros if less than 9 characters
      }
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          })
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          })
        }
        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (
      typeof model.capabilities.interleaved === "object" &&
      model.capabilities.interleaved.field &&
      // altimate_change start — OpenRouter handles interleaved reasoning internally
      model.api.npm !== "@openrouter/ai-sdk-provider"
      // altimate_change end
    ) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // altimate_change start — always replay the interleaved field, even when the provider returned an empty string
          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...(msg.providerOptions as any)?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
          // altimate_change end
        }

        return msg
      })
    }

    return msgs
  }

  function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
    const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "default" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
      copilot: {
        copilot_cache_control: { type: "ephemeral" },
      },
      // altimate_change start — preserve Alibaba cache-control option on Anthropic-compatible routes
      alibaba: {
        cacheControl: { type: "ephemeral" },
      },
      // altimate_change end
    }

    for (const msg of unique([...system, ...final])) {
      const useMessageLevelOptions =
        model.providerID === "anthropic" ||
        model.providerID.includes("bedrock") ||
        model.api.npm === "@ai-sdk/amazon-bedrock"
      const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        // altimate_change start — guard against v3-only tool-approval-* parts; runtime check, no v2 type union match
        const lastType = (lastContent as { type?: string } | undefined)?.type
        if (
          lastContent &&
          typeof lastContent === "object" &&
          lastType !== "tool-approval-request" &&
          lastType !== "tool-approval-response"
        ) {
          const part = lastContent as { providerOptions?: Record<string, any> }
          part.providerOptions = mergeDeep(part.providerOptions ?? {}, providerOptions)
          continue
        }
        // altimate_change end
      }

      msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
    }

    return msgs
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) return part
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  // altimate_change start — shared providerOptions transform used before request signing
  function mapProviderOptions(
    msgs: ModelMessage[],
    transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
  ) {
    return msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: transform(msg.providerOptions),
        content: msg.content.map((part) => {
          const partType = (part as { type?: string }).type
          if (partType === "tool-approval-request" || partType === "tool-approval-response") return part
          return { ...part, providerOptions: transform((part as { providerOptions?: Record<string, any> }).providerOptions) }
        }),
      } as typeof msg
    })
  }
  // altimate_change end

  export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)
    if (
      (model.providerID === "anthropic" ||
        // altimate_change start — altimate-specific Anthropic provider IDs
        model.providerID === "google-vertex-anthropic" ||
        model.providerID === "altimate-backend" ||
        // altimate_change end
        model.api.id.includes("anthropic") ||
        model.api.id.includes("claude") ||
        model.id.includes("anthropic") ||
        model.id.includes("claude") ||
        model.api.npm === "@ai-sdk/anthropic" ||
        // altimate_change start — Alibaba Anthropic-compatible cache-control namespace
        model.api.npm === "@ai-sdk/alibaba"
        // altimate_change end
      ) &&
      model.api.npm !== "@ai-sdk/gateway"
    ) {
      msgs = applyCaching(msgs, model)
    }

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID) {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = mapProviderOptions(msgs, remap)
    }

    // altimate_change start — strip Responses item IDs before serialization when store=false
    if (
      options.store !== true &&
      key &&
      ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"].includes(model.api.npm)
    ) {
      msgs = mapProviderOptions(msgs, (options) => {
        if (!options?.[key] || !("itemId" in options[key])) return options
        const metadata = { ...options[key] }
        delete metadata.itemId
        return { ...options, [key]: metadata }
      })
    }
    // altimate_change end

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    // altimate_change start — Cohere North mini code requires temperature 1
    if (id.includes("north-mini-code")) return 1.0
    // altimate_change end
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
      if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
        return 1.0
      }
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

  // altimate_change start — restored provider-specific reasoning variant matrix from v1.17.9 upstream/fork tests
  const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
  const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
  const OPENAI_GPT5_PRO_EFFORTS = ["high"]
  const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
  const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
  const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
  const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]
  const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"
  const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"
  const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
  const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
  const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
  const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

  function gpt5Version(apiId: string) {
    return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
  }

  function versionedGpt5ReasoningEfforts(apiId: string) {
    if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
    const version = gpt5Version(apiId)
    if (version === undefined) return undefined
    if (version === 1) return OPENAI_GPT5_1_EFFORTS
    return OPENAI_GPT5_2_PLUS_EFFORTS
  }

  function gpt5CodexReasoningEfforts(apiId: string) {
    if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
    const version = gpt5Version(apiId)
    if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
    if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) {
      return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
    }
    return WIDELY_SUPPORTED_EFFORTS
  }

  function gpt5ChatReasoningEfforts(apiId: string) {
    if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
    return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
  }

  function openaiReasoningEfforts(apiId: string, releaseDate = "") {
    const id = apiId.toLowerCase()
    if (id.includes("deep-research")) return ["medium"]
    const chatEfforts = gpt5ChatReasoningEfforts(id)
    if (chatEfforts) return chatEfforts
    if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
    const codexEfforts = gpt5CodexReasoningEfforts(id)
    if (codexEfforts) return codexEfforts
    const versionedEfforts = versionedGpt5ReasoningEfforts(id)
    if (versionedEfforts) return versionedEfforts
    const efforts = [...WIDELY_SUPPORTED_EFFORTS]
    if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
    if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
    if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
    return efforts
  }

  function openaiCompatibleReasoningEfforts(id: string) {
    const apiId = id.toLowerCase()
    const chatEfforts = gpt5ChatReasoningEfforts(apiId)
    if (chatEfforts) return chatEfforts
    if (GPT5_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_EFFORTS
    return gpt5CodexReasoningEfforts(apiId) ?? versionedGpt5ReasoningEfforts(apiId) ?? OPENAI_EFFORTS
  }

  function anthropicOpus47OrLater(apiId: string) {
    const version = /opus-(\d+)[.-](\d+)(?:[.@-]|$)|claude-(\d+)[.-](\d+)-opus(?:[.@-]|$)/i.exec(apiId)
    if (!version) return false
    const major = Number(version[1] ?? version[3])
    const minor = Number(version[2] ?? version[4])
    return major > 4 || (major === 4 && minor >= 7)
  }

  function anthropicAdaptiveEfforts(apiId: string): string[] | null {
    if (anthropicOpus47OrLater(apiId) || apiId.includes("fable-5")) {
      return ["low", "medium", "high", "xhigh", "max"]
    }
    if (
      [
        "opus-4-6",
        "opus-4.6",
        "4-6-opus",
        "4.6-opus",
        "sonnet-4-6",
        "sonnet-4.6",
        "4-6-sonnet",
        "4.6-sonnet",
      ].some((v) => apiId.includes(v))
    ) {
      return ["low", "medium", "high", "max"]
    }
    return null
  }

  function anthropicOmitsThinking(apiId: string) {
    return anthropicOpus47OrLater(apiId) || apiId.includes("fable-5")
  }

  function googleThinkingLevelEfforts(apiId: string) {
    const id = apiId.toLowerCase()
    if (!id.includes("gemini-3")) return ["low", "high"]
    if (id.includes("flash-image")) return ["minimal", "high"]
    if (id.includes("pro-image")) return ["high"]
    if (id.includes("flash")) return ["minimal", "low", "medium", "high"]
    return ["low", "medium", "high"]
  }

  function googleThinkingBudgetMax(apiId: string) {
    const id = apiId.toLowerCase()
    if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
    return 24_576
  }

  function wrapInSapModelParams(variants: Record<string, Record<string, any>>): Record<string, Record<string, any>> {
    return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { modelParams: v }]))
  }

  function googleThinkingVariants(model: Provider.Model): Record<string, Record<string, any>> {
    const id = model.api.id.toLowerCase()
    if (id.includes("2.5")) {
      return {
        high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        max: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: googleThinkingBudgetMax(id) },
        },
      }
    }
    return Object.fromEntries(
      googleThinkingLevelEfforts(id).map((effort) => [
        effort,
        { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } },
      ]),
    )
  }
  // altimate_change end

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const id = model.id.toLowerCase()
    // altimate_change start — special-case providers whose variant controls differ from broad family defaults
    const glm52 = ["glm-5.2", "glm-5-2", "glm-5p2"].some(
      (name) => id.includes(name) || model.api.id.toLowerCase().includes(name),
    )
    if (
      model.api.id.toLowerCase().includes("minimax-m3") &&
      ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible"].includes(model.api.npm)
    ) {
      return {
        none: { thinking: { type: "disabled" } },
        thinking: { thinking: { type: "adaptive" } },
      }
    }
    const adaptiveThinkingOmitted = anthropicOmitsThinking(model.api.id)
    const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
    if (glm52 && model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        high: { reasoning: { effort: "high" } },
        xhigh: { reasoning: { effort: "xhigh" } },
      }
    }
    if (glm52 && model.api.npm === "@ai-sdk/openai-compatible") {
      return {
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      }
    }
    if (glm52 && model.api.npm === "@ai-sdk/anthropic") {
      return {
        high: { effort: "high" },
        max: { effort: "max" },
      }
    }
    if (
      id.includes("deepseek-chat") ||
      id.includes("deepseek-reasoner") ||
      id.includes("deepseek-r1") ||
      id.includes("deepseek-v3") ||
      id.includes("minimax") ||
      (id.includes("glm") && !glm52) ||
      id.includes("kimi") ||
      id.includes("k2p") ||
      id.includes("qwen") ||
      id.includes("big-pickle")
    )
      return {}
    // altimate_change end

    // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
    if (id.includes("grok") && id.includes("grok-3-mini")) {
      if (model.api.npm === "@openrouter/ai-sdk-provider") {
        return {
          low: { reasoning: { effort: "low" } },
          high: { reasoning: { effort: "high" } },
        }
      }
      return {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      }
    }
    if (id.includes("grok")) return {}

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        // altimate_change start — OpenRouter exposes broad reasoning controls for reasoning models
        return Object.fromEntries(
          (model.api.id.startsWith("openai/") || id.includes("gpt")
            ? openaiCompatibleReasoningEfforts(model.api.id)
            : WIDELY_SUPPORTED_EFFORTS
          ).map((effort) => [effort, { reasoning: { effort } }]),
        )
      // altimate_change end

      // altimate_change start — Cloudflare AI Gateway /v1/compat expects OpenAI-shaped reasoningEffort
      case "ai-gateway-provider": {
        if (model.api.id.startsWith("openai/")) {
          const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
          return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
        }
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      // altimate_change end

      case "@ai-sdk/gateway":
        if (model.id.includes("anthropic")) {
          if (adaptiveEfforts) {
            return Object.fromEntries(
              adaptiveEfforts.map((effort) => [
                effort,
                {
                  thinking: {
                    type: "adaptive",
                    ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
                  },
                  effort,
                },
              ]),
            )
          }
          return {
            high: {
              thinking: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              thinking: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }
        if (model.id.includes("google")) {
          if (id.includes("2.5")) {
            return {
              high: {
                thinkingConfig: {
                  includeThoughts: true,
                  thinkingBudget: 16000,
                },
              },
              max: {
                thinkingConfig: {
                  includeThoughts: true,
                  thinkingBudget: googleThinkingBudgetMax(id),
                },
              },
            }
          }
          return Object.fromEntries(
            ["low", "high"].map((effort) => [
              effort,
              {
                includeThoughts: true,
                thinkingLevel: effort,
              },
            ]),
          )
        }
        return Object.fromEntries(
          openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
        )

      case "@ai-sdk/github-copilot":
        if (model.id.includes("gemini")) {
          // currently github copilot only returns thinking
          return {}
        }
        if (model.id.includes("claude")) {
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
        }
        const copilotEfforts = iife(() => {
          if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
            return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
          const arr = [...WIDELY_SUPPORTED_EFFORTS]
          if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
          return arr
        })
        return Object.fromEntries(
          copilotEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "venice-ai-sdk-provider":
      // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
      case "@ai-sdk/openai-compatible":
        // altimate_change start — Cohere North and DeepSeek-compatible providers expose narrower/broader native sets
        if (model.api.id.toLowerCase().includes("north-mini-code")) {
          return Object.fromEntries(["none", "high"].map((effort) => [effort, { reasoningEffort: effort }]))
        }
        if (model.api.id.toLowerCase().includes("deepseek-v4")) {
          return Object.fromEntries([...WIDELY_SUPPORTED_EFFORTS, "max"].map((effort) => [effort, { reasoningEffort: effort }]))
        }
        // altimate_change end
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (id === "o1-mini") return {}
        return Object.fromEntries(
          openaiReasoningEfforts(id, model.release_date).map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: INCLUDE_ENCRYPTED_REASONING,
            },
          ]),
        )
      // altimate_change start — Bedrock Mantle is OpenAI Responses-compatible
      case "@ai-sdk/amazon-bedrock/mantle":
      // altimate_change end
      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        return Object.fromEntries(
          openaiReasoningEfforts(model.api.id, model.release_date).map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: INCLUDE_ENCRYPTED_REASONING,
            },
          ]),
        )

      case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      case "@ai-sdk/google-vertex/anthropic":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider

        if (adaptiveEfforts) {
          let efforts = [...adaptiveEfforts]
          // altimate_change start — GitHub Copilot's Anthropic route supports a narrower adaptive subset
          if (model.providerID === "github-copilot") {
            if (model.api.id.includes("opus-4.7")) efforts = ["medium"]
            efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
          }
          // altimate_change end
          return Object.fromEntries(
            efforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                  ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
                },
                effort,
              },
            ]),
          )
        }

        // altimate_change start — Opus 4.5 uses the native effort field, not budgetTokens
        if (["opus-4-5", "opus-4.5"].some((v) => model.api.id.includes(v))) {
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
        }
        // altimate_change end

        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                reasoningConfig: {
                  type: "adaptive",
                  maxReasoningEffort: effort,
                  ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
                },
              },
            ]),
          )
        }
        // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }

        // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        return googleThinkingVariants(model)

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        // altimate_change start — only Mistral Small 4 and Medium 3.5 expose adjustable reasoning
        {
          const mistralId = model.api.id.toLowerCase()
          const ids = ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5", "mistral-medium-2604"]
          if (!ids.some((item) => mistralId.includes(item))) return {}
          return { high: { reasoningEffort: "high" } }
        }
      // altimate_change end

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
        return Object.fromEntries(
          groqEffort.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
            },
          ]),
        )

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}

      case "@jerome-benoit/sap-ai-provider-v2": {
        const apiId = model.api.id.toLowerCase()
        if (apiId.includes("anthropic")) {
          if (adaptiveEfforts) {
            return wrapInSapModelParams(
              Object.fromEntries(
                adaptiveEfforts.map((effort) => [
                  effort,
                  {
                    thinking: { type: "adaptive", ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}) },
                    output_config: { effort },
                  },
                ]),
              ),
            )
          }
          return wrapInSapModelParams({
            high: { thinking: { type: "enabled", budget_tokens: 16000 } },
            max: { thinking: { type: "enabled", budget_tokens: 31999 } },
          })
        }
        if (apiId.includes("gemini") && apiId.includes("2.5")) {
          return wrapInSapModelParams(googleThinkingVariants(model))
        }
        if (apiId.includes("gpt") || /\bo[1-9]/.test(apiId)) {
          const efforts = openaiReasoningEfforts(apiId, model.release_date)
          return wrapInSapModelParams(Object.fromEntries(efforts.map((effort) => [effort, { reasoning_effort: effort }])))
        }
        return wrapInSapModelParams(
          Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoning_effort: effort }])),
        )
      }
    }
    return {}
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}

    // openai and providers using openai package should set store to false by default.
    if (
      input.model.providerID === "openai" ||
      input.model.api.npm === "@ai-sdk/openai" ||
      input.model.api.npm === "@ai-sdk/github-copilot" ||
      // altimate_change start — Bedrock Mantle uses OpenAI Responses semantics
      input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
      // altimate_change end
    ) {
      result["store"] = false
    }

    // altimate_change start — Azure defaults match OpenAI request retention/cache behavior
    if (input.model.api.npm === "@ai-sdk/azure") {
      result["store"] = false
      result["promptCacheKey"] = input.sessionID
    }
    // altimate_change end

    if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      input.model.providerID === "baseten" ||
      (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (
      // altimate_change start — coding-plan provider IDs carry the zai/zhipuai provider prefix
      ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
      // altimate_change end
      input.model.api.npm === "@ai-sdk/openai-compatible"
    ) {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
      result["promptCacheKey"] = input.sessionID
    }

    if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
      if (input.model.capabilities.reasoning) {
        result["thinkingConfig"] = {
          includeThoughts: true,
        }
        if (input.model.api.id.includes("gemini-3")) {
          result["thinkingConfig"]["thinkingLevel"] = "high"
        }
      }
    }

    // Enable thinking by default for kimi-k2.5/k2p5 models using anthropic SDK
    const modelId = input.model.api.id.toLowerCase()
    // altimate_change start — MiniMax Anthropic interface defaults thinking off unless requested
    if (modelId.includes("minimax-m3") && input.model.api.npm === "@ai-sdk/anthropic") {
      result["thinking"] = { type: "adaptive" }
    }
    // altimate_change end

    if (
      (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
      // altimate_change start — include all current Kimi K2 point-release spellings
      (modelId.includes("k2p") || modelId.includes("kimi-k2.") || modelId.includes("kimi-k2p"))
      // altimate_change end
    ) {
      result["thinking"] = {
        type: "enabled",
        budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
      }
    }

    // Enable thinking for reasoning models on alibaba-cn (DashScope).
    // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
    // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
    // deepseek-r1, etc. never output thinking/reasoning tokens.
    // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
    if (
      input.model.providerID === "alibaba-cn" &&
      input.model.capabilities.reasoning &&
      input.model.api.npm === "@ai-sdk/openai-compatible" &&
      !modelId.includes("kimi-k2-thinking")
    ) {
      result["enable_thinking"] = true
    }

    // altimate_change start — Azure GPT-5.5 is chat-completions based; only summary survives here
    if (input.model.api.npm === "@ai-sdk/azure" && input.model.api.id.includes("gpt-5.5")) {
      result["reasoningSummary"] = "auto"
      return result
    }
    // altimate_change end

    if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
      if (!input.model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
        // altimate_change start — only Responses-compatible SDKs understand reasoningSummary/include
        if (
          input.model.api.npm === "@ai-sdk/openai" ||
          input.model.api.npm === "@ai-sdk/azure" ||
          input.model.api.npm === "@ai-sdk/github-copilot" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
        ) {
          result["reasoningSummary"] = "auto"
        }
        if (input.model.api.npm === "@ai-sdk/openai" || input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle") {
          result["include"] = INCLUDE_ENCRYPTED_REASONING
        }
        // altimate_change end
      }

      // Only set textVerbosity for non-chat gpt-5.x models
      // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat") &&
        input.model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }

      if (input.model.providerID.startsWith("opencode")) {
        result["promptCacheKey"] = input.sessionID
        result["include"] = INCLUDE_ENCRYPTED_REASONING
        result["reasoningSummary"] = "auto"
      }
    }

    if (input.model.providerID === "venice") {
      result["promptCacheKey"] = input.sessionID
    }

    if (input.model.providerID === "openrouter") {
      result["prompt_cache_key"] = input.sessionID
    }
    if (input.model.api.npm === "@ai-sdk/gateway") {
      result["gateway"] = {
        caching: "auto",
      }
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    // altimate_change start — small options should reuse the weakest configured variant
    const small = Object.values(model.variants ?? {})[0] ?? {}
    if (
      model.providerID === "openai" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/github-copilot"
    ) {
      return mergeDeep({ store: false }, small)
    }
    // altimate_change start — upstream_fix: restore Google minimal thinking for small calls only on reasoning models
    if (
      (model.providerID === "google" ||
        model.api.npm === "@ai-sdk/google" ||
        model.api.npm === "@ai-sdk/google-vertex") &&
      model.capabilities.reasoning
    ) {
      const id = model.api.id.toLowerCase()
      if (id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    // altimate_change end
    if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
      if (model.providerID === "openrouter" && (small as any).reasoning?.effort === "low") {
        return { reasoning: { effort: "none" } }
      }
      if (Object.keys(small).length === 0 && model.api.id.includes("google")) {
        return { reasoning: { enabled: false } }
      }
    }

    if (model.providerID === "venice") {
      if (Object.keys(small).length > 0) return small
      return { veniceParameters: { disableThinking: true } }
    }

    return small
    // altimate_change end
  }

  // Maps model ID prefix to provider slug used in providerOptions.
  // Example: "amazon/nova-2-lite" → "bedrock"
  const SLUG_OVERRIDES: Record<string, string> = {
    amazon: "bedrock",
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    if (model.api.npm === "@ai-sdk/gateway") {
      // Gateway providerOptions are split across two namespaces:
      // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
      // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
      // We keep `gateway` as-is and route every other top-level option under the
      // model-derived upstream slug.
      const i = model.api.id.indexOf("/")
      const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
      const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
      const gateway = options.gateway
      const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
      const has = Object.keys(rest).length > 0

      const result: Record<string, any> = {}
      if (gateway !== undefined) result.gateway = gateway

      if (has) {
        if (slug) {
          // Route model-specific options under the provider slug
          result[slug] = rest
        } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
          result.gateway = { ...gateway, ...rest }
        } else {
          result.gateway = rest
        }
      }

      return result
    }

    // altimate_change start — mirror SDK providerOptions name parsing for compatible/openai/anthropic packages
    const usesDotSplitOptions =
      model.api.npm === "@ai-sdk/openai-compatible" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/anthropic"
    const key = sdkKey(model.api.npm) ?? (usesDotSplitOptions ? model.providerID.split(".")[0] : model.providerID)
    // altimate_change end
    // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
    // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
    // "azure" first. Pass both so model options work on either code path.
    if (model.api.npm === "@ai-sdk/azure") {
      return { openai: options, azure: options }
    }
    return { [key]: options }
  }

  export function maxOutputTokens(model: Provider.Model, override?: number): number {
    // altimate_change start — honor OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX override (fork feature)
    const ceiling = override && override > 0 ? Math.min(override, OUTPUT_TOKEN_MAX) : OUTPUT_TOKEN_MAX
    return Math.min(model.limit.output, ceiling) || ceiling
    // altimate_change end
  }

  // altimate_change start — clamp the reserved completion budget against the real prompt size.
  //
  // `maxOutputTokens` above is a per-model ceiling. It never reads `limit.context`, so on a
  // model where input and completion share one window a large system prompt can push
  // `input + reservation` past that window and the provider rejects the request with a hard
  // 400 before generating anything. The client already knows all three numbers, so it can
  // either shrink the reservation to fit or refuse with an actionable message.

  /**
   * Smallest completion budget worth sending. Below this an agent turn cannot reliably emit
   * even one tool call, so a request that would clamp this far is refused instead of being
   * sent to come back as a silently truncated response.
   */
  export const OUTPUT_TOKEN_FLOOR = 1_024

  // `inputTokens` is a character-ratio estimate, not the provider's tokenizer. Measured drift
  // against a provider's own accounting on a ~52K prompt was under 1%, so a clamped budget
  // keeps a 2% (minimum 512-token) margin rather than filling the window exactly.
  const CLAMP_MARGIN_FRACTION = 0.02
  const CLAMP_MARGIN_MIN = 512

  /** Thrown before the request is sent when no usable completion budget fits in the window. */
  export class OutputTokenBudgetError extends Error {
    constructor(
      readonly info: {
        modelID: string
        providerID: string
        inputTokens: number
        requested: number
        context: number
        floor: number
      },
    ) {
      super(
        [
          `Context budget exceeded before the request was sent.`,
          `${info.providerID}/${info.modelID} declares a ${info.context}-token context window,`,
          `the prompt is ~${info.inputTokens} tokens, and ${info.requested} tokens are reserved for`,
          `the completion — ${info.inputTokens + info.requested} in total.`,
          `Even after clamping, fewer than ${info.floor} tokens would remain for the response.`,
          `Reduce the system prompt (fewer instructions, skills, or AGENTS.md content), lower the`,
          `output reservation via OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, or use a model with a`,
          `larger context window.`,
        ].join(" "),
      )
      this.name = "OutputTokenBudgetError"
    }
  }

  /** Rough token count for the prompt about to be sent, used only for the clamp decision. */
  export function estimateInputTokens(system: string[], messages: unknown[]): number {
    return Token.estimate(system.join("\n")) + Token.estimate(JSON.stringify(messages))
  }

  /**
   * Shrink `requested` so `inputTokens + result` fits `model.limit.context`.
   *
   * Returns `requested` unchanged whenever it already fits, when the caller omitted it, when the
   * model declares no context window, when the declared window is too small to hold even a
   * floor-sized completion (those limits are not credible enough to fail a request on — the
   * provider stays the authority), or when the model budgets input separately via `limit.input`
   * (there the two budgets are not shared and clamping would be wrong).
   * Throws `OutputTokenBudgetError` when the remaining budget is below `OUTPUT_TOKEN_FLOOR`.
   */
  export function clampOutputTokens(input: {
    model: Provider.Model
    requested: number | undefined
    inputTokens: number
  }): number | undefined {
    const requested = input.requested
    if (requested === undefined) return undefined

    const context = input.model.limit.context
    if (!context || context <= OUTPUT_TOKEN_FLOOR) return requested
    if (input.model.limit.input) return requested
    if (input.inputTokens <= 0) return requested
    if (input.inputTokens + requested <= context) return requested

    const margin = Math.max(CLAMP_MARGIN_MIN, Math.ceil(input.inputTokens * CLAMP_MARGIN_FRACTION))
    const clamped = context - input.inputTokens - margin
    if (clamped < OUTPUT_TOKEN_FLOOR) {
      throw new OutputTokenBudgetError({
        modelID: input.model.id,
        providerID: input.model.providerID,
        inputTokens: input.inputTokens,
        requested,
        context,
        floor: OUTPUT_TOKEN_FLOOR,
      })
    }
    log.warn("clamped output token reservation to fit context window", {
      providerID: input.model.providerID,
      modelID: input.model.id,
      context,
      inputTokens: input.inputTokens,
      requested,
      clamped,
    })
    return clamped
  }
  // altimate_change end

  // altimate_change start — lower MCP/tool JSON Schema to provider-compatible subsets
  type JsonRecord = Record<string, unknown>

  function isPlainObject(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function sanitizeOpenAISchema(value: unknown): unknown {
    const types = ["string", "number", "boolean", "integer", "object", "array", "null"]
    const compositionKeys = ["anyOf", "oneOf", "allOf"]

    if (typeof value === "boolean") return { type: "string" }
    if (Array.isArray(value)) return value.map(sanitizeOpenAISchema)
    if (!isPlainObject(value)) return value

    const result: JsonRecord = {}

    if (typeof value.$ref === "string") result.$ref = value.$ref
    if (typeof value.description === "string") result.description = value.description
    if ("const" in value) result.enum = [value.const]
    else if (Array.isArray(value.enum)) result.enum = value.enum

    if (isPlainObject(value.properties)) {
      result.properties = Object.fromEntries(
        Object.entries(value.properties).map(([key, item]) => [key, sanitizeOpenAISchema(item)]),
      )
    }

    if (Array.isArray(value.required)) {
      result.required = value.required.filter((item) => typeof item === "string")
    }

    if ("items" in value) result.items = sanitizeOpenAISchema(value.items)

    if ("additionalProperties" in value) {
      result.additionalProperties =
        typeof value.additionalProperties === "boolean"
          ? value.additionalProperties
          : sanitizeOpenAISchema(value.additionalProperties)
    }

    for (const key of compositionKeys) {
      if (Array.isArray(value[key])) result[key] = value[key].map(sanitizeOpenAISchema)
    }

    for (const key of ["$defs", "definitions"]) {
      if (isPlainObject(value[key])) {
        result[key] = Object.fromEntries(
          Object.entries(value[key]).map(([name, item]) => [name, sanitizeOpenAISchema(item)]),
        )
      }
    }

    const schemaTypes =
      typeof value.type === "string"
        ? types.includes(value.type)
          ? [value.type]
          : []
        : Array.isArray(value.type)
          ? value.type.filter((item) => typeof item === "string" && types.includes(item))
          : []

    if (schemaTypes.length === 0 && (typeof result.$ref === "string" || compositionKeys.some((key) => key in result))) {
      return result
    }

    const inferredTypes =
      schemaTypes.length > 0
        ? schemaTypes
        : ["properties", "required", "additionalProperties"].some((key) => key in value)
          ? ["object"]
          : ["items", "prefixItems"].some((key) => key in value)
            ? ["array"]
            : "enum" in result || "format" in value
              ? ["string"]
              : ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in value)
                ? ["number"]
                : []

    if (inferredTypes.length === 0) return {}

    result.type = inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes
    if (inferredTypes.includes("object") && !("properties" in result)) result.properties = {}
    if (inferredTypes.includes("array") && !("items" in result)) result.items = { type: "string" }
    return result
  }
  // altimate_change end

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // altimate_change start — OpenAI/Azure reject many JSON Schema keywords emitted by MCP servers
    if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") {
      schema = sanitizeOpenAISchema(schema) as JSONSchema7
    }

    if (model.providerID === "moonshotai" || model.api.id.toLowerCase().includes("kimi")) {
      const sanitizeMoonshot = (obj: unknown): unknown => {
        if (obj === null || typeof obj !== "object") return obj
        if (Array.isArray(obj)) return obj.map(sanitizeMoonshot)
        if ("$ref" in obj && typeof obj.$ref === "string") return { $ref: obj.$ref }
        const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, sanitizeMoonshot(value)]))
        if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
        return result
      }

      const sanitized = sanitizeMoonshot(schema)
      if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
        schema = sanitized as JSONSchema7
      }
    }
    // altimate_change end

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const isPlainObject = (node: unknown): node is Record<string, any> =>
        typeof node === "object" && node !== null && !Array.isArray(node)
      const hasCombiner = (node: unknown) =>
        isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
      const hasSchemaIntent = (node: unknown) => {
        if (!isPlainObject(node)) return false
        if (hasCombiner(node)) return true
        return [
          "type",
          "properties",
          "items",
          "prefixItems",
          "enum",
          "const",
          "$ref",
          "additionalProperties",
          "patternProperties",
          "required",
          "not",
          "if",
          "then",
          "else",
        ].some((key) => key in node)
      }

      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // altimate_change start — Gemini requires a single type; split JSON Schema type arrays
        if (Array.isArray(result.type)) {
          const hasNull = result.type.includes("null")
          const nonNull = result.type.filter((entry: unknown) => entry !== "null")
          if (nonNull.length === 0) {
            result.type = "null"
          } else {
            delete result.type
            result.anyOf = nonNull.map((entry: unknown) => ({ type: entry }))
            if (hasNull) result.nullable = true
          }
        }
        // altimate_change end

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && !hasCombiner(result)) {
          if (result.items == null) {
            result.items = {}
          }
          // Ensure items has a type only when it's still schema-empty.
          if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
            result.items.type = "string"
          }
        }

        // Remove properties/required from non-object types (Gemini rejects these)
        if (result.type && result.type !== "object" && !hasCombiner(result)) {
          delete result.properties
          delete result.required
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema as JSONSchema7
  }
}

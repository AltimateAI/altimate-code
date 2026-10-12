import type { LanguageModelV3, LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider"

class PrivateFieldModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  #modelId: string
  #provider = "private-field"
  #text = "private state"
  #supportedUrls = { "image/*": [/^https:\/\/private-field\.test\//] }

  constructor(modelId: string) {
    this.#modelId = modelId
  }

  get provider() {
    return this.#provider
  }

  get modelId() {
    return this.#modelId
  }

  get supportedUrls() {
    return this.#supportedUrls
  }

  async doGenerate(): Promise<LanguageModelV3GenerateResult> {
    return {
      content: [{ type: "text", text: this.#text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }
  }

  async doStream() {
    const text = this.#text
    const result = await this.doGenerate()
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "text" })
          controller.enqueue({ type: "text-delta", id: "text", delta: text })
          controller.enqueue({ type: "text-end", id: "text" })
          controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage })
          controller.close()
        },
      }),
    }
  }
}

export function createPrivateFieldProvider() {
  return { languageModel: (modelId: string) => new PrivateFieldModel(modelId) }
}

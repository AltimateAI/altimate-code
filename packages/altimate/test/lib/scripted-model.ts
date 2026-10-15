import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Model, Plugin, Provider } from "@opencode/plugin"

export type ScriptedStep = { tool: string; input: Record<string, unknown>; id?: string } | { text: string }

export function createScriptedModel(initial: readonly ScriptedStep[] = []) {
  const steps = [...initial]
  const calls: LanguageModelV3CallOptions[] = []
  const language: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "scripted",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("Unexpected non-streaming scripted request")),
    async doStream(options) {
      calls.push(options)
      const step = steps.shift()
      if (!step) throw new Error("Scripted model response queue is empty")
      const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }]
      if ("tool" in step) {
        const id = step.id ?? `call_${calls.length}`
        const input = JSON.stringify(step.input)
        parts.push(
          { type: "tool-input-start", id, toolName: step.tool },
          { type: "tool-input-delta", id, delta: input },
          { type: "tool-input-end", id },
          { type: "tool-call", toolCallId: id, toolName: step.tool, input },
        )
      }
      if ("text" in step) {
        parts.push(
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: step.text },
          { type: "text-end", id: "text" },
        )
      }
      parts.push({
        type: "finish",
        finishReason: { unified: "tool" in step ? "tool-calls" : "stop", raw: "tool" in step ? "tool_calls" : "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part))
            controller.close()
          },
        }),
      }
    },
  }
  const plugin = Plugin.define({
    id: "scripted-model",
    async setup(ctx) {
      const providerID = Provider.ID.make("scripted")
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            activation: "enabled",
            package: `aisdk:${new URL("./provider-fixture.ts", import.meta.url).href}`,
          },
          models: [Model.Info.default(providerID, Model.ID.make("scripted"))],
        })
      })
      await ctx.aisdk.hook(
        "language",
        (event) => {
          event.language = language
        },
        { providerID },
      )
    },
  })
  return {
    plugin,
    calls,
    push(...next: ScriptedStep[]) {
      steps.push(...next)
    },
    reset(next: readonly ScriptedStep[]) {
      steps.splice(0, steps.length, ...next)
    },
    get remaining() {
      return steps.length
    },
  }
}

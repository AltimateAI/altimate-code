export * as ClaudeAgentLanguageModel from "./claude-agent-language-model"

import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { ClaudeSessions } from "../claude/sessions"
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeAgentID } from "../id"
import { ConvertClaudeStream } from "./convert-claude-stream"
import { RequestKind } from "./request-kind"
import { ClaudeSystemPrompt } from "./system-prompt"

export interface Dependencies {
  readonly run: (request: ClaudeSessions.Request, signal: AbortSignal) => Promise<void>
}

export class Model implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = ClaudeAgentID.ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    readonly dependencies: Dependencies,
    readonly connection: Readonly<Record<string, string>> = {},
  ) {}

  // altimate_change start — upstream only streams. The shipped CLI also calls generateObject/generateText
  // (agent creation, learning reflection), so a generate call collects the streamed reply. Claude Code has no
  // structured-output mode, so a JSON request is asked for in the prompt and any markdown fence is removed.
  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const json = options.responseFormat?.type === "json" ? options.responseFormat : undefined
    const prompt: LanguageModelV3Prompt = json
      ? [{ role: "system", content: jsonInstruction(json.schema) }, ...options.prompt]
      : options.prompt
    const { stream } = await this.doStream({ ...options, prompt })
    const content: LanguageModelV3Content[] = []
    const open = new Map<string, { type: "text" | "reasoning"; text: string }>()
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage: LanguageModelV3Usage | undefined
    let response: { id?: string; modelId?: string } = {}
    for await (const part of stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) {
      switch (part.type) {
        case "text-start":
        case "reasoning-start":
          open.set(part.id, { type: part.type === "text-start" ? "text" : "reasoning", text: "" })
          break
        case "text-delta":
        case "reasoning-delta": {
          const block = open.get(part.id)
          if (block) block.text += part.delta
          break
        }
        case "text-end":
        case "reasoning-end": {
          const block = open.get(part.id)
          open.delete(part.id)
          if (block) content.push({ type: block.type, text: block.text })
          break
        }
        case "tool-call":
          content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
          break
        case "response-metadata":
          response = { id: part.id, modelId: part.modelId }
          break
        case "finish":
          finishReason = part.finishReason
          usage = part.usage
          break
        case "error":
          throw part.error
      }
    }
    if (json) {
      for (const part of content) if (part.type === "text") part.text = stripFence(part.text)
    }
    return {
      content,
      finishReason,
      usage: usage ?? { inputTokens: {}, outputTokens: {} },
      warnings: [],
      response,
    } as LanguageModelV3GenerateResult
  }
  // altimate_change end

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const tools =
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
    const headers = options.headers ?? {}
    const kind = headers[RequestKind.HEADER]
    const session = headers[RequestKind.SESSION_HEADER]
    const settings = options.providerOptions?.[ClaudeAgentID.ID]
    const role = settings?.[ClaudeSystemPrompt.AGENT_OPTION]
    const agent = typeof role === "string" ? role : undefined
    const loaded = settings?.[ClaudeSystemPrompt.INSTRUCTIONS_OPTION]
    const instructions = typeof loaded === "string" ? loaded : undefined
    const effort = parseEffort(settings?.effort)
    const primary = kind === "primary"
    const branch = kind === "generate" || kind === "compaction"
    const sessionID = primary ? session : undefined
    // Conversation branches copy their source session and keep the Claude prompt. OpenCode supplies their task as user input.
    const sourceID = primary ? headers[RequestKind.FORK_HEADER] : branch ? session : undefined
    // Branches offer the chat's tools and system prompt so Claude reuses the chat's prompt cache.
    const offered = primary || branch ? tools : []
    const convert = ConvertClaudeStream.make(offered)
    // Titles are standalone tasks, so OpenCode's system prompt replaces Claude Code's.
    const system =
      primary || branch ? ClaudeSystemPrompt.make(agent, instructions) : ClaudeSystemPrompt.utility(options.prompt)
    let cancelled = false
    let task: Promise<void>
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        task = this.dependencies
          .run(
            {
              sessionID,
              sourceID,
              model: this.modelId,
              effort,
              maxOutputTokens: options.maxOutputTokens,
              connection: this.connection,
              system,
              prompt: options.prompt,
              tools: offered,
              emit: (message) => {
                if (cancelled) return
                for (const part of convert(message)) controller.enqueue(part)
              },
            },
            signal,
          )
          .then(
            () => {
              if (!cancelled) controller.close()
            },
            (error) => {
              if (!cancelled) controller.error(error)
            },
          )
      },
      cancel: () => {
        cancelled = true
        abort.abort()
        return task
      },
    })
    return { stream }
  }
}

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]

function parseEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  const effort = EFFORTS.find((effort) => value === effort)
  if (effort !== undefined) return effort
  throw new Error("Claude Agent effort must be low, medium, high, xhigh or max")
}

// altimate_change start — JSON output for generate calls (see doGenerate)
function jsonInstruction(schema: JSONSchema7 | undefined) {
  const shape = schema ? ` that matches this JSON schema:\n${JSON.stringify(schema)}` : ""
  return `Respond with only a JSON value${shape}\nDo not wrap it in a markdown code fence or add any other text.`
}

function stripFence(text: string) {
  const match = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  return match ? match[1]! : text
}
// altimate_change end

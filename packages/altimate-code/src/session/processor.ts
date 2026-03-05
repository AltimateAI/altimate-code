import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Telemetry } from "@/telemetry"
import { MCP } from "@/mcp"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let stepStartTime = Date.now()
    let toolCallCounter = 0
    let previousTool: string | null = null
    let generationCounter = 0
    let retryErrorType: string | null = null
    let retryStartTime: number | null = null

    const result = {
      get message() {
        return input.assistantMessage
      },
      get toolCallCount() {
        return toolCallCounter
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  reasoningMap[value.id] = reasoningPart
                  await Session.updatePart(reasoningPart)
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      partID: part.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                      Telemetry.track({
                        type: "doom_loop_detected",
                        timestamp: Date.now(),
                        session_id: input.sessionID,
                        tool_name: value.toolName,
                        repeat_count: DOOM_LOOP_THRESHOLD,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })
                    const toolType = MCP.isMcpTool(match.tool) ? "mcp" as const : "standard" as const
                    Telemetry.track({
                      type: "tool_call",
                      timestamp: Date.now(),
                      session_id: input.sessionID,
                      message_id: input.assistantMessage.id,
                      tool_name: match.tool,
                      tool_type: toolType,
                      tool_category: Telemetry.categorizeToolName(match.tool, toolType),
                      status: "success",
                      duration_ms: Date.now() - match.state.time.start,
                      sequence_index: toolCallCounter,
                      previous_tool: previousTool,
                    })
                    toolCallCounter++
                    previousTool = match.tool
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error instanceof Error ? value.error.message : String(value.error)).slice(0, 1000),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })
                    const errToolType = MCP.isMcpTool(match.tool) ? "mcp" as const : "standard" as const
                    Telemetry.track({
                      type: "tool_call",
                      timestamp: Date.now(),
                      session_id: input.sessionID,
                      message_id: input.assistantMessage.id,
                      tool_name: match.tool,
                      tool_type: errToolType,
                      tool_category: Telemetry.categorizeToolName(match.tool, errToolType),
                      status: "error",
                      duration_ms: Date.now() - match.state.time.start,
                      sequence_index: toolCallCounter,
                      previous_tool: previousTool,
                      error: (value.error instanceof Error ? value.error.message : String(value.error)).slice(0, 500),
                    })
                    toolCallCounter++
                    previousTool = match.tool
                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  stepStartTime = Date.now()
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  generationCounter++
                  if (attempt > 0 && retryErrorType) {
                    Telemetry.track({
                      type: "error_recovered",
                      timestamp: Date.now(),
                      session_id: input.sessionID,
                      error_type: retryErrorType,
                      recovery_strategy: "retry",
                      attempts: attempt,
                      recovered: true,
                      duration_ms: Date.now() - (retryStartTime ?? Date.now()),
                    })
                    retryErrorType = null
                    retryStartTime = null
                  }
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  Telemetry.track({
                    type: "generation",
                    timestamp: Date.now(),
                    session_id: input.sessionID,
                    message_id: input.assistantMessage.id,
                    model_id: input.model.id,
                    provider_id: input.model.providerID,
                    agent: input.assistantMessage.agent ?? "",
                    finish_reason: value.finishReason,
                    tokens: {
                      input: usage.tokens.input,
                      output: usage.tokens.output,
                      reasoning: usage.tokens.reasoning,
                      cache_read: usage.tokens.cache.read,
                      cache_write: usage.tokens.cache.write,
                    },
                    cost: usage.cost,
                    duration_ms: Date.now() - stepStartTime,
                  })
                  // Context utilization tracking
                  const totalTokens = usage.tokens.input + usage.tokens.output + usage.tokens.cache.read
                  const contextLimit = input.model.limit?.context ?? 0
                  if (contextLimit > 0) {
                    const cacheRead = usage.tokens.cache.read
                    const totalInput = cacheRead + usage.tokens.input
                    Telemetry.track({
                      type: "context_utilization",
                      timestamp: Date.now(),
                      session_id: input.sessionID,
                      model_id: input.model.id,
                      tokens_used: totalTokens,
                      context_limit: contextLimit,
                      utilization_pct: Math.round((totalTokens / contextLimit) * 1000) / 1000,
                      generation_number: generationCounter,
                      cache_hit_ratio: totalInput > 0 ? Math.round((cacheRead / totalInput) * 1000) / 1000 : 0,
                    })
                  }
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  await Session.updatePart(currentText)
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: currentText.sessionID,
                      messageID: currentText.messageID,
                      partID: currentText.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      ...currentText.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            Telemetry.track({
              type: "error",
              timestamp: Date.now(),
              session_id: input.sessionID,
              error_name: e?.name ?? "UnknownError",
              error_message: (e?.message ?? String(e)).slice(0, 500),
              context: "processor",
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              log.info("context overflow detected, triggering compaction")
              needsCompaction = true
              const tokens = input.assistantMessage.tokens
              Telemetry.track({
                type: "context_overflow_recovered",
                timestamp: Date.now(),
                session_id: input.sessionID,
                model_id: input.model.id,
                provider_id: input.model.providerID,
                tokens_used:
                  tokens.total ||
                  tokens.input + tokens.output + tokens.cache.read + tokens.cache.write,
              })
              break
            }
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              Telemetry.track({
                type: "provider_error",
                timestamp: Date.now(),
                session_id: input.sessionID,
                provider_id: input.model.providerID,
                model_id: input.model.id,
                error_type: e?.name ?? "UnknownError",
                error_message: (e?.message ?? String(e)).slice(0, 500),
                http_status: (e as any)?.status,
              })
              if (attempt === 0) {
                retryStartTime = Date.now()
              }
              retryErrorType = e?.name ?? "UnknownError"
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}

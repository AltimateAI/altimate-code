import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
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
import { PartID } from "./schema"
import type { SessionID, MessageID } from "./schema"
// altimate_change start — import Telemetry for per-generation token tracking
import { Telemetry } from "@/altimate/telemetry"
// altimate_change end
// altimate_change start — write-starvation breaker + loop detection (fork-only
// modules) and the run-mode flag that gates armed behavior.
import { SessionStarvation } from "./starvation"
import { NudgeArbiter } from "./nudge"
// completion-token contract for the explicit-DONE stop path
import { SessionTermination } from "./termination"
import { Flag } from "@/flag/flag"
// altimate_change end
// altimate_change start — per-tool-result dispatch cap (fork-only module)
import { ToolResultCap } from "./tool-result-cap"
// altimate_change end
// altimate_change start — Effect Context.Service facade so the upstream Effect runtime
// (app-runtime AppLayer + httpapi server LayerNode list) can compose SessionProcessor as
// a Service. The fork keeps the imperative `create()` namespace function below; this is a
// thin delegating facade that preserves behavior exactly.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
// altimate_change end

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  // altimate_change start — per-tool repeat threshold to catch varied-input loops (e.g. todowrite 2,080x)
  // Legitimate tool use rarely exceeds 20-25 calls per tool per session.
  // 30 catches pathological patterns while avoiding false positives for power users.
  const TOOL_REPEAT_THRESHOLD = 30
  // altimate_change end
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  // altimate_change start — per-processor tool-call id coercer. Malformed
  // (non-string) ids from OpenAI-compatible servers are regenerated deterministically
  // via MessageV2.sanitizeToolCallID; the raw→sanitized alias map (keyed on the JSON
  // form) makes the propagation to paired tool-result/tool-error events atomic — even
  // when the provider flips the value's type mid-pair (numeric call id, string result
  // id), both halves resolve to the SAME sanitized id. A regenerated call id with an
  // un-regenerated result id would 400 every subsequent provider request.
  // Exported as a factory so the ingestion half is unit-testable against the replay
  // half in message-v2.ts (they must produce identical output for a pair).
  // The alias table is a Map, never a plain object: adversarial ids like
  // "__proto__"/"constructor"/"toString" hit inherited Object.prototype members
  // on a plain-object index and return non-strings as the "sanitized id",
  // erroring the stream loop. `salt` (per processor/step) keeps regenerated
  // ids for empty/duplicate malformed raw values from colliding across steps.
  export function createToolCallIDCoercer(salt?: string) {
    const aliases = new Map<string, string>()
    return (raw: unknown): string => {
      const key = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw))
      const existing = aliases.get(key)
      if (existing !== undefined) return existing
      const sanitized = MessageV2.sanitizeToolCallID(raw, salt)
      aliases.set(key, sanitized)
      return sanitized
    }
  }
  // altimate_change end

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    abort: AbortSignal
  }) {
    // altimate_change start — Map (not plain object) so adversarial ids can
    // never resolve to inherited Object.prototype members.
    const toolcalls = new Map<string, MessageV2.ToolPart>()
    // coerce malformed tool-call ids at ingestion; sanitized ids are used as
    // BOTH the persisted callID and the pairing key. Salted per processor so
    // regenerated ids for empty/duplicate raw values cannot collide across steps.
    const coerceToolCallID = createToolCallIDCoercer(input.assistantMessage.id)
    // per-tool call counter for varied-input loop detection
    const toolCallCounts = new Map<string, number>()
    // altimate_change end
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    // altimate_change start — per-step generation telemetry
    let stepStartTime = Date.now()
    // altimate_change end
    // altimate_change start — plan-agent tool-call-refusal detection
    // Some models (observed: qwen3-coder-next, occasionally gpt-5.4) end plan-agent
    // steps with finish_reason=stop and never emit tool calls. User abandons the
    // session thinking it's stuck. Track whether the session has ever produced a
    // tool call; if plan agent finishes its first step with stop-no-tools, warn.
    let sessionToolCallsMade = 0
    let planNoToolWarningEmitted = false
    // altimate_change end

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        // altimate_change start — tool-execution lookups use the same coercion
        return toolcalls.get(coerceToolCallID(toolCallID))
        // altimate_change end
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        // altimate_change start — resolve breaker config + arm state once per step.
        // ANNOTATE-ONLY by default (mode "annotate"): directives and the hard stop
        // require mode "armed" AND run mode. Skipped entirely for plan/review-class
        // agents (read-only deliverables are their normal outcome). Interactive
        // TUI/serve sessions never set ALTIMATE_RUN_MODE, so they can at most
        // receive informational annotations — never directives or stops.
        const processConfig = await Config.get()
        const shouldBreak = processConfig.experimental?.continue_loop_on_deny !== true
        const sbConfig = SessionStarvation.resolveConfig(
          processConfig.experimental?.starvation_breaker as SessionStarvation.ConfigShape | undefined,
        )
        const runMode = Flag.ALTIMATE_RUN_MODE
        // The compaction summarizer runs through this same processor under the
        // session's OWN id, so it would otherwise share the working agent's
        // per-session tracker: its single mutation-free step increments
        // `turnsWithoutMutation`, inflating the real agent's counter (spurious
        // would-fire telemetry in annotate mode, a premature directive in armed
        // mode). It can only produce a summary, so it is exempt from starvation
        // accounting entirely — the same reason it is excluded from directive
        // delivery below.
        const sbSummarizer = input.assistantMessage.summary === true
        const sbExempt = sbConfig.exemptAgents.includes(input.assistantMessage.agent) || sbSummarizer
        const starvation =
          sbConfig.mode === "off" || sbExempt ? undefined : SessionStarvation.forSession(input.sessionID, sbConfig)
        const sbArmed = sbConfig.mode === "armed" && runMode && !sbExempt
        const sbMode = sbConfig.mode === "armed" ? ("armed" as const) : ("annotate" as const)
        let starvationStop = false
        // altimate_change start — per-tool-result dispatch cap, resolved once
        // per step. Hard bound on the token estimate any single tool result may
        // contribute to the conversation — closes the observed bypass where one
        // giant query dump jumped a ~4K-token session past a 65K window in one step.
        const toolResultCapTokens = ToolResultCap.resolve({
          config: processConfig,
          model: input.model,
          safetyFraction: SessionCompaction.contextSafetyFraction(processConfig),
        })
        // altimate_change end
        // Nudge arbiter delivery: at most ONE system-authored
        // directive block per injected turn, highest precedence wins. Run-mode-only.
        // altimate_change start — upstream_fix: never let the compaction summarizer
        // consume a pending nudge/starvation/doom-loop directive — it can only
        // produce a summary and cannot act on it, so the real working turn right
        // after compaction would silently never see the breaker/loop nudge.
        let effectiveStreamInput = streamInput
        if (runMode && !input.assistantMessage.summary) {
          const directive = NudgeArbiter.take(input.sessionID)
          // altimate_change end
          if (directive) {
            // Attribute the injection to the DIRECTIVE that won arbitration,
            // not a hardcoded "nudge" — otherwise every injected doom-loop
            // status-check, starvation, and repeat-signature directive is
            // indistinguishable in telemetry.
            const telemetryKind = (() => {
              if (directive.kind.startsWith("doom_loop")) return "doom_loop" as const
              if (directive.kind === "repeat_signature") return "repeat_signature" as const
              if (directive.kind === "starvation") return "starvation" as const
              return "nudge" as const
            })()
            Telemetry.track({
              type: "starvation_breaker",
              timestamp: Date.now(),
              session_id: input.sessionID,
              mode: sbMode,
              kind: telemetryKind,
              action: "injected",
            })
            log.info("nudge arbiter directive injected", {
              sessionID: input.sessionID,
              source: directive.source,
              kind: directive.kind,
            })
            effectiveStreamInput = {
              ...streamInput,
              messages: [
                ...streamInput.messages,
                {
                  role: "user" as const,
                  content: `<system-directive source="${directive.source}">\n${directive.text}\n</system-directive>`,
                },
              ],
            }
          }
        }
        // altimate_change end
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            if (snapshot === undefined) {
              // altimate_change — upstream_fix: capture the pre-tool snapshot
              // before the LLM stream can execute provider-side tools.
              snapshot = await Snapshot.track()
            }
            // altimate_change start — stream with the (possibly directive-augmented) input
            const stream = await LLM.stream(effectiveStreamInput)
            // altimate_change end

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  // altimate_change start — SessionStatus.set became async in v1.4.0; await so busy state flushes
                  await SessionStatus.set(input.sessionID, { type: "busy" })
                  // altimate_change end
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: PartID.ascending(),
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

                // altimate_change start — sanitize the incoming id before it becomes the persisted callID and pairing key; braced so the consts do not leak into sibling clauses
                case "tool-input-start": {
                  const inputStartCallID = coerceToolCallID(value.id)
                  const part = await Session.updatePart({
                    id: toolcalls.get(inputStartCallID)?.id ?? PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: inputStartCallID,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls.set(inputStartCallID, part as MessageV2.ToolPart)
                  break
                }
                // altimate_change end

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  // altimate_change start — resolve the pair via the coerced id
                  const toolCallCallID = coerceToolCallID(value.toolCallId)
                  const match = toolcalls.get(toolCallCallID)
                  // altimate_change end
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
                      // altimate_change start — upstream_fix: preserve the provider-executed flag on the
                      // tool part's metadata. native-runtime already SKIPS local execution for
                      // provider-executed tools (they run server-side); tagging the part lets rendering/
                      // serialization distinguish them from client-executed tool calls, matching upstream.
                      metadata: value.providerExecuted
                        ? { ...value.providerMetadata, providerExecuted: true }
                        : value.providerMetadata,
                      // altimate_change end
                    })
                    // altimate_change start — key by the coerced id
                    toolcalls.set(toolCallCallID, part as MessageV2.ToolPart)
                    // altimate_change end
                    // altimate_change start — session has now tool-called; suppresses plan refusal warning
                    sessionToolCallsMade++
                    // altimate_change end

                    // altimate_change start — doom-loop guard re-keyed + escalation ladder.
                    // Interactive sessions keep the existing (toolName + identical args)
                    // permission ask EXACTLY as before. Run mode with the ladder ARMED
                    // replaces the permission channel with the ladder below (nudge →
                    // forced status-check → stop; never straight to stop). Run mode with
                    // the ladder NOT armed (default annotate mode) KEEPS the legacy ask:
                    // yolo auto-approves it (no-op there), but a non-yolo headless run
                    // auto-rejects it — the hard brake that previously converted an
                    // identical-args loop into a stop, which must not regress to
                    // telemetry-only during the annotate validation period.
                    if (!runMode || !sbArmed) {
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
                      }
                    }
                    // altimate_change end

                    // altimate_change start — per-tool repeat counter, DEMOTED to telemetry only.
                    // The per-NAME counter (30 calls of any kind per tool) was crossed by
                    // legitimate multi-step work — attaching any hard consequence to it would
                    // kill ~half of legitimate work. It remains as telemetry; consequences
                    // hang off the (toolName + normalized args) ladder below instead.
                    toolCallCounts.set(value.toolName, (toolCallCounts.get(value.toolName) ?? 0) + 1)
                    if ((toolCallCounts.get(value.toolName) ?? 0) >= TOOL_REPEAT_THRESHOLD) {
                      Telemetry.track({
                        type: "doom_loop_detected",
                        timestamp: Date.now(),
                        session_id: input.sessionID,
                        tool_name: value.toolName,
                        repeat_count: toolCallCounts.get(value.toolName) ?? 0,
                      })
                      toolCallCounts.set(value.toolName, 0)
                    }
                    // altimate_change end

                    // altimate_change start — (toolName + normalized args) escalation ladder.
                    // Polling patterns (sleep/watch/status probes) get a raised threshold
                    // inside the tracker. Annotate mode only logs would-fire events; armed
                    // run mode registers outcome-neutral directives via the nudge arbiter
                    // and hard-stops only at the ladder's final rung.
                    if (starvation) {
                      const call = starvation.onToolCall({ tool: value.toolName, input: value.input })
                      if (call.doomLoop) {
                        const wouldStop = call.doomLoop.escalation === "stop"
                        Telemetry.track({
                          type: "starvation_breaker",
                          timestamp: Date.now(),
                          session_id: input.sessionID,
                          mode: sbMode,
                          kind: "doom_loop",
                          action: sbArmed ? (wouldStop ? "stop" : "registered") : "would_fire",
                          tool_name: value.toolName,
                          count: call.doomLoop.count,
                          escalation: call.doomLoop.escalation,
                        })
                        log.warn("doom-loop ladder rung crossed", {
                          sessionID: input.sessionID,
                          tool: value.toolName,
                          count: call.doomLoop.count,
                          escalation: call.doomLoop.escalation,
                          armed: sbArmed,
                        })
                        if (sbArmed) {
                          if (wouldStop) {
                            starvationStop = true
                            await Session.updatePart({
                              id: PartID.ascending(),
                              messageID: input.assistantMessage.id,
                              sessionID: input.assistantMessage.sessionID,
                              type: "text",
                              synthetic: true,
                              text:
                                `altimate-code: stopping — the same \`${value.toolName}\` call with identical ` +
                                `arguments was repeated ${call.doomLoop.count} times despite a nudge and a ` +
                                `forced status-check (doom-loop escalation ladder, run mode).`,
                              time: { start: Date.now(), end: Date.now() },
                            })
                          } else {
                            NudgeArbiter.register(input.sessionID, {
                              source: "starvation_breaker",
                              kind: call.doomLoop.escalation === "nudge" ? "doom_loop_nudge" : "doom_loop_status_check",
                              text: call.doomLoop.directive,
                            })
                          }
                        }
                      }
                    }
                    // altimate_change end
                  }
                  break
                }
                case "tool-result": {
                  // altimate_change start — resolve the pair via the coerced id
                  const toolResultCallID = coerceToolCallID(value.toolCallId)
                  const match = toolcalls.get(toolResultCallID)
                  // altimate_change end
                  if (match && match.state.status === "running") {
                    // altimate_change start — unchanged-read annotation (content hash
                    // at read time; annotate, NEVER suppress — generated paths exempt) and
                    // repeat-signature loop detection on successful results. The annotation
                    // is appended to the persisted output in run mode only (interactive
                    // sessions get a telemetry-only shadow); the loop directive is
                    // arbiter-registered only when armed (run mode).
                    let toolResultOutput = value.output.output
                    if (starvation) {
                      const resultInput = value.input ?? match.state.input
                      const touched = (resultInput as any)?.filePath
                      const outcome = starvation.onToolResult({
                        tool: match.tool,
                        input: resultInput,
                        output: typeof toolResultOutput === "string" ? toolResultOutput : undefined,
                        touchedFiles: typeof touched === "string" ? [touched] : undefined,
                      })
                      if (outcome.readAnnotation && typeof toolResultOutput === "string") {
                        // Persisted-output mutation is run-mode-only: interactive
                        // (TUI/serve) sessions keep tool output byte-identical and
                        // get a telemetry-only shadow event instead.
                        toolResultOutput = SessionStarvation.applyReadAnnotation(
                          toolResultOutput,
                          outcome.readAnnotation,
                          runMode,
                        )
                        Telemetry.track({
                          type: "starvation_breaker",
                          timestamp: Date.now(),
                          session_id: input.sessionID,
                          mode: sbMode,
                          kind: "unchanged_read",
                          action: runMode ? "annotated" : "would_annotate",
                          tool_name: match.tool,
                        })
                      }
                      if (outcome.repeatLoop) {
                        Telemetry.track({
                          type: "starvation_breaker",
                          timestamp: Date.now(),
                          session_id: input.sessionID,
                          mode: sbMode,
                          kind: "repeat_signature",
                          action: sbArmed ? "registered" : "would_fire",
                          tool_name: match.tool,
                          count: outcome.repeatLoop.count,
                        })
                        if (sbArmed) {
                          NudgeArbiter.register(input.sessionID, {
                            source: "starvation_breaker",
                            kind: "repeat_signature",
                            text: outcome.repeatLoop.directive,
                          })
                        }
                      }
                    }
                    // altimate_change end
                    // altimate_change start — hard per-result dispatch cap. Every
                    // completed tool result is bounded here regardless of which tool
                    // path produced it — the tool-level truncation service can be
                    // bypassed, and one uncapped result overflows the whole window.
                    if (typeof toolResultOutput === "string") {
                      const capped = ToolResultCap.apply(toolResultOutput, toolResultCapTokens)
                      if (capped.truncated) {
                        toolResultOutput = capped.content
                        log.info("tool result capped at dispatch", {
                          tool: match.tool,
                          capTokens: toolResultCapTokens,
                        })
                      }
                    }
                    // altimate_change end
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        // altimate_change start — annotated output (append-only)
                        output: toolResultOutput,
                        // altimate_change end
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    // altimate_change start — delete by the coerced id
                    toolcalls.delete(toolResultCallID)
                    // altimate_change end
                  }
                  break
                }

                case "tool-error": {
                  // altimate_change start — resolve the pair via the coerced id
                  const toolErrorCallID = coerceToolCallID(value.toolCallId)
                  const match = toolcalls.get(toolErrorCallID)
                  // altimate_change end
                  if (match && match.state.status === "running") {
                    // altimate_change start — repeat-signature loop detection on
                    // failures — hash(tool + normalized args + touched files + failure
                    // message). Catches edit-verify-fail-revert-reedit loops that mutate
                    // files every turn but make no progress.
                    if (starvation) {
                      const errorInput = value.input ?? match.state.input
                      const touched = (errorInput as any)?.filePath
                      const outcome = starvation.onToolResult({
                        tool: match.tool,
                        input: errorInput,
                        failureMessage: (value.error as any)?.toString?.() ?? String(value.error),
                        touchedFiles: typeof touched === "string" ? [touched] : undefined,
                      })
                      if (outcome.repeatLoop) {
                        Telemetry.track({
                          type: "starvation_breaker",
                          timestamp: Date.now(),
                          session_id: input.sessionID,
                          mode: sbMode,
                          kind: "repeat_signature",
                          action: sbArmed ? "registered" : "would_fire",
                          tool_name: match.tool,
                          count: outcome.repeatLoop.count,
                        })
                        if (sbArmed) {
                          NudgeArbiter.register(input.sessionID, {
                            source: "starvation_breaker",
                            kind: "repeat_signature",
                            text: outcome.repeatLoop.directive,
                          })
                        }
                      }
                    }
                    // altimate_change end
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    // altimate_change start — delete by the coerced id
                    toolcalls.delete(toolErrorCallID)
                    // altimate_change end
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  if (snapshot === undefined) snapshot = await Snapshot.track()
                  // altimate_change start — record step start time for generation telemetry duration
                  stepStartTime = Date.now()
                  // altimate_change end
                  await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step": {
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  if (value.finishReason === "content-filter") {
                    // altimate_change start — upstream_fix: content-filter
                    // finishes are session errors, not successful stops.
                    input.assistantMessage.error = new MessageV2.ContentFilterError({
                      message: "The response was blocked by the provider's content filter",
                    }).toObject()
                    await Bus.publish(Session.Event.Error, {
                      sessionID: input.assistantMessage.sessionID,
                      error: input.assistantMessage.error,
                    })
                    // altimate_change end
                  }
                  // altimate_change start — emit per-generation telemetry with token breakdown
                  // Optional fields are only included when the provider actually returns them.
                  Telemetry.track({
                    type: "generation",
                    timestamp: Date.now(),
                    session_id: input.sessionID,
                    message_id: input.assistantMessage.id,
                    model_id: input.model.id,
                    provider_id: input.model.providerID,
                    agent: input.assistantMessage.agent,
                    finish_reason: value.finishReason ?? "unknown",
                    cost: usage.cost,
                    duration_ms: Date.now() - stepStartTime,
                    tokens_input: usage.tokens.input,
                    tokens_output: usage.tokens.output,
                    // altimate_change start — always emit tokens_input_total so dashboard
                    // queries can rely on it without null-handling. Pre-2026-05-22 this
                    // was conditional on `inputTotal !== input` to save 12 bytes per event,
                    // but the absent field looked like a bug in queries that didn't know
                    // to coalesce — the false-positive "Anthropic tokens_input=0 broken"
                    // finding in telemetry-2026-05-21 was driven by this. See the comment
                    // block on the `generation` event type in telemetry/index.ts for the
                    // canonical semantics. Cost: ~12 bytes × generations/day, negligible.
                    tokens_input_total: usage.tokens.inputTotal,
                    // altimate_change end
                    ...(value.usage.reasoningTokens !== undefined && { tokens_reasoning: usage.tokens.reasoning }),
                    ...(value.usage.cachedInputTokens !== undefined && { tokens_cache_read: usage.tokens.cache.read }),
                    ...(usage.tokens.cache.write > 0 && { tokens_cache_write: usage.tokens.cache.write }),
                  })
                  // altimate_change end
                  // altimate_change start — detect plan-agent tool-call refusal
                  // A plan-agent step that ends with finish=stop and NO tool calls
                  // (ever) in the session means the model wrote text and gave up.
                  // Users read the text, see no progress, and abandon. Surface a
                  // warning + telemetry so the pattern is measurable and the user
                  // knows to try a different model.
                  //
                  // sessionToolCallsMade tracks tool calls in the CURRENT step only
                  // — SessionProcessor.create() is called per-step by loop() (see
                  // prompt.ts), so the closure variable resets each step. A multi-
                  // step plan-mode session (read → grep → read → … → final text)
                  // would then false-positive on the final text-only step. Also
                  // scan streamInput.messages for any prior assistant tool-call
                  // content; if found, the session has used tools and the warning
                  // should be suppressed.
                  const sessionHasPriorToolCalls =
                    sessionToolCallsMade > 0 ||
                    streamInput.messages.some(
                      (m) =>
                        m.role === "assistant" &&
                        Array.isArray(m.content) &&
                        m.content.some((p) => p.type === "tool-call"),
                    )
                  if (
                    input.assistantMessage.agent === "plan" &&
                    value.finishReason === "stop" &&
                    !sessionHasPriorToolCalls &&
                    !planNoToolWarningEmitted
                  ) {
                    planNoToolWarningEmitted = true
                    Telemetry.track({
                      type: "plan_no_tool_generation",
                      timestamp: Date.now(),
                      session_id: input.sessionID,
                      message_id: input.assistantMessage.id,
                      model_id: input.model.id,
                      provider_id: input.model.providerID,
                      finish_reason: value.finishReason,
                      tokens_output: usage.tokens.output,
                    })
                    log.warn("plan agent stopped without tool calls — model may not be tool-calling properly", {
                      sessionID: input.sessionID,
                      modelID: input.model.id,
                      providerID: input.model.providerID,
                      tokensOutput: usage.tokens.output,
                    })
                    // synthetic: true so this warning is shown in the TUI but
                    // excluded when the transcript is replayed to the LLM next turn
                    // (prompt.ts filters synthetic text parts — see lines 648, 795).
                    await Session.updatePart({
                      id: PartID.ascending(),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "text",
                      synthetic: true,
                      text:
                        `⚠️ altimate-code: the \`plan\` agent on \`${input.model.providerID}/${input.model.id}\` ` +
                        `stopped without calling any tools — it neither read, searched, nor explored the codebase. ` +
                        `Common causes: (a) the model wrote a plan from prompt context alone, (b) the model declined ` +
                        `to engage with the request (content-policy refusal), or (c) the request may need more detail. ` +
                        `To recover, try one of: reply asking it to investigate first (\`read\`/\`grep\`/\`glob\`/\`explore\`); ` +
                        `rephrase the request more concretely; or, if it keeps refusing, \`/model\` to a tier that's more ` +
                        `eager to explore (e.g. Claude Sonnet/Opus).`,
                      time: { start: Date.now(), end: Date.now() },
                    })
                  }
                  // altimate_change end
                  await Session.updatePart({
                    id: PartID.ascending(),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  // altimate_change start — capture the snapshot diff as the generic,
                  // command-agnostic mutation ground truth (also catches bash-mediated
                  // writes like `sed -i`/heredocs, which emit no edit event).
                  let stepPatchFiles: string[] = []
                  // altimate_change end
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    // altimate_change start
                    stepPatchFiles = [...patch.files]
                    // altimate_change end
                    snapshot = undefined
                  }
                  // altimate_change start — per-step write-starvation evaluation.
                  // Annotate mode only logs a would-fire event; armed run mode registers
                  // the outcome-neutral directive (with its DONE alternative) via the
                  // nudge arbiter for delivery on the next generation.
                  if (starvation) {
                    const stepOutcome = starvation.onStepFinish({ mutatedFiles: stepPatchFiles })
                    if (stepOutcome.starvation) {
                      Telemetry.track({
                        type: "starvation_breaker",
                        timestamp: Date.now(),
                        session_id: input.sessionID,
                        mode: sbMode,
                        kind: "starvation",
                        action: sbArmed ? "registered" : "would_fire",
                        turns_without_mutation: stepOutcome.turnsWithoutMutation,
                      })
                      log.warn("write-starvation breaker", {
                        sessionID: input.sessionID,
                        turnsWithoutMutation: stepOutcome.turnsWithoutMutation,
                        armed: sbArmed,
                      })
                      if (sbArmed) {
                        NudgeArbiter.register(input.sessionID, {
                          source: "starvation_breaker",
                          kind: "starvation",
                          text: stepOutcome.starvation.directive,
                        })
                      }
                    }
                  }
                  // altimate_change end
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (
                    !input.assistantMessage.summary &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    needsCompaction = true
                  }
                  break
                }

                case "text-start":
                  currentText = {
                    id: PartID.ascending(),
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
                      start: currentText.time?.start ?? Date.now(),
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
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              if ((await Config.get()).compaction?.auto === false && !input.assistantMessage.summary) {
                // altimate_change start — upstream_fix: honor
                // compaction.auto=false on reactive provider overflow.
                input.assistantMessage.error = error
                input.assistantMessage.finish = "error"
                await Bus.publish(Session.Event.Error, {
                  sessionID: input.sessionID,
                  error,
                })
                await SessionStatus.set(input.sessionID, { type: "idle" })
                // altimate_change end
              } else {
                needsCompaction = true
                Bus.publish(Session.Event.Error, {
                  sessionID: input.sessionID,
                  error,
                })
              }
            } else {
              const retry = SessionRetry.retryable(error)
              // altimate_change start — cap retries to avoid infinite loops, log on exhaustion
              if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
                // altimate_change end
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                // altimate_change start — SessionStatus.set became async in v1.4.0; await so retry state flushes before sleep
                await SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                // altimate_change end
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              // altimate_change start — log when retries exhausted for debugging
              if (retry !== undefined) {
                log.warn("max retry attempts reached, giving up", {
                  attempt,
                  message: retry,
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                })
              }
              // altimate_change end
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              // altimate_change start — telemetry for unhandled streaming errors (non-retry, non-overflow)
              // Covers: MessageAbortedError (Stop/dispose), UnknownError (SSE chunk timeout),
              // APIError (provider failures after retry exhaustion), AuthError, and any other streaming error.
              Telemetry.track({
                type: "error",
                timestamp: Date.now(),
                session_id: input.assistantMessage.sessionID,
                error_name: error.name,
                error_message: (error.data as any)?.message ?? String((e as any)?.message ?? ""),
                context: "streaming",
              })
              // altimate_change end
              // altimate_change start — SessionStatus.set became async; await so idle state flushes before exit
              await SessionStatus.set(input.sessionID, { type: "idle" })
              // altimate_change end
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: PartID.ascending(),
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
              // altimate_change start — upstream_fix: mark aborted tools so partial output is replayed correctly.
              const metadata =
                part.state.status === "running" ? { ...part.state.metadata, interrupted: true } : { interrupted: true }
              // altimate_change end
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  // altimate_change start — upstream_fix: preserve running tool metadata, including shell partial output.
                  metadata,
                  // altimate_change end
                  time: {
                    // altimate_change start — upstream_fix: keep the original running start time on abort.
                    start: part.state.status === "running" ? part.state.time.start : Date.now(),
                    // altimate_change end
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          // altimate_change start — explicit model DONE is the PRIMARY
          // termination path. A turn that finished with "stop", has no error, and
          // asserts completion (trailing DONE token per the SessionTermination
          // contract) terminates the session EVEN IF overflow was detected.
          // Returning "compact" here is the termination-impossibility triangle:
          // the finished session gets summarized and the post-compaction continue
          // message breeds further turns. Deferring compaction is safe in every
          // mode — prompt.ts's pre-dispatch overflow check compacts before the
          // next request. Never bare finishReason "stop" (that ends nearly every
          // ordinary text turn), and never for the compaction summarizer itself.
          if (
            needsCompaction &&
            !input.assistantMessage.summary &&
            SessionTermination.explicitDoneStop({
              finish: input.assistantMessage.finish,
              hasError: input.assistantMessage.error !== undefined,
              parts: p,
            })
          ) {
            log.info("explicit DONE with pending compaction — terminating instead of compacting", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
            return "stop"
          }
          // altimate_change end
          // altimate_change start — terminal outcomes take precedence over
          // "compact": a blocked/errored/doom-loop-stopped turn must actually
          // stop. Returning "compact" first made those stops no-ops under
          // overflow — the session summarized and kept running. Deferring the
          // compaction is safe: prompt.ts's pre-dispatch overflow check compacts
          // before any next request. (Explicit DONE above still overrides
          // compaction the same way.)
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          // Doom-loop escalation ladder final rung. Reachable only when mode is
          // "armed" AND the process is in run mode (never TUI/serve) AND the
          // same (toolName + normalized args) call repeated through nudge and
          // forced status-check without changing.
          if (starvationStop) return "stop"
          // Upstream's compact check, relocated below the terminal outcomes.
          if (needsCompaction) return "compact"
          // altimate_change end
          return "continue"
        }
      },
    }
    return result
  }

  // altimate_change start — Effect Context.Service facade (delegates to the namespace `create` above)
  // Upstream's Effect-shaped processor handle, referenced by session/tools.ts and the
  // processor effect tests. Pure type — the fork's imperative `create()` Promise wrappers
  // are unaffected; consumers pick/construct from this type independently.
  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly updateToolCall: (
      toolCallID: string,
      update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
    ) => Effect.Effect<MessageV2.ToolPart | undefined>
    readonly completeToolCall: (
      toolCallID: string,
      output: {
        title: string
        metadata: Record<string, any>
        output: string
        attachments?: MessageV2.FilePart[]
      },
    ) => Effect.Effect<void>
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  type CreateInput = Parameters<typeof create>[0]

  export interface Interface {
    readonly create: (input: CreateInput) => Effect.Effect<Info>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      create: (input: CreateInput) => Effect.sync(() => create(input)),
    }),
  )

  export const defaultLayer = layer

  export const node = LayerNode.make(layer, [])
  // altimate_change end
}

import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
// altimate_change start — shared family→vendor classifier (#888 J1)
import { familyVendor } from "../provider/family"
// altimate_change end
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { MemoryPrompt } from "../memory/prompt"
import { UNIFIED_INJECTION_BUDGET } from "../memory/types"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $ } from "bun"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { decodeDataUrl } from "@/util/data-url"
// altimate_change start - import fingerprint for env-based skill selection
import { Fingerprint } from "../altimate/fingerprint"
// altimate_change end

// altimate_change start - validator framework (see session/validators/types.ts header)
import { ValidatorRegistry } from "./validators/registry"
import { registerAltimateValidators } from "../altimate/validators"
// Explicit registration call (not a side-effect import) so bun's --single
// bundler cannot tree-shake the validator registrations.
registerAltimateValidators()
import { Config } from "../config/config"
import { Tracer } from "../altimate/observability/tracing"
// altimate_change end
import { Telemetry } from "@/telemetry" // altimate_change — session telemetry

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  // altimate_change start — single source of truth for legacy agent-name normalization
  //
  // The "build" agent was renamed to "builder" but some persisted sessions and
  // the plan-exit synthetic message historically wrote `agent: "build"`. Agent.get()
  // applies an alias so execution still works, but every telemetry event with an
  // `agent` field needs to project to the canonical name or dashboards see a
  // phantom "build" bucket alongside "builder". This helper is the single place
  // that normalization lives — used by both session_start and agent_outcome
  // emits below so they can never drift. Future telemetry events with an `agent`
  // field should route through this helper too.
  function normalizeAgentName(name: string | undefined): string {
    // Defence-in-depth before the legacy-name compare:
    //   1. Strip C0 control characters (\x00-\x1f) — neutralizes log-injection
    //      via embedded newlines/CRs that would split the telemetry field into
    //      two fake events on App Insights.
    //   2. Unicode-normalize (NFKC) — collapses visually-identical homoglyphs
    //      so "ｂｕｉｌｄｅｒ" (fullwidth) doesn't create a separate bucket.
    //   3. Cap at 64 chars — agent names should be slugs; anything larger is
    //      a cardinality bomb or an injection vector. The agent registry's
    //      longest legitimate name is well under this cap.
    if (!name) return "builder"
    const cleaned = name
      .replace(/[\x00-\x1f\x7f]/g, "")
      .normalize("NFKC")
      .slice(0, 64)
    // Case-insensitive legacy-name guard: a future config, custom prompt, or
    // hand-edited persisted session could surface "Build"/"BUILD" and the
    // phantom telemetry bucket would come back.
    if (!cleaned || cleaned.toLowerCase() === "build") return "builder"
    return cleaned
  }
  // altimate_change end

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: SessionID) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (input.noReply === true) {
      return message
    }

    return loop({ sessionID: input.sessionID })
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: SessionID) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  function resume(sessionID: SessionID) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  // altimate_change start — SessionStatus.set became async in v1.4.0; await so idle state actually flushes
  export async function cancel(sessionID: SessionID) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      // Session already ended or was never started — set idle directly since no processor will do it
      await SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort()
    delete s[sessionID]
    // Do NOT set idle status here — on abort the processor's catch block
    // publishes session.error THEN sets idle, preserving correct event ordering.
    // On normal completion, loop() sets idle after the while loop exits (see below).
  }
  // altimate_change end

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    resume_existing: z.boolean().optional(),
  })
  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input

    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    // altimate_change start — cancel() became async (SessionStatus.set is async); use `await using` for async dispose
    await using _ = defer(() => cancel(sessionID))
    // altimate_change end

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    let step = 0
    const session = await Session.get(sessionID)
    // altimate_change start - detect environment fingerprint at session start
    const altCfg = await Config.get()
    if (altCfg.experimental?.env_fingerprint_skill_selection === true) {
      await Fingerprint.detect(Instance.directory, Instance.worktree).catch((e) => {
        log.warn("fingerprint detection failed", { error: e })
      })
    }
    // altimate_change end
    // altimate_change start — session telemetry tracking
    await Telemetry.init()
    Telemetry.setContext({ sessionId: sessionID, projectId: Instance.project?.id ?? "" })
    const sessionStartTime = Date.now()
    let sessionTotalCost = 0
    let sessionTotalTokens = 0
    let toolCallCount = 0
    let compactionCount = 0
    // altimate_change start — validator framework retry counter
    let validatorRetryCount = 0
    // altimate_change end
    let sessionAgentName = ""
    let sessionHadError = false
    // altimate_change start — plan refinement tracking
    let planRevisionCount = 0
    let planHasWritten = false
    let planLastUserMsgId: string | undefined
    // altimate_change end
    let emergencySessionEndFired = false
    // altimate_change start — quality signal, tool chain, error fingerprint tracking
    let lastToolCategory = ""
    // altimate_change start — agent_outcome diagnostic tracking
    let lastToolName = ""
    let lastMessageError = ""
    // altimate_change end
    const toolChain: string[] = []
    let toolErrorCount = 0
    let errorRecoveryCount = 0
    let lastToolWasError = false
    interface ErrorRecord {
      toolName: string
      toolCategory: string
      errorClass: string
      errorHash: string
      recovered: boolean
      recoveryTool: string
    }
    const errorRecords: ErrorRecord[] = []
    let pendingError: Omit<ErrorRecord, "recovered" | "recoveryTool"> | null = null
    // altimate_change end
    const emergencySessionEnd = () => {
      if (emergencySessionEndFired) return
      emergencySessionEndFired = true
      Telemetry.track({
        type: "session_end",
        timestamp: Date.now(),
        session_id: sessionID,
        total_cost: sessionTotalCost,
        total_tokens: sessionTotalTokens,
        tool_call_count: toolCallCount,
        duration_ms: Date.now() - sessionStartTime,
      })
    }
    process.once("beforeExit", emergencySessionEnd)
    process.once("exit", emergencySessionEnd)
    // altimate_change end
    // altimate_change start — refresh MCP tools on ToolsChanged event
    // When a datamate MCP server reconnects (transport change, window restart),
    // MCP.ToolsChanged is published. MCP.tools() already uses a per-client cache
    // that is invalidated by the notification handler that publishes this event,
    // so the next resolveTools() call (once per LLM turn) naturally picks up fresh
    // tools without any extra work here. This subscription makes the session layer
    // explicitly aware of the reconnect and logs it so it is traceable in prod.
    const unsubscribeToolsChanged = Bus.subscribe(MCP.ToolsChanged, (event) => {
      log.info("MCP.ToolsChanged received — tools will refresh on next turn", {
        server: event.properties.server,
        sessionID,
      })
    })
    using _unsubToolsChanged = defer(unsubscribeToolsChanged)
    // altimate_change end
    while (true) {
      // altimate_change start — SessionStatus.set became async in v1.4.0; await so busy state flushes before LLM call
      await SessionStatus.set(sessionID, { type: "busy" })
      // altimate_change end
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      // altimate_change start — always track the current agent name so early breaks still report it
      if (lastUser.agent) sessionAgentName = lastUser.agent
      // altimate_change end
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            part = (await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
            args: taskArgs,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        // altimate_change start — count subtask tool calls in session metrics
        toolCallCount++
        // altimate_change end
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: "metadata" in part.state ? part.state.metadata : undefined,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          overflow: task.overflow,
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      // altimate_change start — insertReminders returns the trusted reminder parts
      // it appended. The function now also pre-applies `ignored: true` to those
      // parts (and to the persisted rows under experimental plan mode) for
      // non-Anthropic-like models, so `toModelMessages` skips them on every turn
      // — not just this one (#888 J2). The returned-parts list is the trust
      // boundary; we never infer trust from the `synthetic` flag (other code
      // paths set it on user-derived file/resource expansions). See #887/#888.
      const reminderResult = await insertReminders({
        messages: msgs,
        agent,
        session,
        model,
      })
      msgs = reminderResult.messages
      const hoistedReminders = isAnthropicLikeModel(model)
        ? []
        : reminderResult.trustedReminderParts.map((p) => p.text)
      // altimate_change end

      // altimate_change start — plan refinement detection and telemetry
      if (agent.name === "plan") {
        // Check if plan file has been written in a previous step
        if (!planHasWritten) {
          const planPath = Session.plan(session)
          planHasWritten = await Filesystem.exists(planPath)
        }
        // If plan was already written and user sent a new message, this is a refinement.
        // Only count once per user message (not on internal loop iterations).
        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        const currentUserMsgId = lastUserMsg?.info.id
        if (planHasWritten && step > 1 && currentUserMsgId && currentUserMsgId !== planLastUserMsgId) {
          planLastUserMsgId = currentUserMsgId
          const userText =
            lastUserMsg?.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text" && !("synthetic" in p && p.synthetic))
              .map((p) => p.text.toLowerCase())
              .join(" ") ?? ""

          if (planRevisionCount >= 5) {
            // Cap reached — track and inject a synthetic hint so the LLM informs the user
            Telemetry.track({
              type: "plan_revision",
              timestamp: Date.now(),
              session_id: sessionID,
              revision_number: planRevisionCount,
              action: "cap_reached",
            })
            // Append a synthetic text part to the last user message in the local msgs copy
            // so the LLM sees the limit and can communicate it. This does not persist.
            if (lastUserMsg) {
              lastUserMsg.parts = [
                ...lastUserMsg.parts,
                {
                  type: "text" as const,
                  id: PartID.ascending(),
                  sessionID,
                  messageID: lastUserMsg.info.id,
                  text: "\n\n[System note: This plan has reached the maximum revision limit (5). Please inform the user and suggest finalizing the plan or starting a new planning session.]",
                  synthetic: true,
                },
              ]
            }
          } else {
            planRevisionCount++

            // Refinement qualifiers: if the user says "yes, but ..." or "approve, however ..."
            // they intend to refine, not approve. Check for these before pure approval.
            const refinementQualifiers = [
              " but ",
              " however ",
              " except ",
              " change ",
              " modify ",
              " update ",
              " instead ",
              " although ",
              " with the following",
              " with these",
            ]
            const hasRefinementQualifier = refinementQualifiers.some((q) => userText.includes(q))

            const rejectionPhrases = [
              "don't",
              "stop",
              "reject",
              "not good",
              "not approve",
              "not approved",
              "disapprove",
              "undo",
              "abort",
              "start over",
              "wrong",
            ]
            // "no" as a standalone word to avoid matching "know", "notion", etc.
            const rejectionWords = ["no"]
            const approvalPhrases = [
              "looks good",
              "proceed",
              "approved",
              "approve",
              "lgtm",
              "go ahead",
              "ship it",
              "yes",
              "perfect",
            ]

            const isRejectionPhrase = rejectionPhrases.some((phrase) => userText.includes(phrase))
            const isRejectionWord = rejectionWords.some((word) => {
              const regex = new RegExp(`\\b${word}\\b`)
              return regex.test(userText)
            })
            const isRejection = isRejectionPhrase || isRejectionWord
            // Use word-boundary matching for approval phrases to avoid false positives
            // e.g. "this doesn't look good" should NOT match "looks good"
            const isApproval =
              !isRejection &&
              !hasRefinementQualifier &&
              approvalPhrases.some((phrase) => {
                const regex = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i")
                return regex.test(userText)
              })
            const action = isRejection ? "reject" : isApproval ? "approve" : "refine"
            Telemetry.track({
              type: "plan_revision",
              timestamp: Date.now(),
              session_id: sessionID,
              revision_number: planRevisionCount,
              action,
            })
          }
        }
      }
      // altimate_change end

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

      // Inject StructuredOutput tool if JSON schema mode enabled
      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        // altimate_change start - reset training session tracking to avoid stale applied counts
        MemoryPrompt.resetSession()
        // altimate_change end
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
        // altimate_change start — session start telemetry
        // Agent name routed through normalizeAgentName so session_start and the
        // downstream agent_outcome event always agree on the canonical bucket
        // (funnel analysis from start → outcome would otherwise drop legacy
        // "build" sessions). See the helper at the top of this namespace.
        Telemetry.track({
          type: "session_start",
          timestamp: Date.now(),
          session_id: sessionID,
          model_id: model.id,
          provider_id: model.providerID,
          agent: normalizeAgentName(lastUser.agent),
          project_id: Instance.project?.id ?? "",
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
        })
        // altimate_change start — task intent classification (keyword/regex, zero LLM cost)
        const userMsg = msgs.find((m) => m.info.id === lastUser!.id)
        if (userMsg) {
          const userText = userMsg.parts
            .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic)
            .map((p) => p.text)
            .join("\n")
          if (userText.length > 0) {
            const { intent, confidence } = Telemetry.classifyTaskIntent(userText)
            const fp = Fingerprint.get()
            const warehouseType =
              fp?.tags.find((t) =>
                [
                  "snowflake",
                  "bigquery",
                  "redshift",
                  "databricks",
                  "postgres",
                  "mysql",
                  "sqlite",
                  "duckdb",
                  "trino",
                  "spark",
                  "clickhouse",
                ].includes(t),
              ) ?? "unknown"
            Telemetry.track({
              type: "task_classified",
              timestamp: Date.now(),
              session_id: sessionID,
              intent: intent as any,
              confidence,
              warehouse_type: warehouseType,
            })
          }
        }
        // altimate_change end — task intent classification
        // altimate_change end — session start telemetry
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // altimate_change start — upstream_fix: carry the date in the trailing user message
      // so it stays out of the long-lived, cache-controlled system prefix (see
      // session/system.ts). It lands on the rolling last-user-turn cacheControl breakpoint,
      // which applyCaching() rewrites every turn regardless — so steady-state cache cost is
      // unchanged; we only stop midnight from busting the expensive system-prefix cache.
      const lastUserForDate = msgs.findLast((m) => m.info.role === "user")
      if (lastUserForDate) {
        lastUserForDate.parts = [
          ...lastUserForDate.parts,
          {
            type: "text" as const,
            id: PartID.ascending(),
            sessionID,
            messageID: lastUserForDate.info.id,
            text: `\n\n${SystemPrompt.currentDate()}`,
            synthetic: true,
          },
        ]
      }
      // altimate_change end

      // Build system prompt, adding structured output instruction if needed
      const skills = await SystemPrompt.skills(agent)
      // altimate_change start - unified context-aware injection for memory + training
      const knowledgeInjection = Flag.ALTIMATE_DISABLE_MEMORY
        ? ""
        : await MemoryPrompt.inject(UNIFIED_INJECTION_BUDGET, {
            agent: agent.name,
            disableTraining: Flag.ALTIMATE_DISABLE_TRAINING,
          })
      // altimate_change end
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(skills ? [skills] : []),
        ...(knowledgeInjection ? [knowledgeInjection] : []),
        ...(await InstructionPrompt.system()),
        ...hoistedReminders,
      ]
      const format = lastUser.format ?? { type: "text" }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      // altimate_change start - trace system prompt once per loop() call.
      // The system prompt is functionally identical across steps within a single
      // loop() invocation (same agent, same environment). Agent switches re-enter
      // loop() with step reset to 0, so each agent's prompt is traced separately.
      if (step === 1) {
        Tracer.active?.logSpan({
          name: "system-prompt",
          startTime: Date.now(),
          endTime: Date.now(),
          input: { agent: agent.name, step },
          output: { parts: system.length, content: system.join("\n\n") },
        })
      }
      // altimate_change end

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: [
          ...(await MessageV2.toModelMessages(msgs, model)),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }
      }

      // altimate_change start — accumulate session metrics
      sessionTotalCost += processor.message.cost ?? 0
      const t = processor.message.tokens
      sessionTotalTokens += t.input + t.output + t.reasoning + t.cache.read + t.cache.write
      const stepParts = await MessageV2.parts(processor.message.id)
      toolCallCount += stepParts.filter((p) => p.type === "tool").length
      if (processor.message.error) sessionHadError = true
      // altimate_change start — capture last message error for agent_outcome reason
      if (processor.message.error) {
        const err = processor.message.error as any
        try {
          const name = typeof err?.name === "string" ? err.name : "unknown"
          const rawMessage = typeof err?.data?.message === "string" ? err.data.message : ""
          const masked = rawMessage ? Telemetry.maskString(rawMessage).slice(0, 300) : ""
          lastMessageError = masked ? `${name}: ${masked}` : String(name)
        } catch {
          lastMessageError = "unknown"
        }
      }
      // altimate_change end
      // altimate_change start — quality signal + tool chain + error fingerprints
      const toolParts = stepParts.filter((p) => p.type === "tool")
      for (const part of toolParts) {
        if (part.type !== "tool") continue
        const toolType = part.tool.startsWith("mcp__") ? ("mcp" as const) : ("standard" as const)
        const toolCategory = Telemetry.categorizeToolName(part.tool, toolType)
        lastToolCategory = toolCategory
        // altimate_change start — track last tool name for agent_outcome diagnostics
        lastToolName = part.tool
        // altimate_change end
        if (toolChain.length < 50) toolChain.push(part.tool)
        const isError = part.state?.status === "error"
        if (isError) {
          toolErrorCount++
          // Flush previous unrecovered error before recording new one
          if (pendingError) {
            if (errorRecords.length < 200) errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
          }
          lastToolWasError = true
          const errorMsg =
            part.state.status === "error" && typeof part.state.error === "string" ? part.state.error : "unknown"
          const masked = Telemetry.maskString(errorMsg).slice(0, 500)
          pendingError = {
            toolName: part.tool,
            toolCategory,
            errorClass: Telemetry.classifyError(errorMsg),
            errorHash: Telemetry.hashError(masked),
          }
        } else {
          if (lastToolWasError && pendingError) {
            errorRecoveryCount++
            if (errorRecords.length < 200)
              errorRecords.push({ ...pendingError, recovered: true, recoveryTool: part.tool })
            pendingError = null
          }
          lastToolWasError = false
        }
      }
      // Flush unrecovered error at end of step
      if (pendingError && !lastToolWasError) {
        errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
        pendingError = null
      }
      // altimate_change end — quality signal + tool chain + error fingerprints
      // altimate_change end — accumulate session metrics

      // altimate_change start — detect plan file creation after tool calls
      if (agent.name === "plan" && !planHasWritten) {
        const planPath = Session.plan(session)
        planHasWritten = await Filesystem.exists(planPath)
      }
      // altimate_change end

      // altimate_change start — validator dispatch (harness-side completion gate)
      // Fires when the model declares a clean stop on this step (finish === "stop"
      // and no tool calls outstanding). Runs all registered validators that
      // declare themselves applicable to this session. If any validator says
      // the work is not done, the framework injects a synthetic user message
      // describing the gap and continues the loop — the model gets one more
      // turn to fix the issue. Bounded by a per-session retry budget; once
      // exhausted the loop falls through to the natural break.
      //
      // Feature flag: ALTIMATE_VALIDATORS_ENABLED=1 opts in. Default OFF so
      // existing sessions are unaffected until validators are vetted in
      // production.
      //
      // ALTIMATE_VALIDATORS_SHADOW=1 runs validators WITHOUT enforcement so
      // telemetry can measure "would have fired" rates against historical
      // traffic, but no subprocess spawns or synthetic-message retries happen
      // unless this is also set. By default, NEITHER flag is set so
      // non-opting-in sessions skip the entire dispatch path (no fs scan,
      // no subprocess spawn, no perf tax).
      const validatorsEnabled = process.env.ALTIMATE_VALIDATORS_ENABLED === "1"
      const validatorsShadow = process.env.ALTIMATE_VALIDATORS_SHADOW === "1"
      const validatorsActive = validatorsEnabled || validatorsShadow
      const maxValidatorRetries = Number(process.env.ALTIMATE_VALIDATORS_MAX_RETRIES ?? "3")
      const validatorsDebug = process.env.ALTIMATE_VALIDATORS_DEBUG === "1"
      const validatorCount = ValidatorRegistry.list().length
      // Always emit to opencode's file log. Mirror to stderr only when
      // ALTIMATE_VALIDATORS_DEBUG=1 — needed during framework bring-up so
      // benchmark harness logs capture the hook signal, but noisy enough
      // that we keep it off by default for normal sessions.
      const diag = {
        kind: "validator_hook_reached",
        sessionID,
        step,
        result,
        finish: processor.message.finish,
        hasError: Boolean(processor.message.error),
        validatorsEnabled,
        validatorCount,
        validatorRetryCount,
      }
      log.info("validator_hook_reached", diag)
      if (validatorsDebug) {
        // eslint-disable-next-line no-console
        console.error("[altimate-validators] " + JSON.stringify(diag))
      }
      if (
        validatorsActive &&
        result !== "stop" &&
        result !== "compact" &&
        processor.message.finish === "stop" &&
        !processor.message.error &&
        validatorCount > 0
      ) {
        try {
          const vCtx = {
            sessionID,
            workingDirectory: Instance.directory,
            sessionStartMs: sessionStartTime,
            step,
            retryCount: validatorRetryCount,
          }
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({ kind: "dispatch_enter", sessionID, step, cwd: vCtx.workingDirectory, sessionStartMs: vCtx.sessionStartMs }),
            )
          }
          const checks = await ValidatorRegistry.runAll(vCtx)
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({
                  kind: "dispatch_result",
                  sessionID,
                  step,
                  checks_count: checks.length,
                  results: checks.map((c) => ({ name: c.validator.name, ok: c.result.ok, details: c.result.details })),
                }),
            )
          }
          const failures = checks.filter((c) => !c.result.ok)

          // Telemetry: emit one event per validator that ran, plus a session
          // rollup. Always emitted, even when the feature flag is off, so we
          // can measure baseline fire rate vs prompt-only enforcement.
          for (const { validator, result: vRes } of checks) {
            Telemetry.track({
              type: "validator_check",
              timestamp: Date.now(),
              session_id: sessionID,
              validator_name: validator.name,
              ok: vRes.ok,
              step,
              retry_count: validatorRetryCount,
              enforced: validatorsEnabled,
              ...(vRes.details && { details: vRes.details }),
            } as any)
          }

          if (failures.length > 0 && validatorsEnabled && validatorRetryCount < maxValidatorRetries) {
            // Build a single synthetic user-turn body that aggregates every
            // failing validator's reason + fixHint. The agent sees this as
            // the next user message and gets one more turn to address it.
            const body = failures
              .map(({ validator, result: vRes }) => {
                const head = `[altimate-validator: ${validator.name}] ${vRes.reason ?? "validation failed"}`
                const tail = vRes.fixHint ? `\n${vRes.fixHint}` : ""
                return head + tail
              })
              .join("\n\n")

            log.info("validator failures detected, injecting synthetic user turn", {
              sessionID,
              failures: failures.map((f) => f.validator.name),
              retry: validatorRetryCount + 1,
            })

            const syntheticMessageID = MessageID.ascending()
            await Session.updateMessage({
              id: syntheticMessageID,
              role: "user" as const,
              sessionID,
              time: { created: Date.now() },
              agent: lastUser.agent,
              model: lastUser.model,
            } as MessageV2.Info)

            // Append the validator body as a text part on the new user message.
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: syntheticMessageID,
              sessionID,
              type: "text",
              text: body,
              time: { start: Date.now(), end: Date.now() },
            })

            validatorRetryCount++
            continue
          } else if (failures.length > 0 && validatorsEnabled && validatorRetryCount >= maxValidatorRetries) {
            // Retry budget exhausted with outstanding failures. Session will
            // terminate on the natural break below. Emit an explicit signal so
            // the operator dashboard can distinguish "completed cleanly" from
            // "completed with unresolved validator failures".
            log.warn("validator retries exhausted, session terminating with unresolved failures", {
              sessionID,
              failures: failures.map((f) => f.validator.name),
            })
            Telemetry.track({
              type: "validator_retries_exhausted",
              timestamp: Date.now(),
              session_id: sessionID,
              step,
              validator_names: failures.map((f) => f.validator.name),
            } as any)
          }
        } catch (e) {
          // A bug in the validator framework should never block the agent loop.
          log.warn("validator dispatch errored, skipping", {
            sessionID,
            error: e instanceof Error ? e.message : String(e),
          })
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({ kind: "dispatch_error", sessionID, step, error: e instanceof Error ? e.message : String(e) }),
            )
          }
        }
      }
      // altimate_change end

      if (result === "stop") break
      if (result === "compact") {
        // altimate_change start — track compaction count
        compactionCount++
        // altimate_change end
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: !processor.message.finish,
        })
      }
      continue
    }
    // altimate_change start — set idle on normal loop exit; abort path is handled by processor catch block
    if (!abort.aborted) {
      await SessionStatus.set(sessionID, { type: "idle" })
    }
    // altimate_change end
    SessionCompaction.prune({ sessionID })
    // altimate_change start — session end telemetry
    const outcome = abort.aborted
      ? "aborted"
      : sessionHadError
        ? "error"
        : sessionTotalCost === 0 && toolCallCount === 0
          ? "abandoned"
          : "completed"
    // altimate_change start — emit quality signal, tool chain, and error fingerprint events
    Telemetry.track({
      type: "task_outcome_signal",
      timestamp: Date.now(),
      session_id: sessionID,
      signal: Telemetry.deriveQualitySignal(outcome),
      tool_count: toolCallCount,
      step_count: step,
      duration_ms: Date.now() - sessionStartTime,
      last_tool_category: lastToolCategory || "none",
    })
    // Tool chain effectiveness — aggregated tool sequence + outcome
    if (toolChain.length > 0) {
      Telemetry.track({
        type: "tool_chain_outcome",
        timestamp: Date.now(),
        session_id: sessionID,
        chain: JSON.stringify(toolChain),
        chain_length: toolChain.length,
        had_errors: toolErrorCount > 0,
        error_recovery_count: errorRecoveryCount,
        final_outcome: outcome,
        total_duration_ms: Date.now() - sessionStartTime,
        total_cost: sessionTotalCost,
      })
    }
    // Flush any pending unrecovered error
    if (pendingError) {
      errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
    }
    // Error fingerprints — one event per unique error (capped at 20)
    for (const err of errorRecords.slice(0, 20)) {
      Telemetry.track({
        type: "error_fingerprint",
        timestamp: Date.now(),
        session_id: sessionID,
        error_hash: err.errorHash,
        error_class: err.errorClass,
        tool_name: err.toolName,
        tool_category: err.toolCategory,
        recovery_successful: err.recovered,
        recovery_tool: err.recoveryTool,
      })
    }
    // altimate_change end — emit quality signal, tool chain, and error fingerprint events
    // altimate_change start — populate agent_outcome diagnostic fields
    const abortReason: string | null = abort.aborted
      ? typeof abort.reason === "string"
        ? abort.reason
        : abort.reason instanceof Error
          ? abort.reason.message
          : abort.reason
            ? "non_string_reason"
            : null
      : null
    const lastErrorClass = errorRecords.length > 0 ? errorRecords[errorRecords.length - 1].errorClass : ""
    const diag = Telemetry.deriveAgentOutcomeReason({
      outcome,
      lastToolName: lastToolName || null,
      lastMessageError: lastMessageError || null,
      abortReason,
      lastErrorClass,
    })
    // altimate_change end
    Telemetry.track({
      type: "agent_outcome",
      timestamp: Date.now(),
      session_id: sessionID,
      // altimate_change start — route through normalizeAgentName (shared with
      // session_start above) so the two events always agree on the bucket name.
      // See the helper at the top of this namespace for the legacy-name policy.
      agent: normalizeAgentName(sessionAgentName),
      // altimate_change end
      tool_calls: toolCallCount,
      generations: step,
      duration_ms: Date.now() - sessionStartTime,
      cost: sessionTotalCost,
      compactions: compactionCount,
      outcome,
      // altimate_change start — agent_outcome diagnostic fields
      final_tool: diag.final_tool,
      error_class: diag.error_class,
      reason: diag.reason,
      // altimate_change end
    })
    if (!emergencySessionEndFired) {
      emergencySessionEndFired = true
      process.off("beforeExit", emergencySessionEnd)
      process.off("exit", emergencySessionEnd)
      Telemetry.track({
        type: "session_end",
        timestamp: Date.now(),
        session_id: sessionID,
        total_cost: sessionTotalCost,
        total_tokens: sessionTotalTokens,
        tool_call_count: toolCallCount,
        duration_ms: Date.now() - sessionStartTime,
      })
    }
    await Telemetry.shutdown()
    // altimate_change end
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: SessionID) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    for (const item of await ToolRegistry.tools(
      { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
      input.agent,
    )) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await item.execute(args, ctx)
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              args,
            },
            output,
          )
          return output
        },
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const schemaResult = asSchema(item.inputSchema) as { jsonSchema: any }
      const transformed = ProviderTransform.schema(input.model, schemaResult.jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
            args,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        // result.output is the tool's return value (an object with `output: string`).
        const value = typeof result.output === "string" ? result.output : ((result.output as any)?.output ?? "")
        return {
          type: "text",
          value,
        }
      },
    })
  }

  async function createUserMessage(input: PromptInput) {
    const agentName = input.agent ?? (await Agent.defaultAgent())
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) =>
        agents.filter((a: any) => !a.hidden).map((a: any) => a.name),
      )
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      throw new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
    }

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    // Use agent.variant only when the user did not provide an explicit model
    // override; if the user picked a different model, agent.variant doesn't apply.
    const useAgentModel = !input.model
    const full =
      !input.variant && agent.variant && useAgentModel
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant =
      input.variant ??
      (agent.variant && useAgentModel
        ? full?.variants?.[agent.variant]
          ? agent.variant
          : agent.variant // accept agent variant even if model registry has no variants entry
        : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model: variant ? { ...model, variant } : model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  //
  // NOTE: `family` is a free-form, config-settable string on the model schema —
  // a connection that declares `family: "claude-*"` on a non-Anthropic gateway
  // will classify as Anthropic-like and SKIP the hoist, which reintroduces the
  // #887 refusal on that backend. This is a routing-trust input, not an
  // escalation vector (whoever sets the model config already controls the
  // prompt), but operators adding gateway models should set `family` correctly.
  //
  // Exported for testing — the hoist/classification contract is exercised
  // behaviorally in test/session/plan-layer-e2e.test.ts.
  // altimate_change start — model-family helper used by the trust-aware hoist below.
  // Uses `familyVendor` so specific family values (`claude-sonnet`, `claude-haiku`,
  // `gemini-pro`, etc.) classify correctly — an exact `family === "anthropic"`
  // check would miss the gateway-emitted specific names (#888 J1). The api.id
  // checks are lowercased and tightened to a `claude-` / `anthropic-` /
  // `anthropic/...` shape so a model named `foo-claude-bench` doesn't false-match.
  export function isAnthropicLikeModel(model: Provider.Model): boolean {
    if (model.providerID === "anthropic") return true
    if (model.providerID === "google-vertex-anthropic") return true
    if (familyVendor(model.family) === "anthropic") return true
    if (model.api.npm === "@ai-sdk/anthropic") return true
    const apiId = model.api.id.toLowerCase()
    const lastSeg = apiId.split("/").pop() ?? apiId
    if (/^claude[-_.]/.test(lastSeg)) return true
    if (/^anthropic[-_/]/.test(apiId)) return true
    return false
  }
  // altimate_change end

  // altimate_change start — return the trusted reminder parts insertReminders just appended
  // so the caller can hoist them into the system prompt on non-Anthropic models.
  // The returned-parts contract is the trust boundary: only parts that *this function*
  // creates are eligible for promotion. The schema-wide `synthetic` flag is set by other
  // code paths too (file/resource expansions at lines ~1729/1751/1801 attach
  // file content as synthetic text), so it is not safe to infer trust from `synthetic`
  // alone. See #888 review feedback.
  type InsertRemindersResult = { messages: MessageV2.WithParts[]; trustedReminderParts: MessageV2.TextPart[] }
  // Exported for testing — the trust boundary (only self-injected reminders land
  // in `trustedReminderParts`, never user/file/resource content) is verified
  // behaviorally in test/session/plan-layer-e2e.test.ts.
  export async function insertReminders(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    session: Session.Info
    // altimate_change start — used to bake `ignored` into the persisted experimental
    // plan-mode reminders so they don't replay as user-role `<system-reminder>` on
    // turn 2+ on non-Anthropic models (#888 J2).
    model: Provider.Model
    // altimate_change end
  }): Promise<InsertRemindersResult> {
    const trustedReminderParts: MessageV2.TextPart[] = []
    // altimate_change start — pre-compute the hoist decision once so it can be
    // applied at insertion time (including to persisted rows). For non-Anthropic
    // models, every trusted reminder is marked `ignored: true` immediately so
    // `toModelMessages` will skip it (the caller no longer needs to mutate the
    // flag, and DB-persisted rows survive the contract across turns).
    const nonAnthropic = !isAnthropicLikeModel(input.model)
    // altimate_change end
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return { messages: input.messages, trustedReminderParts }

    // Original logic when experimental plan mode is disabled
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        const part: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        }
        userMessage.parts.push(part)
        trustedReminderParts.push(part)
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "builder") {
        const part: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        }
        userMessage.parts.push(part)
        trustedReminderParts.push(part)
      }
      return { messages: input.messages, trustedReminderParts }
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        const part = await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        })
        userMessage.parts.push(part)
        trustedReminderParts.push(part as MessageV2.TextPart)
      }
      return { messages: input.messages, trustedReminderParts }
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

// altimate_change start — two-step plan approach with refinement loop
## Two-Step Plan Approach

When creating a plan:
1. FIRST, present a brief outline (3-5 bullet points) summarizing your proposed approach
2. Ask the user if this direction looks right before expanding
3. If the user wants changes, refine the outline based on their feedback
4. Only write the full detailed plan to the plan file after the user confirms the approach

When the user provides feedback on a plan you have already written:
1. Read the existing plan file
2. Incorporate their feedback into the plan
3. Update the plan file with revisions
4. Summarize what changed
// altimate_change end

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
        ...(nonAnthropic ? { ignored: true } : {}),
      })
      userMessage.parts.push(part)
      trustedReminderParts.push(part as MessageV2.TextPart)
      return { messages: input.messages, trustedReminderParts }
    }
    return { messages: input.messages, trustedReminderParts }
  }
  // altimate_change end

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    using _ = defer(() => {
      // If no queued callbacks, cancel (the default)
      const callbacks = state()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger(
      "shell.env",
      { cwd, sessionID: input.sessionID, callID: part.callID },
      { env: {} },
    )
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)

    // altimate_change start — /mcps enable/disable: direct handler bypasses LLM
    if (input.command === "mcps") {

      // Helper: build and persist an assistant reply for a command shortcut.
      async function respond(
        parentID: MessageID,
        responseText: string,
        model: { modelID: ModelID; providerID: ProviderID },
      ): Promise<MessageV2.WithParts> {
        const now = Date.now()
        const assistantMsg: MessageV2.Assistant = {
          id: MessageID.ascending(), role: "assistant", sessionID: input.sessionID,
          parentID, modelID: model.modelID, providerID: model.providerID,
          mode: "builder", agent: "builder",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop", time: { created: now, completed: now },
        }
        await Session.updateMessage(assistantMsg)
        const textPart: MessageV2.TextPart = {
          id: PartID.ascending(), sessionID: input.sessionID, messageID: assistantMsg.id,
          type: "text", text: responseText, time: { start: now, end: now },
        }
        await Session.updatePart(textPart)
        Bus.publish(Command.Event.Executed, {
          name: input.command, sessionID: input.sessionID,
          arguments: input.arguments, messageID: assistantMsg.id,
        })
        return { info: assistantMsg, parts: [textPart] } as MessageV2.WithParts
      }
      const trimmed = input.arguments.trim()

      if (!trimmed) {
        // /mcps (no args): return actual runtime status directly
        const userMsg = await createUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          parts: [{ type: "text", text: "/mcps" }],
        })
        const model = await lastModel(input.sessionID)
        const statusMap = await MCP.status()
        const rows = Object.entries(statusMap)
          .map(([srv, s]) => {
            const icon = s.status === "connected" ? "\u2713" : "\u25cb"
            const label =
              s.status === "failed"
                ? icon + " " + s.status + " (" + s.error + ")"
                : icon + " " + s.status
            return "| `" + srv + "` | " + label + " |"
          })
          .join("\n")
        const responseText = rows
          ? "MCP servers:\n\n| Server | Status |\n|---|---|\n" + rows
          : "No MCP servers configured."

        return respond(userMsg.info.id, responseText, model)
      }

      const subMatch = trimmed.match(/^(enable|disable)\s+(\S+)/)
      if (subMatch) {
        const [, subCmd, name] = subMatch
        const isEnable = subCmd === "enable"

        const userMsg = await createUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          parts: [{ type: "text", text: `/mcps ${subCmd} ${name}` }],
        })

        const model = await lastModel(input.sessionID)
        // MCP.connect/disconnect on an unknown name logs and returns silently, so
        // validate against config first and give the user a clear signal on a typo.
        const cfg = await Config.get()
        if (!cfg.mcp?.[name]) {
          const known = Object.keys(cfg.mcp ?? {})
          const suffix = known.length ? ` Known servers: ${known.join(", ")}.` : ""
          return respond(
            userMsg.info.id,
            `MCP server **${name}** not found in config.${suffix}`,
            model,
          )
        }

        let responseText: string

        if (isEnable) {
          await MCP.connect(name)
          const statusMap = await MCP.status()
          const entry = statusMap[name]
          if (entry?.status === "connected") {
            responseText = `MCP server **${name}** enabled. Status: connected.`
          } else {
            const errSuffix = entry?.status === "failed" ? " — " + entry.error : ""
          responseText = `Attempted to enable MCP server **${name}**. Status: ${entry?.status ?? "unknown"}${errSuffix}.`
          }
        } else {
          await MCP.disconnect(name)
          responseText = `MCP server **${name}** disabled.`
        }

        return respond(userMsg.info.id, responseText, model)
      }
    }
    // altimate_change end

    const command = await Command.get(input.command)
    if (!command) {
      const all = await Command.list()
      const names = all
        .map((c: any) => c.name)
        .filter(Boolean)
        .sort()
      throw new NamedError.Unknown({
        message: `Command not found: "${input.command}". Available: ${names.join(", ") || "(none)"}`,
      })
    }
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    // altimate_change start — allow $$ARGUMENTS to produce literal $ARGUMENTS in output
    const ESCAPE_SENTINEL = "\x00ESCAPED_DOLLAR_ARGUMENTS\x00"
    let template = withArgs
      .replaceAll("$$ARGUMENTS", ESCAPE_SENTINEL)
      .replaceAll("$ARGUMENTS", input.arguments)
      .replaceAll(ESCAPE_SENTINEL, "$ARGUMENTS")
    // altimate_change end

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: ProviderID
    modelID: ModelID
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : await MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await Promise.resolve(result.text).catch((err: unknown) => {
      log.error("failed to generate title", { error: err })
      return undefined
    })
    if (text) {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line: string) => line.trim())
        .find((line: string) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      return Session.setTitle({ sessionID: input.session.id, title })
    }
  }
}

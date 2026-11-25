import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
// altimate_change start — upstream_fix: publish a task schema that hides disabled background mode.
import { zodToJsonSchema } from "@/altimate/tool-zod-compat"
// altimate_change end
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
// altimate_change start — log unhandled cancel rejections
import { Log } from "@/util/log"
// client trace propagation: a subagent's turn inherits its parent turn's trace
import { TraceContext } from "@/altimate/observability/trace-context"
// altimate_change start — task queries share their parent run's remaining budget
import { RunBudget } from "@/altimate/run-budget"
// altimate_change end
// re-brand core (ModelV2/ProviderV2) IDs to the provider/schema brands SessionPrompt expects
import { ModelID, ProviderID } from "@/provider/schema"
import { ConfigProvider, Effect, Layer } from "effect"
// altimate_change start — upstream_fix: recover committed child findings when cancellation interrupts a task.
import { interruptedTaskOutput, lastTaskText, runModeTaskReport } from "../session/task-output"
import { Flag } from "../flag/flag"
// altimate_change end
// altimate_change start — redact provider error messages before they reach the parent's task result
import { redactSecrets } from "@/altimate/learn/digest"
// altimate_change end
// altimate_change start — upstream_fix: background subagents follow the experiment flag at execution time.
import { AsyncLocalStorage } from "async_hooks"
import { RuntimeFlags } from "@/effect/runtime-flags"
// altimate_change end
const log = Log.create({ service: "tool.task" })

/**
 * Effect-based prompt operations the task tool drives through `ctx.extra.promptOps`.
 * Injected by session/tools so the tool stays decoupled from SessionPrompt's
 * concrete service and is straightforward to stub in tests.
 */
export interface TaskPromptOps {
  readonly resolvePromptParts: (template: string) => Effect.Effect<SessionPrompt.PromptInput["parts"]>
  readonly prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
}
// altimate_change end

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  // altimate_change start — upstream_fix: keep accepting legacy/manual background calls internally.
  background: z
    .boolean()
    .describe(
      "Run the subagent in the background and return immediately with a task_id. Call task again with that task_id (same subagent_type) to wait for and collect its result. A background task you have not collected is cancelled when your turn ends.",
    )
    .optional(),
  // altimate_change end
})

// altimate_change start — upstream_fix: keep accepting `background` internally so old/manual
// callers get the explicit disabled-feature error, but do not advertise it to models.
const taskJsonSchema = (() => {
  const schema = zodToJsonSchema(parameters)
  const properties = schema.properties
  if (!properties || typeof properties !== "object" || !("background" in properties)) return schema
  const nextProperties = { ...properties }
  delete nextProperties.background
  return {
    ...schema,
    properties: nextProperties,
    ...(Array.isArray(schema.required) ? { required: schema.required.filter((field) => field !== "background") } : {}),
  }
})()
// altimate_change end

// altimate_change start — upstream_fix: background subagents run without blocking the parent turn.
/** The `background` property the registry adds to the task schema when the experiment is on. */
export const taskBackgroundJsonSchema = (zodToJsonSchema(parameters).properties as Record<string, unknown>).background

type BackgroundFlag = Pick<RuntimeFlags.Info, "experimentalBackgroundSubagents">
const runtimeFlagsScope = new AsyncLocalStorage<BackgroundFlag>()

/**
 * Runs `fn` with the RuntimeFlags of the service that started it (SessionPrompt.Service), so the
 * imperative prompt loop, its tool catalogue and tool_lookup take the injected decision.
 */
export function withRuntimeFlags<A>(flags: BackgroundFlag | undefined, fn: () => A): A {
  return flags ? runtimeFlagsScope.run(flags, fn) : fn()
}

/**
 * Whether background subagents are on: the RuntimeFlags in scope (see `withRuntimeFlags`), otherwise
 * the environment read exactly as RuntimeFlags reads it. The registry passes its decision to execution
 * (`extra.backgroundSubagents`), so the schema gate and the execution gate always agree.
 */
export function backgroundSubagentsEnabled() {
  const scoped = runtimeFlagsScope.getStore()
  if (scoped) return scoped.experimentalBackgroundSubagents
  return Effect.runSync(
    Effect.gen(function* () {
      return (yield* RuntimeFlags.Service).experimentalBackgroundSubagents
    }).pipe(
      // A fresh env provider: the default one is a snapshot taken on first use.
      Effect.provide(RuntimeFlags.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))),
    ),
  )
}

const NOTIFY_SENTENCE = "For background tasks, you will be notified automatically when the result is ready."
const COLLECT_SENTENCE =
  "A background task (background: true) sends no notification: collect its result by calling task again with its task_id. Collect every background task before you end your turn; ending your turn cancels any background task you have not collected. Calling task with a background task's task_id always returns that task's recorded result and never sends it new work."

/** The task description with the background experiment on: no notification exists, the parent collects. */
export function backgroundTaskDescription(description: string) {
  return description.replace(NOTIFY_SENTENCE, COLLECT_SENTENCE)
}

/** Running background children one parent session may have at once. */
export const MAX_RUNNING_BACKGROUND_TASKS = 4
/** Recorded background tasks kept per parent session; the oldest settled records go first. */
const MAX_BACKGROUND_RECORDS = 100
/** Recorded background tasks kept across all parent sessions; the oldest settled records go first. */
export const MAX_BACKGROUND_RECORDS_TOTAL = 1_000

type TaskResult = {
  title: string
  metadata: {
    sessionId: SessionID
    model: { modelID: string; providerID: string }
    interrupted?: boolean
    background?: boolean
  }
  output: string
}

type BackgroundTask = {
  parentSessionID: string
  messageID: MessageID
  model: { modelID: string; providerID: string }
  result: Promise<TaskResult>
  settled: boolean
  collected: boolean
  joins: number
}

/**
 * Background children keyed by child session id, with their outcome once settled. A child is bound
 * to the abort signal of the parent tool call that started it: `ctx.abort` is that request's
 * `AbortSignal.any` over the loop generation's signal. The generation signal is aborted on cancel,
 * on a run-budget hard deadline and in the loop's cleanup when the parent's turn ends, so a child
 * still running then is cancelled. A soft run-budget interrupt aborts only the request it targets,
 * so it reaches a child launched in that request and not one launched in an earlier step.
 *
 * The record outlives the child: every later call with its task_id returns the recorded result
 * (or, for a cancelled child, its partial findings marked interrupted) and never re-prompts it.
 */
const backgroundTasks = new Map<string, BackgroundTask>()

/** Launches per parent session that passed the cap check and have not registered their child yet. */
const pendingLaunches = new Map<string, number>()

function runningBackgroundTasks(parentSessionID: string) {
  let count = pendingLaunches.get(parentSessionID) ?? 0
  for (const task of backgroundTasks.values()) if (task.parentSessionID === parentSessionID && !task.settled) count++
  return count
}

/** Claims a running slot before the launch's first await; disposing it releases the claim. */
function reserveBackgroundSlot(parentSessionID: string) {
  if (runningBackgroundTasks(parentSessionID) >= MAX_RUNNING_BACKGROUND_TASKS) {
    throw new Error(
      `Too many background tasks running for this session (limit ${MAX_RUNNING_BACKGROUND_TASKS}). Collect a running task's result by calling task with its task_id before launching another.`,
    )
  }
  pendingLaunches.set(parentSessionID, (pendingLaunches.get(parentSessionID) ?? 0) + 1)
  return defer(() => {
    const pending = (pendingLaunches.get(parentSessionID) ?? 1) - 1
    if (pending > 0) pendingLaunches.set(parentSessionID, pending)
    else pendingLaunches.delete(parentSessionID)
  })
}

/** @internal Exported for testing. Drops the oldest settled records over the per-parent and total caps. */
export function evictBackgroundRecords(
  records: Map<string, Pick<BackgroundTask, "parentSessionID" | "settled">>,
  parentSessionID: string,
) {
  const settled = [...records].filter(([, task]) => task.settled)
  const own = settled.filter(([, task]) => task.parentSessionID === parentSessionID)
  const total = [...records.values()].filter((task) => task.parentSessionID === parentSessionID).length
  for (const [id] of own.slice(0, Math.max(0, total - MAX_BACKGROUND_RECORDS))) records.delete(id)
  const remaining = settled.filter(([id]) => records.has(id))
  for (const [id] of remaining.slice(0, Math.max(0, records.size - MAX_BACKGROUND_RECORDS_TOTAL))) records.delete(id)
}

const resumeHeader = (id: string) => `task_id: ${id} (for resuming to continue this task if needed)`
const recordedHeader = (id: string) =>
  `task_id: ${id} (background task: calling task with this task_id returns this same result)`

/** Points a background task's result at its record, since a task_id call collects rather than resumes. */
function recordedResult(id: string, result: TaskResult): TaskResult {
  return { ...result, output: result.output.replace(resumeHeader(id), recordedHeader(id)) }
}

/** The tool part of one call in a message, or undefined when the message or part is not stored. */
function toolPart(sessionID: SessionID, messageID: MessageID, callID: string) {
  try {
    return MessageV2.get({ sessionID, messageID }).parts.find(
      (item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === callID,
    )
  } catch {
    return undefined
  }
}

const PART_RUNNING_WAIT_MS = 2_000
const PART_RUNNING_POLL_MS = 10

/**
 * Waits until the loop has marked this call's tool part running. The loop records `ctx.metadata` only
 * on a running part, and a collect reaches its metadata call before the loop has finished that write.
 */
async function untilToolPartRunning(ctx: {
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  abort: AbortSignal
}) {
  if (!ctx.callID) return
  const until = Date.now() + PART_RUNNING_WAIT_MS
  while (Date.now() < until && !ctx.abort.aborted) {
    const part = toolPart(ctx.sessionID, ctx.messageID, ctx.callID)
    if (!part || part.state.status !== "pending") return
    await new Promise((resolve) => setTimeout(resolve, PART_RUNNING_POLL_MS))
  }
}

/** Appends the cancellation to the launch tool part, so the turn's record shows what was lost. */
async function recordCancellation(input: {
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  childID: string
  output: string
}) {
  if (!input.callID) return
  try {
    const part = toolPart(input.sessionID, input.messageID, input.callID)
    if (!part || part.state.status !== "completed") return
    await Session.updatePart({
      ...part,
      state: {
        ...part.state,
        output: [
          part.state.output,
          "",
          `Background task ${input.childID} was cancelled at the end of the turn, before its result was collected. Its partial findings:`,
          input.output,
        ].join("\n"),
        metadata: { ...part.state.metadata, interrupted: true },
      },
    })
  } catch (error) {
    log.warn("failed to record background task cancellation", { sessionID: input.sessionID, error })
  }
}
// altimate_change end

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    // altimate_change start — upstream_fix: hide disabled background mode from the tool contract.
    jsonSchema: taskJsonSchema,
    // altimate_change end
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      // altimate_change start — upstream_fix: honour background only behind the experiment flag; a
      // task_id naming a running background child of this session joins it instead of re-prompting.
      const background = params.background === true
      const enabled =
        typeof ctx.extra?.backgroundSubagents === "boolean"
          ? ctx.extra.backgroundSubagents
          : background && backgroundSubagentsEnabled()
      if (background && !enabled) {
        throw new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
      }
      const recorded = params.task_id ? backgroundTasks.get(params.task_id) : undefined
      if (params.task_id && recorded?.parentSessionID === ctx.sessionID) {
        const taskID = params.task_id
        if (background && !recorded.settled) {
          return {
            title: params.description,
            metadata: { sessionId: SessionID.make(taskID), model: recorded.model, background: true },
            output: [
              `task_id: ${taskID}`,
              `Task is still running in the background. Its result is collected by calling task again with task_id=${taskID} (without background); it is cancelled if your turn ends before you collect it.`,
            ].join("\n"),
          }
        }
        // Publish the child's identity first, so a cancel during the wait recovers its partial findings.
        await untilToolPartRunning(ctx)
        await ctx.metadata({
          title: params.description,
          metadata: { sessionId: taskID, messageID: recorded.messageID, model: recorded.model },
        })
        recorded.joins++
        try {
          const result = await recorded.result
          recorded.collected = true
          return result
        } finally {
          recorded.joins--
        }
      }
      // Parallel launches in one step must not all pass the cap before any registers its child.
      using _slot = background ? reserveBackgroundSlot(ctx.sessionID) : undefined
      // altimate_change end

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const parent = await Session.get(ctx.sessionID)
      // altimate_change start — upstream_fix: inherit parent session denies/external_directory rules for subtasks
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: agent,
      })
      const childToolDenies = [
        {
          permission: "todowrite" as const,
          pattern: "*" as const,
          action: "deny" as const,
        },
        {
          permission: "todoread" as const,
          pattern: "*" as const,
          action: "deny" as const,
        },
        ...(hasTaskPermission
          ? []
          : [
              {
                permission: "task" as const,
                pattern: "*" as const,
                action: "deny" as const,
              },
            ]),
        ...(config.experimental?.primary_tools?.map((permission) => ({
          pattern: "*" as const,
          action: "deny" as const,
          permission,
        })) ?? []),
      ]
      // altimate_change end

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          // altimate_change start — only resume children created for THIS parent and subagent.
          // Other agents (or legacy sessions with no binding) may carry wider permissions.
          if (found && found.parentID === ctx.sessionID && found.metadata?.taskAgent === agent.name) return found
          // altimate_change end
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          // altimate_change start — persist the subagent identity for safe resumptions.
          metadata: { taskAgent: agent.name },
          // altimate_change end
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // altimate_change start — upstream_fix: bind partial findings to this child prompt during parent cancellation.
      const messageID = MessageID.ascending()
      await ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          messageID,
          model,
        },
      })
      // altimate_change end

      // altimate_change start — the subagent's turn belongs to the parent turn's client trace (the
      // parent assistant message's user message); none when that turn is untraced
      TraceContext.inherit(messageID, msg.info.parentID)
      // altimate_change end
      const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined

      function cancel() {
        // altimate_change start — SessionPrompt.cancel became async; fire-and-forget OK in abort handler
        // but log unhandled rejections so silent failures surface
        const cancelled = promptOps ? Effect.runPromise(promptOps.cancel(session.id)) : SessionPrompt.cancel(session.id)
        cancelled.catch((err) => {
          log.warn("cancel failed", { sessionID: session.id, err })
        })
        // altimate_change end
      }
      // altimate_change start — upstream_fix: the child run is a unit a background task can detach.
      const run = async (): Promise<TaskResult> => {
        ctx.abort.addEventListener("abort", cancel)
        using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
        const promptParts = promptOps
          ? await Effect.runPromise(promptOps.resolvePromptParts(params.prompt))
          : await SessionPrompt.resolvePromptParts(params.prompt)
        // altimate_change start — upstream_fix: cancellation during task preparation must not start new child work.
        ctx.abort.throwIfAborted()
        // altimate_change end

        const promptInput: SessionPrompt.PromptInput = {
          messageID,
          sessionID: session.id,
          model: {
            // altimate_change start — re-brand to provider/schema ModelID/ProviderID
            // (identity at runtime); agent.model carries the core ModelV2/ProviderV2 brands.
            modelID: ModelID.make(model.modelID),
            providerID: ProviderID.make(model.providerID),
            // altimate_change end
          },
          agent: agent.name,
          parts: promptParts,
        }
        // altimate_change start — keep the inherited query cutoff scoped to this child prompt
        using queryBudget = defer(RunBudget.registerQueryDeadline(session.id, RunBudget.queryDeadline(ctx.sessionID)))
        // altimate_change end
        // altimate_change start — upstream_fix: return partial child findings after cancellation, even if its last turn is empty.
        let partialOutput: string | undefined
        const result = await (promptOps
          ? Effect.runPromise(promptOps.prompt(promptInput))
          : SessionPrompt.prompt(promptInput)
        ).catch(async (error) => {
          if (!ctx.abort.aborted) throw error
          partialOutput = await interruptedTaskOutput(session.id, messageID, { runMode: Flag.ALTIMATE_RUN_MODE })
          if (!partialOutput) throw error
          return undefined
        })
        if (ctx.abort.aborted)
          partialOutput ??= await interruptedTaskOutput(session.id, messageID, { runMode: Flag.ALTIMATE_RUN_MODE })

        const lastText = result?.parts.findLast((x) => x.type === "text")?.text ?? ""
        // Run mode: the child's completion token is a harness signal, not part of its report,
        // and a bare-token acknowledgement must not replace the report it confirms.
        const text = Flag.ALTIMATE_RUN_MODE ? await runModeTaskReport(session.id, lastText, messageID) : lastText
        // altimate_change start — a child that ends on an error or with no text must not reach the
        // parent as an empty result, which reads as "done, nothing found". An error is reported even
        // when the child wrote text before it, since that text may be incomplete.
        const childError = result?.info.role === "assistant" ? result.info.error : undefined
        // A background child whose request failed reports that failure on every collect, not an
        // empty result. The message is the redacted, length-capped provider error.
        if (background && !ctx.abort.aborted && !text && childError) {
          throw new Error(`Background task ${session.id} failed: ${errorText(childError)}`)
        }
        const status =
          ctx.abort.aborted || (text.trim() && !childError)
            ? []
            : await emptyTaskStatus(session.id, messageID, childError, text)
        // altimate_change end

        const output = partialOutput ?? [
          `task_id: ${session.id} (for resuming to continue this task if needed)`,
          "",
          "<task_result>",
          ...(ctx.abort.aborted ? ["Task interrupted. Findings may be incomplete."] : []),
          ...status,
          text,
          "</task_result>",
        ].join("\n")
        // altimate_change end

        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            // altimate_change start — upstream_fix: distinguish partial task findings from completed work.
            ...(ctx.abort.aborted ? { interrupted: true } : {}),
            // altimate_change end
          },
          output,
        }
      }
      if (!background) return await run()

      // The abort listener and query budget registered inside run() stay in place until the child
      // settles, so a background child remains bound to the parent's abort signal and run budget.
      ctx.abort.throwIfAborted()
      const result = run()
        .catch((error): TaskResult => {
          if (!ctx.abort.aborted) throw error
          return {
            title: params.description,
            metadata: { sessionId: session.id, model, interrupted: true },
            output: [
              resumeHeader(session.id),
              "",
              "<task_result>",
              "Task cancelled before it returned any findings.",
              "</task_result>",
            ].join("\n"),
          }
        })
        .then((settled) => recordedResult(session.id, settled))
      const record: BackgroundTask = {
        parentSessionID: ctx.sessionID,
        messageID,
        model,
        result,
        settled: false,
        collected: false,
        joins: 0,
      }
      result.then(
        async (settled) => {
          record.settled = true
          if (!settled.metadata.interrupted || record.collected || record.joins > 0) return
          await recordCancellation({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            childID: session.id,
            output: settled.output,
          })
        },
        (err) => {
          record.settled = true
          log.warn("background task failed", { sessionID: session.id, err })
        },
      )
      backgroundTasks.set(session.id, record)
      evictBackgroundRecords(backgroundTasks, ctx.sessionID)
      return {
        title: params.description,
        metadata: { sessionId: session.id, model, background: true },
        output: [
          `task_id: ${session.id}`,
          `Task is running in the background. Its result is collected by calling task again with task_id=${session.id}; it is cancelled if your turn ends before you collect it.`,
        ].join("\n"),
      }
      // altimate_change end
    },
  }
})

// altimate_change start — explicit status for a child that errored or produced no final text
async function emptyTaskStatus(
  sessionID: SessionID,
  messageID: MessageID,
  error: MessageV2.Assistant["error"],
  text: string,
): Promise<string[]> {
  const reason = error
    ? `Task stopped with an error before giving a final answer (${errorText(error)}).`
    : "Task ended without a final text answer."
  // The final text, when there is one, follows the status in the result.
  if (text.trim()) return [reason, "Its last written text, which may be incomplete:"]
  const partial = await lastTaskText(sessionID, messageID, { runMode: Flag.ALTIMATE_RUN_MODE }).catch(() => undefined)
  return partial
    ? [reason, "Its last written text, which may be incomplete:", partial]
    : [reason, "It wrote no text. Resume it with task_id or treat its work as unfinished."]
}

// The task result is persisted and sent to the parent's model, so a provider error message is
// passed through the same credential redaction as exported trajectories, and kept short.
const ERROR_MESSAGE_LIMIT = 300
function errorText(error: NonNullable<MessageV2.Assistant["error"]>): string {
  const raw =
    "data" in error && error.data && typeof error.data === "object" && "message" in error.data
      ? String(error.data.message)
      : ""
  const message = redactSecrets(raw).trim()
  if (!message) return error.name
  const short = message.length > ERROR_MESSAGE_LIMIT ? `${message.slice(0, ERROR_MESSAGE_LIMIT)}…` : message
  return `${error.name}: ${short}`
}
// altimate_change end

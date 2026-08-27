import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { Telemetry } from "@/telemetry" // altimate_change — telemetry for compaction events
import { ModelID, ProviderID } from "@/provider/schema"
// altimate_change start — Effect Context.Service facade for the upstream runtime
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
// altimate_change end

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  // altimate_change start — observation masks for pruned tool outputs
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function truncateArgs(input: Record<string, any> | null | undefined, maxLen: number): string {
    if (!input || typeof input !== "object") return ""
    let str: string
    try {
      str = Object.entries(input)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(", ")
    } catch {
      return "[unserializable]"
    }
    if (str.length <= maxLen) return str
    let end = maxLen
    const code = str.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
    return str.slice(0, end) + "…"
  }

  export function createObservationMask(part: MessageV2.ToolPart): string {
    const output = (part.state.status === "completed" ? part.state.output : "") || ""
    const lines = output.split("\n").length
    const bytes = Buffer.byteLength(output, "utf8")
    const args = truncateArgs(
      part.state.status === "completed" || part.state.status === "running" || part.state.status === "error"
        ? part.state.input
        : {},
      80,
    )
    const firstLine = output.split("\n")[0]?.slice(0, 80) || ""
    const fingerprint = firstLine ? ` — "${firstLine}"` : ""
    return `[Tool output cleared — ${part.tool}(${args}) returned ${lines} lines, ${formatBytes(bytes)}${fingerprint}]`
  }
  // altimate_change end

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000

  // altimate_change start — improved isOverflow formula with safety guard and unified headroom
  // See PR #35 — fixes upstream bugs with limit.input models and small-context models
  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const reserved = config.compaction?.reserved ?? COMPACTION_BUFFER
    const headroom = Math.max(reserved, maxOutput)
    const base = input.model.limit.input ?? context
    if (base <= headroom) return false
    return count >= base - headroom
  }
  // altimate_change end

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // altimate_change start — upstream_fix: restore tail-preserving compaction selection
  const DEFAULT_TAIL_TURNS = 2
  const MIN_PRESERVE_RECENT_TOKENS = 2_000
  const MAX_PRESERVE_RECENT_TOKENS = 8_000

  type ConfigInfo = Awaited<ReturnType<typeof Config.get>>

  type Turn = {
    start: number
    end: number
    id: MessageID
  }

  type Tail = {
    start: number
    id: MessageID
  }

  type CompletedCompaction = {
    userIndex: number
    assistantIndex: number
  }

  function completedCompactions(messages: MessageV2.WithParts[]) {
    const users = new Map<MessageID, number>()
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.info.role !== "user") continue
      if (!msg.parts.some((part) => part.type === "compaction")) continue
      users.set(msg.info.id, i)
    }

    return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
      if (msg.info.role !== "assistant") return []
      if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
      const userIndex = users.get(msg.info.parentID)
      if (userIndex === undefined) return []
      return [{ userIndex, assistantIndex }]
    })
  }

  function preserveRecentBudget(input: { cfg: ConfigInfo; model: Provider.Model }) {
    const context = input.model.limit.context
    if (context === 0) return 0

    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutput)
    const usable = input.model.limit.input
      ? Math.max(0, input.model.limit.input - reserved)
      : Math.max(0, context - maxOutput)
    return (
      input.cfg.compaction?.preserve_recent_tokens ??
      Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable * 0.25)))
    )
  }

  function turns(messages: MessageV2.WithParts[]) {
    const result: Turn[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.info.role !== "user") continue
      if (msg.parts.some((part) => part.type === "compaction")) continue
      result.push({
        start: i,
        end: messages.length,
        id: msg.info.id,
      })
    }
    for (let i = 0; i < result.length - 1; i++) {
      result[i].end = result[i + 1].start
    }
    return result
  }

  async function estimate(input: { messages: MessageV2.WithParts[]; model: Provider.Model }) {
    const msgs = await MessageV2.toModelMessages(input.messages, input.model, { stripMedia: true })
    return Token.estimate(JSON.stringify(msgs))
  }

  async function splitTurn(input: {
    messages: MessageV2.WithParts[]
    turn: Turn
    model: Provider.Model
    budget: number
  }) {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = await estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  }

  // altimate_change start — head-truncation fallback for un-compactable sessions
  // A session can overflow so far past the window (huge tool result landing in
  // one turn) that the summarization request itself no longer fits, which used
  // to terminate the session with "too large to compact". Summarizing a
  // truncated head is lossy; killing the session loses everything.
  export async function fitHead(input: { head: MessageV2.WithParts[]; model: Provider.Model }) {
    const context = input.model.limit.context
    if (context === 0) return { head: input.head, dropped: 0 }
    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const base = input.model.limit.input ?? context
    // 0.8: Token.estimate undercounts dense code/tool output on some tokenizers.
    const budget = Math.floor(Math.max(0, base - maxOutput - 2_000) * 0.8)
    if (budget <= 0) return { head: input.head, dropped: 0 }
    let head = input.head
    let dropped = 0
    while (head.length > 1 && (await estimate({ messages: head, model: input.model })) > budget) {
      const step = Math.max(1, Math.floor(head.length / 8))
      head = head.slice(step)
      dropped += step
      // never drop a compaction summary boundary's assistant record silently:
      // slicing from the front only removes the OLDEST material, which is what
      // a summary is for in the first place.
    }
    return { head, dropped }
  }
  // altimate_change end

  async function select(input: { messages: MessageV2.WithParts[]; cfg: ConfigInfo; model: Provider.Model }) {
    const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
    if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
    const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
    const all = turns(input.messages)
    if (!all.length) return { head: input.messages, tail_start_id: undefined }
    const recent = all.slice(-limit)
    const sizes = []
    for (const turn of recent) {
      sizes.push(
        await estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        }),
      )
    }

    let total = 0
    let keep: Tail | undefined
    for (let i = recent.length - 1; i >= 0; i--) {
      const turn = recent[i]!
      const size = sizes[i]!
      if (total + size <= budget) {
        total += size
        keep = { start: turn.start, id: turn.id }
        continue
      }
      const remaining = budget - total
      const split = await splitTurn({
        messages: input.messages,
        turn,
        model: input.model,
        budget: remaining,
      })
      if (split) keep = split
      else if (!keep) log.info("tail fallback", { budget, size, total })
      break
    }

    if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
    return {
      head: input.messages.slice(0, keep.start),
      tail_start_id: keep.id,
    }
  }

  async function selectCurrentTailStart(input: {
    sessionID: SessionID
    model: { providerID: ProviderID; modelID: ModelID }
  }) {
    try {
      const cfg = await Config.get()
      const model = await Provider.getModel(input.model.providerID, input.model.modelID)
      const messages = MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
      const prior = completedCompactions(messages)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const selected = await select({
        messages: messages.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      return selected.tail_start_id
    } catch (e) {
      log.warn("tail selection failed", { error: e instanceof Error ? e.message : String(e) })
      return undefined
    }
  }
  // altimate_change end

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: SessionID }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          // altimate_change start — observation masks for pruned tool outputs
          const mask = createObservationMask(part)
          part.state.time.compacted = Date.now()
          part.state.metadata = {
            ...part.state.metadata,
            observation_mask: mask,
          }
          // altimate_change end
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
      // altimate_change start — telemetry for pruning
      Telemetry.track({
        type: "tool_outputs_pruned",
        timestamp: Date.now(),
        session_id: input.sessionID,
        count: toPrune.length,
        tokens_pruned: pruned,
      })
      // altimate_change end
    }
  }

  // altimate_change start — compaction attempt tracking for loop protection
  const compactionAttempts = new Map<string, number>()
  // altimate_change end

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    // altimate_change start — telemetry, attempt tracking, and circuit breaker
    const attempt = (compactionAttempts.get(input.sessionID) ?? 0) + 1
    compactionAttempts.set(input.sessionID, attempt)
    input.abort.addEventListener(
      "abort",
      () => {
        compactionAttempts.delete(input.sessionID)
      },
      { once: true },
    )
    Telemetry.track({
      type: "compaction_triggered",
      timestamp: Date.now(),
      session_id: input.sessionID,
      trigger: input.auto ? "overflow_detection" : "error_recovery",
      attempt,
    })
    if (attempt > 3) {
      log.warn("compaction circuit breaker", { sessionID: input.sessionID, attempt })
      return
    }
    // altimate_change end
    const parent = input.messages.findLast((m) => m.info.id === input.parentID)
    if (!parent || parent.info.role !== "user") {
      // altimate_change — fail compaction with the intended validation error before model lookup.
      throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
    }
    const userMessage = parent.info
    // altimate_change start — upstream_fix: restore tail-preserving compaction selection
    const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
    // altimate_change end

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? // altimate_change start — re-brand core ProviderV2.ID/ModelV2.ID to fork ProviderID/ModelID
        await Provider.getModel(ProviderID.make(agent.model.providerID), ModelID.make(agent.model.modelID))
      : // altimate_change end
        await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    // altimate_change start — upstream_fix: restore tail-preserving compaction selection
    const cfg = await Config.get()
    const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
    const prior = completedCompactions(history)
    const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
    const selected = await select({
      messages: history.filter((_, index) => !hidden.has(index)),
      cfg,
      model,
    })
    // altimate_change end
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Data Context (altimate_change start — data engineering context for compaction summaries)

- [What warehouse(s) or database(s) are we connected to?]
- [What schemas, tables, or columns were discovered or are relevant?]
- [What dbt models, sources, or tests are involved?]
- [Any lineage findings (upstream/downstream dependencies)?]
- [Any query patterns, anti-patterns, or optimization opportunities found?]
- [Skip this section entirely if the task is not data-engineering related]
(altimate_change end)

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        // altimate_change start — upstream_fix: summarize only the selected head when preserving recent tail;
        // trim the head from the front when even the summarization request cannot fit the window
        ...(await MessageV2.toModelMessages(
          await (async () => {
            const fitted = await fitHead({ head: selected.head, model })
            if (fitted.dropped > 0) {
              log.warn("compaction head truncated to fit window", {
                dropped: fitted.dropped,
                kept: fitted.head.length,
              })
              Telemetry.track({
                type: "compaction_head_truncated",
                timestamp: Date.now(),
                session_id: input.sessionID,
                dropped_messages: fitted.dropped,
                kept_messages: fitted.head.length,
              })
            }
            return fitted.head
          })(),
          model,
          { stripMedia: true },
        )),
        // altimate_change end
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      return "stop"
    }

    // altimate_change start — upstream_fix: stamp retained tail boundary on compaction marker
    if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
      await Session.updatePart({
        ...compactionPart,
        tail_start_id: selected.tail_start_id,
      })
    }
    // altimate_change end

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (processor.message.error) {
      compactionAttempts.delete(input.sessionID) // altimate_change — cleanup on error
      return "stop"
    }
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    compactionAttempts.delete(input.sessionID) // altimate_change — cleanup on success
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      // altimate_change start — upstream_fix: stamp retained tail boundary when creating compaction marker
      const tailStartID = await selectCurrentTailStart(input)
      // altimate_change end
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        // altimate_change start — upstream_fix: persist first retained tail message
        tail_start_id: tailStartID,
        // altimate_change end
      })
    },
  )

  // altimate_change start — Effect Context.Service facade so the upstream runtime
  // (app-runtime defaultLayer, httpapi node, session handler `yield* Service`) can
  // compose this module. Each method delegates to the existing namespace fns, which
  // self-manage Instance/Session state, so no dependency layers are required.
  export interface Interface {
    readonly create: (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

  export const use = serviceUse(Service)

  export const layer = Layer.succeed(
    Service,
    Service.of({
      create: (input) => Effect.promise(() => create(input)),
    }),
  )

  export const defaultLayer = layer

  export const node = LayerNode.make(layer, [])
  // altimate_change end
}

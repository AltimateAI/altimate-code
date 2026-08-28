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
// altimate_change start — summarizer-integrity error
import { NamedError } from "@opencode-ai/util/error"
import type { LLM } from "./llm"
// altimate_change start — completion-aware continue nudge via the nudge arbiter
import { NudgeArbiter } from "./nudge"
import { SessionTermination } from "./termination"
// altimate_change end
// altimate_change end
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
  //
  // Estimator safety margin: token counts reaching this comparison include
  // chars-based Token.estimate values that substantially undercount real
  // tokenization of dense SQL/JSON (a request can exceed the provider limit
  // while the estimate still looks safe). Compaction therefore triggers against an EFFECTIVE
  // limit — base * context_safety_fraction, default 0.65, chosen so a worst-case
  // underestimate still fits — never the raw limit. The raw limit
  // stays authoritative for anything reporting actual model capability.
  const DEFAULT_CONTEXT_SAFETY_FRACTION = 0.65
  // Trigger floor for small-context models where the safety fraction would push
  // the threshold to ~0 tokens — firing on a near-empty session would livelock
  // compaction. Clamped to the raw threshold so the margin can only ever make
  // the trigger MORE conservative than the pre-margin formula.
  const MIN_OVERFLOW_THRESHOLD = 4_000

  export function contextSafetyFraction(cfg?: { compaction?: { context_safety_fraction?: number } }) {
    // globalThis.process: SessionCompaction.process shadows the Node global here.
    // Number() over the full trimmed value — parseFloat would accept numeric
    // prefixes ("0.65junk") and silently override configuration.
    const raw = globalThis.process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]?.trim()
    let env = Number.NaN
    if (raw) {
      env = Number(raw)
      if (!Number.isFinite(env)) log.warn("invalid ALTIMATE_CONTEXT_SAFETY_FRACTION ignored", { value: raw })
    }
    const value = Number.isFinite(env) ? env : (cfg?.compaction?.context_safety_fraction ?? DEFAULT_CONTEXT_SAFETY_FRACTION)
    if (!Number.isFinite(value)) return DEFAULT_CONTEXT_SAFETY_FRACTION
    return Math.min(1, Math.max(0.1, value))
  }

  /** Portion of a declared token limit treated as usable for estimate-vs-limit decisions. */
  export function effectiveContextLimit(base: number, fraction: number) {
    return Math.floor(base * fraction)
  }

  /**
   * THE compaction-trigger threshold — the single formula shared by isOverflow
   * (when to compact) and pinBudget (how much pinned content may survive
   * compaction). Any consumer computing its own boundary from `base - headroom`
   * risks admitting more retained content than the trigger allows, which
   * re-fires compaction immediately (livelock).
   */
  export function overflowThreshold(input: { base: number; headroom: number; fraction: number }) {
    const effectiveBase = effectiveContextLimit(input.base, input.fraction)
    return Math.min(input.base - input.headroom, Math.max(effectiveBase - input.headroom, MIN_OVERFLOW_THRESHOLD))
  }

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
    const threshold = overflowThreshold({ base, headroom, fraction: contextSafetyFraction(config) })
    return count >= threshold
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
  export async function fitHead(input: { head: MessageV2.WithParts[]; model: Provider.Model; fraction?: number }) {
    const context = input.model.limit.context
    if (context === 0) return { head: input.head, dropped: 0 }
    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const base = input.model.limit.input ?? context
    // The summarization-request budget derives from the SAME safety-fraction
    // helper as the overflow trigger — Token.estimate undercounts dense
    // code/tool output, and a fallback sized against the raw limit can itself
    // overflow under that estimator error. 2k covers the summary prompt.
    const fraction = input.fraction ?? contextSafetyFraction()
    const budget = Math.max(0, effectiveContextLimit(base, fraction) - maxOutput - 2_000)
    if (budget <= 0) return { head: input.head, dropped: 0 }
    let head = input.head
    let dropped = 0
    while (head.length > 1 && (await estimate({ messages: head, model: input.model })) > budget) {
      const step = Math.max(1, Math.floor(head.length / 8))
      // Round the cut forward to the next turn boundary: a head that starts
      // mid-turn (assistant/tool messages with no leading user turn) is
      // rejected by providers with a 400, defeating the fallback entirely.
      let cut = step
      while (cut < head.length && head[cut]!.info.role !== "user") cut++
      // No user boundary to cut at: fail closed with the current (still
      // user-leading) head rather than slice mid-turn — an assistant/tool-leading
      // head is rejected by providers with a 400, defeating the fallback.
      if (cut >= head.length) break
      head = head.slice(cut)
      dropped += cut
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

  // altimate_change start — post-compaction state ledger (5a),
  // append-only summary carry (5b), first-person summary reframe (5c).
  //
  // 5a: a deterministic, corroborated-facts-only ledger appended to the synthetic
  // post-compaction continue message. Facts come from harness tool events ONLY:
  // write/edit/apply_patch completion events (path + event timestamp) and the last N
  // tool calls with exit codes where recorded. Command-agnostic by design — no
  // "build/test" classifier, no vertical (dbt/warehouse) token matching.
  // Bash-mediated file changes produce no edit event, so they are flagged as possible
  // but unverified rather than guessed at. The re-read directive is advisory and
  // mtime-anchored, never an absolute prohibition (the model's read-before-edit habit
  // is load-bearing, and external IDE edits can change disk mid-session).
  //
  // Thresholds are config-exposed (compaction.ledger_max_tokens / ledger_recent_calls).
  // Rationale: the 500-token cap (tail-truncate) keeps the ledger cheaper than the
  // duplicate re-reads it prevents (a single mid-size file re-read is ~1–3k tokens).
  // 10 recent calls covers several typical edit→verify cycles without dominating
  // the budget. Neither is fitted to any one workload.
  export const LEDGER_MAX_TOKENS = 500
  export const LEDGER_RECENT_CALLS = 10

  // Harness-corroborated write events: tools whose completion PROVES a file write.
  // Deliberately excludes bash — shell writes are unverifiable from tool events.
  const LEDGER_WRITE_TOOLS = new Set(["write", "edit"])
  const LEDGER_DETAIL_MAX = 100

  export type LedgerWrite = { path: string; mtime: number; tool: string }
  export type LedgerCall = {
    tool: string
    detail: string
    exit?: number | null
    errored: boolean
  }
  export type Ledger = { writes: LedgerWrite[]; calls: LedgerCall[]; sawBash: boolean }

  function callDetail(input: Record<string, any> | null | undefined): string {
    if (!input || typeof input !== "object") return ""
    // Generic primary-argument pick — identical treatment for every tool.
    const candidate = input.command ?? input.filePath ?? input.path ?? input.pattern ?? ""
    const str = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : ""
    return str.length > LEDGER_DETAIL_MAX ? str.slice(0, LEDGER_DETAIL_MAX) + "…" : str
  }

  /** Deterministic: output depends only on the message list passed in. */
  export function buildLedger(messages: MessageV2.WithParts[]): Ledger {
    const writes = new Map<string, LedgerWrite>()
    const calls: LedgerCall[] = []
    let sawBash = false
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        const state = part.state
        if (state.status !== "completed" && state.status !== "error") continue
        const errored = state.status === "error"
        const metadata: Record<string, any> = (state.status === "completed" ? state.metadata : state.metadata) ?? {}
        const exit = typeof metadata.exit === "number" || metadata.exit === null ? metadata.exit : undefined
        calls.push({ tool: part.tool, detail: callDetail(state.input), exit, errored })
        if (part.tool === "bash") sawBash = true
        if (errored) continue
        if (LEDGER_WRITE_TOOLS.has(part.tool)) {
          const filePath = typeof state.input?.filePath === "string" ? state.input.filePath : undefined
          // mtime = tool-event completion time, NOT an fs.stat — corroborated facts only.
          if (filePath) writes.set(filePath, { path: filePath, mtime: state.time.end, tool: part.tool })
        }
        if (part.tool === "apply_patch") {
          const files = Array.isArray(metadata.files) ? metadata.files : []
          for (const f of files)
            if (typeof f?.filePath === "string")
              writes.set(f.filePath, { path: f.filePath, mtime: state.time.end, tool: "apply_patch" })
        }
      }
    }
    return {
      writes: [...writes.values()].sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)),
      calls,
      sawBash,
    }
  }

  /**
   * Render the ledger for the continue message. ≤ maxTokens, tail-truncated:
   * content is ordered by importance (verified writes → unverified-shell note →
   * advisory → recent calls newest-first) so truncation drops the oldest calls first.
   */
  export function renderLedger(ledger: Ledger, opts?: { maxTokens?: number; recentCalls?: number }): string {
    const maxTokens = opts?.maxTokens ?? LEDGER_MAX_TOKENS
    const recentCalls = opts?.recentCalls ?? LEDGER_RECENT_CALLS
    if (!ledger.writes.length && !ledger.calls.length) return ""
    const lines: string[] = ["[Session state ledger — harness-recorded facts, generated automatically at compaction]"]
    if (ledger.writes.length) {
      lines.push("Files you wrote this session (verified write/edit tool events):")
      for (const w of ledger.writes) {
        lines.push(`- ${w.path} — last written by you at ${new Date(w.mtime).toISOString()} via ${w.tool}`)
      }
    }
    if (ledger.sawBash) {
      lines.push(
        "Shell commands also ran this session; any file changes they made are possible but unverified (shell writes produce no edit event).",
      )
    }
    lines.push(
      "Advisory: these files were last written by you at the times shown — prefer this ledger over re-reading them; re-read a file only if a tool errored, you suspect external changes (e.g. IDE edits), or you are about to edit it.",
    )
    if (ledger.calls.length) {
      const recent = ledger.calls.slice(-recentCalls).reverse()
      lines.push(`Recent tool calls, newest first (last ${recent.length} of ${ledger.calls.length}):`)
      for (const c of recent) {
        const status = c.errored ? "errored" : c.exit === undefined ? "ok" : c.exit === null ? "exit ?" : `exit ${c.exit}`
        lines.push(`- ${c.tool} (${status})${c.detail ? ` — ${c.detail}` : ""}`)
      }
    }
    while (lines.length > 1 && Token.estimate(lines.join("\n")) > maxTokens) lines.pop()
    return lines.join("\n")
  }

  // ── 5b: append-only summary carry ─────────────────────────────────────────
  // Previous round's Accomplished items are threaded into the next summarization
  // as anchors. An item carries as FACT ([verified]) only when a corroborating
  // ledger event exists (a write/edit event, or a zero-exit command naming the
  // artifact); otherwise it carries tagged "claimed, unverified". A naive carry
  // would REMEMBER invented deliverables (summaries can fabricate them) and
  // propagate them to every later summary and subagent.

  export type CarryStatus = "verified" | "claimed, unverified"
  export type CarryItem = { text: string; status: CarryStatus }

  const CARRY_TAG_RE = /^\[(verified|claimed, unverified)\]\s*(.*)$/i

  /** Extract bullet items under the "## Accomplished" heading of a summary. */
  export function extractAccomplished(summary: string): { text: string; priorStatus?: CarryStatus }[] {
    const out: { text: string; priorStatus?: CarryStatus }[] = []
    let inSection = false
    for (const raw of summary.split("\n")) {
      const line = raw.trim()
      if (/^#{1,6}\s/.test(line)) {
        inSection = /^#{1,6}\s*accomplished\b/i.test(line)
        continue
      }
      if (!inSection) continue
      const m = line.match(/^[-*]\s+(.*\S)\s*$/)
      if (!m) continue
      let text = m[1]!
      let priorStatus: CarryStatus | undefined
      const tag = text.match(CARRY_TAG_RE)
      if (tag) {
        priorStatus = tag[1]!.toLowerCase() as CarryStatus
        text = tag[2]!
      }
      if (text) out.push({ text, priorStatus })
    }
    return out
  }

  /** Path-like tokens (contain a dot or slash) — the artifact names a claim can be checked against. */
  function artifactTokens(text: string): string[] {
    return (text.match(/[A-Za-z0-9_@-]*[./][A-Za-z0-9_./-]+/g) ?? []).filter((t) => t.length >= 3 && /[A-Za-z]/.test(t))
  }

  function itemCorroborated(text: string, ledger: Ledger): boolean {
    for (const token of artifactTokens(text)) {
      const base = token.split("/").pop() ?? ""
      for (const w of ledger.writes) {
        if (w.path === token || w.path.endsWith("/" + token)) return true
        if (base && w.path.split("/").pop() === base) return true
      }
      // A zero-exit command naming the artifact also corroborates (command-agnostic —
      // no build/test classifier; the exit code plus artifact mention is the evidence).
      for (const c of ledger.calls) {
        if (!c.errored && c.exit === 0 && c.detail.includes(token)) return true
      }
    }
    return false
  }

  /**
   * Append-only status resolution: once [verified], always [verified] — the
   * corroborating event may have been compacted out of the retained window, so a
   * prior verified tag is preserved. Unverified claims may be promoted when
   * evidence appears, never silently demoted or dropped.
   */
  export function corroborateCarry(items: { text: string; priorStatus?: CarryStatus }[], ledger: Ledger): CarryItem[] {
    return items.map((item) => ({
      text: item.text,
      status:
        item.priorStatus === "verified" || itemCorroborated(item.text, ledger)
          ? "verified"
          : ("claimed, unverified" as const),
    }))
  }

  export function renderCarryAnchors(items: CarryItem[], maxTokens: number = LEDGER_MAX_TOKENS): string {
    if (!items.length) return ""
    const header = [
      "## Previous-summary anchors (append-only carry)",
      "Earlier compaction rounds recorded these Accomplished items. Carry EVERY item below into the new summary's Accomplished section with its tag verbatim, then append newly accomplished work after them:",
    ]
    const footer = [
      "Items tagged [claimed, unverified] had no corroborating tool event (no write/edit event or successful command naming that artifact); keep the tag so later agents do not treat them as established fact. Never promote or remove a tag yourself.",
    ]
    let body = items.map((i) => `- [${i.status}] ${i.text}`)
    // Append-only carry grows monotonically; when over budget drop the OLDEST
    // items (front of the list) — the freshest anchors are the ones the next
    // round needs to not lose.
    while (body.length > 1 && Token.estimate([...header, ...body, ...footer].join("\n")) > maxTokens) {
      body = body.slice(1)
    }
    return [...header, ...body, ...footer].join("\n")
  }

  /** Most recent committed summary text, if any (assistant, summary, finished, no error). */
  export function latestSummaryText(messages: MessageV2.WithParts[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.info.role !== "assistant" || !msg.info.summary || !msg.info.finish || msg.info.error) continue
      const text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      return text.trim() ? text : undefined
    }
    return undefined
  }

  // ── 5c: first-person summary reframe — layered as an ADDITION to whatever
  // summary prompt is active (default or plugin-provided), never a replacement.
  export const FIRST_PERSON_REFRAME =
    "Additionally: write the summary in the first person, as your own working memory — you are summarizing YOUR OWN work in progress, and the agent reading it next is you, continuing the same task. Say \"I edited…\", \"I verified…\", \"I still need to…\" rather than describing the work as another agent's or the user's."
  // altimate_change end

  // altimate_change start — compaction attempt tracking for loop protection
  const compactionAttempts = new Map<string, number>()
  // altimate_change end

  // altimate_change start — pin the original task
  // verbatim through compaction (budget math + livelock guard).
  //
  // Threshold rationale (config-exposed defaults, not fitted to any one workload):
  // - PIN_MAX_TOKENS 4096: task statements rarely exceed ~4k tokens; larger
  //   ones keep verbatim head+tail plus a contract card.
  // - PIN_WINDOW_FRACTION 0.175: the pin must stay a small minority of the
  //   post-overhead usable window so working context dominates.
  // - PIN_WORKING_SLACK 2000: hard invariant
  //   `pin + reserved + ≥2k working slack < compaction threshold`. A fixed 4k
  //   pin on a small window would otherwise produce a compaction livelock
  //   (fires, cannot reduce below threshold, re-fires). Shrink the pin, never
  //   violate the invariant.
  // - PIN_CARD_MAX_TOKENS 500: contract-card budget.
  export const PIN_MAX_TOKENS = 4_096
  export const PIN_WINDOW_FRACTION = 0.175
  export const PIN_WORKING_SLACK = 2_000
  export const PIN_CARD_MAX_TOKENS = 500

  export function pinEnabled(cfg: ConfigInfo) {
    return cfg.compaction?.pin_task !== false
  }

  export function pinCardBudget(cfg: ConfigInfo) {
    return cfg.compaction?.pin_card_max_tokens ?? PIN_CARD_MAX_TOKENS
  }

  // Dynamic cap: min(pin_max_tokens, pin_window_fraction × post-overhead usable
  // window), clamped by the livelock invariant and any per-session livelock
  // halving. Returns 0 when no pin fits — the pin is then skipped entirely.
  export function pinBudget(input: { cfg: ConfigInfo; model: Provider.Model; sessionID?: string }): number {
    if (!pinEnabled(input.cfg)) return 0
    const context = input.model.limit.context
    if (context === 0) return 0
    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const reserved = input.cfg.compaction?.reserved ?? COMPACTION_BUFFER
    const headroom = Math.max(reserved, maxOutput)
    const base = input.model.limit.input ?? context
    // The pin capacity is computed from the EXACT overflow trigger isOverflow()
    // uses (shared overflowThreshold helper). Computing it from the raw
    // `base - headroom` boundary instead admitted pins that, together with the
    // reserved buffer and working slack, exceeded the (safety-fraction-scaled)
    // trigger — the session re-overflowed immediately after every compaction.
    if (base <= headroom) return 0
    const threshold = overflowThreshold({ base, headroom, fraction: contextSafetyFraction(input.cfg) })
    if (threshold <= 0) return 0
    const maxTokens = input.cfg.compaction?.pin_max_tokens ?? PIN_MAX_TOKENS
    const fraction = input.cfg.compaction?.pin_window_fraction ?? PIN_WINDOW_FRACTION
    // Hard invariant: pin + reserved + ≥2k working slack < compaction threshold.
    const invariantCap = threshold - reserved - PIN_WORKING_SLACK
    const cap = Math.min(maxTokens, Math.floor(threshold * fraction), invariantCap)
    if (cap <= 0) return 0
    return Math.max(0, Math.floor(cap * pinScale(input.sessionID)))
  }

  // Livelock guard: two CONSECUTIVE auto-compactions that failed to get the
  // session below threshold halve the pin for the rest of the session (and
  // halve again on each further pair). "Failed to reduce below threshold" is
  // detected structurally: a new auto-compaction fires while at most one
  // finished non-summary assistant turn exists after the previous completed
  // summary — i.e. the session re-overflowed immediately.
  const pinState = new Map<string, { failures: number; scale: number }>()

  export function pinScale(sessionID?: string): number {
    if (!sessionID) return 1
    return pinState.get(sessionID)?.scale ?? 1
  }

  /** Test hook: clear livelock state for one session, or all sessions. */
  export function resetPinState(sessionID?: string) {
    if (sessionID) pinState.delete(sessionID)
    else pinState.clear()
  }

  /** Called by the auto-overflow paths in prompt.ts BEFORE creating a new compaction. */
  export function notePinCompaction(sessionID: string, msgs: MessageV2.WithParts[]) {
    const state = pinState.get(sessionID) ?? { failures: 0, scale: 1 }
    let lastSummary = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role === "assistant" && info.summary && info.finish && !info.error) {
        lastSummary = i
        break
      }
    }
    let immediate = false
    if (lastSummary >= 0) {
      let finished = 0
      for (let i = lastSummary + 1; i < msgs.length; i++) {
        const info = msgs[i].info
        if (info.role === "assistant" && info.finish && !info.summary) finished++
      }
      immediate = finished <= 1
    }
    state.failures = immediate ? state.failures + 1 : 0
    if (state.failures >= 2) {
      state.scale /= 2
      state.failures = 0
      log.warn("task pin halved — consecutive compactions failed to reduce below threshold", {
        sessionID,
        scale: state.scale,
      })
    }
    pinState.set(sessionID, state)
  }

  // Summary-template line, layered as an ADDITION to the active summary prompt
  // (never a replacement — a plugin-supplied custom prompt REPLACES the
  // platform's preservation prompt, which is exactly the failure mode the plan
  // warns about; this constant is only ever appended).
  export const PIN_SUMMARY_ADDITION =
    "Do NOT restate the original task requirements in the summary — the original task text is pinned separately and stays visible alongside this summary. If anything in this summary conflicts with the pinned original task, the pinned task is authoritative."
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
      // Returning undefined here made the prompt loop's `continue` re-enter
      // process() immediately (the pending compaction marker stays unresolved),
      // hot-spinning with a telemetry event per iteration. Return "stop" so the
      // caller breaks, and clear the counter so a later prompt gets a fresh
      // bounded set of attempts instead of tripping the breaker instantly.
      log.warn("compaction circuit breaker", { sessionID: input.sessionID, attempt })
      compactionAttempts.delete(input.sessionID)
      return "stop"
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
    // altimate_change start — state ledger + summary carry wiring
    const ledgerEnabled = cfg.compaction?.state_ledger !== false
    const carryEnabled = cfg.compaction?.summary_carry !== false
    const firstPersonEnabled = cfg.compaction?.summary_first_person !== false
    const ledgerMaxTokens = cfg.compaction?.ledger_max_tokens ?? LEDGER_MAX_TOKENS
    const ledgerRecentCalls = cfg.compaction?.ledger_recent_calls ?? LEDGER_RECENT_CALLS
    const ledger: Ledger =
      ledgerEnabled || carryEnabled ? buildLedger(input.messages) : { writes: [], calls: [], sawBash: false }
    // altimate_change end
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

    // altimate_change start — summary carry + first-person reframe: layered ADDITIONS to whichever
    // summary prompt is active (default or plugin-provided) — never a replacement.
    let promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    if (carryEnabled) {
      const previousSummary = latestSummaryText(input.messages)
      if (previousSummary) {
        const anchors = renderCarryAnchors(
          corroborateCarry(extractAccomplished(previousSummary), ledger),
          ledgerMaxTokens,
        )
        if (anchors) promptText += "\n\n" + anchors
      }
    }
    if (firstPersonEnabled) promptText += "\n\n" + FIRST_PERSON_REFRAME
    // altimate_change end
    // altimate_change start — when task pinning is
    // active, tell the summarizer not to burn summary tokens restating the task
    // (the original task is pinned separately and re-injected after compaction).
    // Layered as an ADDITION to whichever summary prompt is active — never a
    // replacement.
    if (pinEnabled(cfg)) promptText += "\n\n" + PIN_SUMMARY_ADDITION
    // altimate_change end
    // altimate_change start — summarizer integrity:
    // hoist the summarizer input so a failed attempt can be retried with identical
    // input, and pass an explicit toolChoice "none". Previously toolChoice was
    // undefined, which the AI SDK defaults to "auto" — models could spend the
    // summary step on a tool call and commit a summary with no text.
    const summarizerInput: LLM.StreamInput = {
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      toolChoice: "none" as const,
      messages: [
        // altimate_change start — upstream_fix: summarize only the selected head when preserving recent tail;
        // trim the head from the front when even the summarization request cannot fit the window
        ...(await MessageV2.toModelMessages(
          await (async () => {
            const fitted = await fitHead({ head: selected.head, model, fraction: contextSafetyFraction(cfg) })
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
    }
    // A "continue" result was previously committed regardless of whether the
    // summary step produced any text — an empty summary erases history (the
    // post-compaction amnesia signature). Guard the commit: retry ONCE with
    // identical input, then mark the summary message as errored and stop.
    const summaryHasText = () =>
      MessageV2.get({ sessionID: input.sessionID, messageID: msg.id }).parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      )
    let result = await processor.process(summarizerInput)
    if (result === "continue" && !summaryHasText()) {
      log.warn("compaction summary empty, retrying once", { sessionID: input.sessionID })
      result = await processor.process(summarizerInput)
      if (result === "continue" && !summaryHasText()) {
        processor.message.error = new NamedError.Unknown({
          message: "Compaction summarizer produced no summary text after retry",
        }).toObject()
        processor.message.finish = "error"
        await Session.updateMessage(processor.message)
        result = "stop"
      }
    }
    // altimate_change end

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      compactionAttempts.delete(input.sessionID) // altimate_change — cleanup on too-large-to-compact stop
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
        // altimate_change start — the continue message
        // carries the original format/tools/system/variant, exactly as the replay
        // branch above copies them from the original user message. Dropping them made
        // the first auto-compaction silently reset the session's tool allowlist,
        // custom system prompt, output format, and variant. The compaction marker
        // (this branch's userMessage) never carries these fields, so source them from
        // the most recent real (non-compaction) user message; no-op when never set.
        const original = messages.findLast(
          (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"),
        )?.info as MessageV2.User | undefined
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
          format: original?.format ?? userMessage.format,
          tools: original?.tools ?? userMessage.tools,
          system: original?.system ?? userMessage.system,
          variant: original?.variant ?? userMessage.variant,
        })
        // altimate_change end
        // altimate_change start — deterministic corroborated-facts-only
        // state ledger appended to the synthetic continue message (all-modes, compaction-gated).
        const ledgerText = ledgerEnabled
          ? renderLedger(ledger, { maxTokens: ledgerMaxTokens, recentCalls: ledgerRecentCalls })
          : ""
        // altimate_change end
        // altimate_change start — completion-aware termination path:
        // (b) the continue message carries the three-option completion-aware nudge
        //     (continue / ask for clarification / assert DONE), giving a finished
        //     session a termination path. Delivered via the NudgeArbiter (Global
        //     rule 5): this injection point registers its candidate and takes the
        //     single winner, so pending lower-precedence directives (starvation
        //     breaker, budget reminder) are consumed here and the injected turn
        //     never carries two system-authored directive blocks. The termination
        //     nudge has top precedence, so it always wins at this site.
        // (d) the overflow notice is mechanism-accurate — the old text falsely
        //     blamed "large media attachments" (see SessionTermination.OVERFLOW_NOTICE).
        NudgeArbiter.register(input.sessionID, {
          source: "termination_challenge",
          kind: "completion_nudge",
          text: SessionTermination.COMPLETION_NUDGE,
        })
        const directive = NudgeArbiter.take(input.sessionID)
        const text =
          (input.overflow ? SessionTermination.OVERFLOW_NOTICE + "\n\n" : "") +
          (directive?.text ?? SessionTermination.COMPLETION_NUDGE) +
          // altimate_change end
          // altimate_change start — state ledger
          (ledgerText ? "\n\n" + ledgerText : "")
        // altimate_change end
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

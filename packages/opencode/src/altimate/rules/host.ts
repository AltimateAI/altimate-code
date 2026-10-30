// altimate_change - new file
//
// Workspace rules in a host agent's session (Claude Code or Codex through the altimate-code plugin). altimate-code never
// sees that conversation: the plugin's hooks call `altimate-code learn hook <event>` with the host's hook input.
// - session start: a bounded pull, then the team rules for this repository, the proposals waiting for the person and
//   reviews since the last session, as context for the host agent. The rules given are recorded as shown to that
//   session, so "corrected again", usage and the shown-rule edit path count it.
// - prompt submit: "remember … as a team rule" becomes a stored proposal; a message that reads as a correction is
//   recorded as a signal of the host session. No model call.
// - stop: the after-turn check for the host session (at most one drafting call per Stop). No client shows cards there,
//   so a proposal is stored for `learn proposals` (the plugin's `/altimate-code:rules`). Then queued proposals and usage
//   are sent.
// Every step follows the same gates as delivery and capture: learning on for this project, workspaces on, linked, and
// signed in as the account the rules were pulled for.
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { correctionReason } from "../learn/correction"
import type { DigestCall, DigestSource } from "../learn/digest"
import * as Playbook from "../learn/playbook"
import { appendSignal, isHostSession, readSignals } from "../learn/signals"
import { printable } from "./printable"
import { RuleProposal } from "./proposal"
import { alive } from "./remember"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"
import { RuleTrigger } from "./trigger"

const log = Log.create({ service: "rules.host" })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

type LearnConfig = (NonNullable<Parameters<typeof RuleTrigger.afterTurn>[0]["learn"]> & { model?: string }) | undefined

export const HOSTS = ["claude", "codex"] as const
export type Host = (typeof HOSTS)[number]

/** A host session id, namespaced so it can never be taken for an altimate-code session (`isHostSession`). */
export function hostSession(host: Host, id: string): string {
  return `${host}:${id}`
}

/** The fields of a Claude Code or Codex hook input this uses. */
export interface HookInput {
  session_id?: string
  transcript_path?: string
  prompt?: string
}

/** What a host session start learns about workspace rules. `rules` is empty when nothing may be shown. */
export interface Start {
  workspace?: { name: string; owner_name?: string | null; is_owner: boolean }
  rules: { text: string; applies_to: string[] }[]
  proposals: number
  notices: RulesStore.Notice[]
  /** The last check for proposed rules failed (no model available, …): said once, so the person can fix it. */
  check_failed?: string
}

/** How long a session start waits for a pull before answering from the last one. */
export const START_WAIT_MS = 3_000
/** A project with no pulled rules yet waits longer: without them, nothing else here runs. */
export const FIRST_PULL_WAIT_MS = 8_000
/** The whole session start, pull included, ends within this: the plugin's hook timeout is 15s and the CLI takes about a
 * second to start. Recording the rules as shown and marking notices seen are best effort within what is left. */
export const START_DEADLINE_MS = 11_000
/** A review notice older than this is not reported at a host session start: the first one after an upgrade would
 * otherwise report every review ever kept. */
export const NOTICE_MAX_AGE_MS = 14 * 24 * 60 * 60_000
/** A check round that has run this long is taken to have died (its pid may be reused). One drafting call times out at
 * 2 minutes; the claim's time is renewed every round. */
export const CHECK_STALE_MS = 4 * 60_000
/** A leftover session whose check failed is not retried before this: a failing model is not called every turn. */
export const RETRY_FAILED_MS = 30 * 60_000
/** Checks one Stop runs for its session at most: the first, then one per round of Stops that arrived meanwhile. */
const MAX_CHECK_ROUNDS = 3

/** Learning is on, workspaces are on, the project is linked to a workspace, and the person signed in now is the one the
 * rules were pulled for (a sync that would clear them after a sign-out or an account change may not have run yet). */
async function on(root: string, learn: LearnConfig, state?: RulesStore.State) {
  if (!RulesSync.rulesEnabled(learn)) return false
  const current = state ?? (await RulesStore.read(root))
  if (!current.workspace || !RuleTrigger.learningEnabled(learn, current)) return false
  return RulesStore.verified(current)
}

/**
 * The team rules, open proposals and new review notices for a host session start. With `session`, the rules are
 * recorded as shown to it and the notices reported are not reported again. Pulls (never pushes: the hook's process may
 * exit mid-way) when one is due or the rules are not verified for this credential, waiting at most `waitMs`.
 */
export async function start(input: {
  root: string
  directory: string
  learn: LearnConfig
  session?: string
  waitMs?: number
  /** Overrides `START_DEADLINE_MS` (tests). */
  deadlineMs?: number
}): Promise<Start> {
  const none: Start = { rules: [], proposals: 0, notices: [] }
  const deadline = Date.now() + (input.deadlineMs ?? START_DEADLINE_MS)
  const left = () => Math.max(0, deadline - Date.now())
  /** `work`, or `fallback` once the deadline passes (the work goes on; the hook's process may exit under it). */
  const within = <T>(work: Promise<T>, fallback: T) =>
    Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), left()).unref?.())])
  const { RulesService } = await import("./service")
  if (!RulesSync.rulesEnabled(input.learn) || !(await RulesService.linked(input.root, input.directory))) return none
  const before = await RulesStore.read(input.root)
  if (!RulesSync.pullFailedRecently(before) && (!(await RulesStore.verified(before)) || (await RulesSync.due(input.root))))
    await RulesSync.pullWithin(input.root, input.directory, input.learn, Math.min(left(), input.waitMs ?? (before.scope ? START_WAIT_MS : FIRST_PULL_WAIT_MS)))
  const state = await RulesStore.read(input.root)
  if (!(await on(input.root, input.learn, state))) return none
  // The same selection either way: pinned first, within the start budget.
  const { renderSection, resolveLimits } = await import("../learn/select")
  const all = state.rules.map(RulesStore.toLesson).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  const selected = renderSection(all, resolveLimits(input.learn as Parameters<typeof resolveLimits>[0]).budget_tokens).lessons
  // Recorded as shown when the learn lock allows within the deadline (a busy TUI may hold it): given either way.
  const lessons = input.session
    ? await within(
        import("../learn/delivery")
          .then(({ Delivery }) =>
            new Delivery(input.root, input.learn as ConstructorParameters<typeof Delivery>[1], input.directory).recordStart(input.session!, RulesStore.WORKSPACE_RULES_STORE))
          .catch((error) => {
            log.warn("host session rules not recorded as shown", { error: errorText(error) })
            return selected
          }),
        selected,
      )
    : selected
  const seen = new Set(state.host_notices_seen)
  const now = Date.now()
  const notices = state.notices.filter((notice) => !seen.has(noticeKey(notice)) && !(now - Date.parse(notice.at) > NOTICE_MAX_AGE_MS))
  const failed = state.last_check?.outcome.startsWith("failed") && !seen.has(checkKey(state.last_check)) ? state.last_check : undefined
  // Marked seen only if the write lands in time: otherwise they are said again next time, never lost.
  if (input.session && (notices.length || failed))
    await within(
      RulesStore.update(input.root, (s) => {
        const keys = [...notices.map(noticeKey), ...(failed ? [checkKey(failed)] : [])]
        s.host_notices_seen = [...s.host_notices_seen, ...keys.filter((key) => !s.host_notices_seen.includes(key))]
      }).catch((error) => log.warn("host notices not marked seen", { error: errorText(error) })),
      undefined,
    )
  return {
    workspace: state.workspace,
    rules: lessons.map((lesson) => ({ text: lesson.text, applies_to: lesson.trigger?.paths ?? [] })),
    proposals: (await RuleProposal.storedFor(input.root)).length,
    notices,
    ...(failed ? { check_failed: failed.outcome.replace(/^failed:\s*/, "") } : {}),
  }
}

const noticeKey = (notice: RulesStore.Notice) => `${notice.public_id}|${notice.status}`
const checkKey = (check: NonNullable<RulesStore.State["last_check"]>) => `check|${check.at}`

/** `start` as context for the host agent; empty when there is nothing to say. Server text is made printable. */
export function context(start: Start, command = "/altimate-code:rules"): string {
  const lines: string[] = []
  const ws = printable(start.workspace?.name ?? "the workspace")
  if (start.rules.length) {
    lines.push(`Team rules from ${ws} for this repository (approved by the workspace owner; they apply to all work here, including code you write yourself):`)
    for (const rule of start.rules)
      lines.push(`- ${printable(rule.text)}${rule.applies_to.length ? ` (applies to ${rule.applies_to.map(printable).join(", ")})` : ""}`)
  }
  if (start.proposals)
    lines.push(`${start.proposals} proposed team ${start.proposals === 1 ? "rule is" : "rules are"} waiting for the person's answer: they can review ${start.proposals === 1 ? "it" : "them"} with ${command}.` +
      (start.proposals >= RulesStore.MAX_STORED_PROPOSALS ? " New proposals from corrections wait until some are answered." : ""))
  if (start.notices.length) {
    lines.push(`Reviews of the person's proposed rules in ${ws} since their last session:`)
    for (const notice of start.notices) {
      const status = notice.status === "active" ? "approved" : printable(notice.status)
      lines.push(`- ${status}${notice.reviewer ? ` by ${printable(notice.reviewer)}` : ""}: "${printable(notice.text)}"${notice.reason ? ` — ${printable(notice.reason)}` : ""}`)
    }
  }
  if (start.check_failed)
    lines.push(`The last check of the person's corrections for proposed team rules failed (${printable(start.check_failed)}). It needs a model altimate-code can use: \`altimate-code learn status\` shows the setting.`)
  return lines.join("\n")
}

/** "Remember this as a team rule: X", "save as a rule - X", "don't forget, team rule: X": a request that names a team rule,
 * and what it is. Only explicit wording: "remember to run the tests" or "do you remember …?" is the conversation, not a
 * rule. The cue words are the ones `RulesRemember` treats as asking to remember. */
const REMEMBER = /\b(?:remember|don'?t forget|do not forget|keep in mind|note|save|from now on)\b,?(?:\s+(?:this|that|it))?\s+(?:as\s+)?(?:an?\s+)?(?:team\s+)?rule\b\s*[:,-]\s*(.+)$/i
/** Shorter than this after the cue is not a rule ("remember?", "remember this"). */
const MIN_REMEMBERED = 8

/**
 * A host prompt: "remember … as a team rule" becomes a stored explicit proposal (a fact or preference is left to the host
 * agent's own memory), and a message that reads as a correction is recorded as a signal of `session`. No model call.
 * `explicit: false` records corrections only (a prompt read back from the transcript at Stop was already handled).
 */
export async function recordCorrection(input: {
  root: string
  directory: string
  learn: LearnConfig
  session: string
  text: string
  explicit?: boolean
}): Promise<"proposed" | "not_stored" | "recorded" | "duplicate" | "not_correction" | "off"> {
  if (!(await on(input.root, input.learn))) return "off"
  if (input.explicit !== false) {
    // The rule may follow on the next line ("Remember this as a team rule:\nAlways …").
    const remembered = REMEMBER.exec(input.text.replace(/\s*\n\s*/g, " "))?.[1]?.trim()
    if (remembered && remembered.length >= MIN_REMEMBERED) {
      const result = await RuleTrigger.explicit({
        sessionID: input.session, root: input.root, directory: input.directory, learn: input.learn, text: remembered, said: input.text,
        persist: true, request: { session: input.session, via: "training" },
      })
      if (result.status === "shown") return result.card ? "proposed" : "not_stored"
    }
  }
  const reason = correctionReason(input.text)
  if (!reason) return "not_correction"
  const signal = await appendSignal(input.root, {
    kind: "user_correction",
    sessionID: input.session,
    text: input.text,
    reason,
    correctedAt: new Date().toISOString(),
  })
  if (!signal) return "duplicate"
  // A check of this session already running took its corrections before this one: it checks again before it ends.
  await RulesStore.update(input.root, (s) => {
    const claim = s.host_checks[input.session]
    if (claim && claim.pid !== process.pid) claim.pending = (claim.pending ?? 0) + 1
  }).catch((error) => log.warn("host check not told of a new correction", { error: errorText(error) }))
  return "recorded"
}

/** Claim the check of `session` for this process. False while another live process holds it; then that check is told to
 * run again (`pending`), so this Stop's corrections are not left unchecked. */
async function claimCheck(root: string, session: string, markPending: boolean): Promise<boolean> {
  let held = false
  await RulesStore.update(root, (s) => {
    const claim = s.host_checks[session]
    if (claim && claim.pid !== process.pid && alive(claim.pid) && Date.now() - Date.parse(claim.at) < CHECK_STALE_MS) {
      held = true
      if (markPending) claim.pending = (claim.pending ?? 0) + 1
      return
    }
    s.host_checks[session] = { pid: process.pid, at: new Date().toISOString() }
  })
  return !held
}

/** Release the claim of `session`, unless more work arrived for it meanwhile: then it is kept, and true is returned. One
 * write, so work marked after it is seen by nobody only when no claim exists, and the next check finds it. */
async function releaseCheck(root: string, session: string): Promise<boolean> {
  let more = false
  await RulesStore.update(root, (s) => {
    const claim = s.host_checks[session]
    if (claim?.pid !== process.pid) return
    if (claim.pending) {
      more = true
      claim.pending = 0
      claim.at = new Date().toISOString()
    } else delete s.host_checks[session]
  })
  return more
}

/**
 * The after-turn check of host session `session`, its proposal stored. A Stop of a session whose check is already
 * running leaves it to that check, which runs again before it ends. A Stop of a session with nothing new checks one other
 * host session whose corrections were left unchecked (its last turn ended while a check ran). Then queued proposals and
 * usage are sent when due. At most one drafting call per check. Returns what this session's check decided.
 */
export async function check(input: { root: string; directory: string; learn: LearnConfig; session: string; transcript?: string }): Promise<string> {
  if (!(await on(input.root, input.learn))) return "learning or workspaces are off, signed out, or this project is not linked"
  if (input.transcript && !(await regularFile(input.transcript))) input = { ...input, transcript: undefined }
  // This turn's prompt hook may not have recorded its correction yet: the transcript's last prompt is recorded here too
  // (signals are deduplicated by text).
  const transcript = input.transcript ? await sourceFromTranscript(input.transcript).catch((error) => {
    log.warn("host transcript not read", { error: errorText(error) })
    return undefined
  }) : undefined
  const last = transcript?.prompts.at(-1)
  if (last) await recordCorrection({ ...input, text: last, explicit: false }).catch((error) => log.warn("last prompt not recorded", { error: errorText(error) }))
  if (!(await claimCheck(input.root, input.session, true))) return "another check of this session is running; it checks again before it ends"
  const reread = async () => (input.transcript ? await sourceFromTranscript(input.transcript).catch(() => transcript) : transcript)
  const outcome = await runRounds(input, input.session, transcript, reread)
  if (outcome === "no new corrections") await checkLeftover(input)
  const state = await RulesStore.read(input.root)
  if (state.outbox.length || (await RulesSync.due(input.root)))
    await RulesSync.runShared(input.root, input.directory, input.learn, "cli").catch((error) =>
      log.warn("rules sync after host check failed", { error: errorText(error) }))
  return outcome
}

/**
 * Check `session` under the claim this process holds, again while work arrives for it (`pending`), at most
 * `MAX_CHECK_ROUNDS` times; then release the claim. Work still pending at the limit is kept in `host_pending`, so the next
 * check with nothing new takes it first. Returns the last round's outcome.
 */
async function runRounds(
  input: Parameters<typeof check>[0],
  session: string,
  transcript: DigestSource | undefined,
  reread: () => Promise<DigestSource | undefined>,
): Promise<string> {
  let outcome = "no new corrections"
  try {
    outcome = await checkSession(input, session, transcript)
    for (let round = 1; await releaseCheck(input.root, session); round++) {
      if (round >= MAX_CHECK_ROUNDS) {
        await RulesStore.update(input.root, (s) => {
          if (!s.host_pending.includes(session)) s.host_pending.push(session)
        })
        break
      }
      outcome = await checkSession(input, session, await reread())
    }
  } finally {
    await RulesStore.update(input.root, (s) => {
      if (s.host_checks[session]?.pid === process.pid) delete s.host_checks[session]
    }).catch((error) => log.warn("host check claim not released", { error: errorText(error) }))
  }
  return outcome
}

/**
 * One other host session with corrections no check has seen: first a session whose check stopped with work left
 * (`host_pending`), then the oldest unchecked correction's session. Skipped: sessions another check holds, sessions with
 * a proposal still waiting for an answer (their check would not draft), and sessions whose check failed within
 * `RETRY_FAILED_MS`.
 */
async function checkLeftover(input: Parameters<typeof check>[0]) {
  const state = await RulesStore.read(input.root)
  const processed = new Set(state.processed_signals)
  const waiting = new Set((await RuleProposal.stored(input.root)).map((card) => card.sessionID))
  const now = Date.now()
  const eligible = (session: string) => {
    if (session === input.session || waiting.has(session)) return false
    const claim = state.host_checks[session]
    if (claim && alive(claim.pid) && now - Date.parse(claim.at) < CHECK_STALE_MS) return false
    const retry = state.host_retry[session]
    return !retry || Date.parse(retry) <= now
  }
  const unchecked = (await readSignals(input.root, Playbook.DEFAULT_NAME))
    .filter((signal) => signal.kind === "user_correction" && isHostSession(signal.sessionID) && !processed.has(signal.id))
    .map((signal) => signal.sessionID)
  const leftover = [...state.host_pending, ...unchecked].find(eligible)
  if (!leftover || !(await claimCheck(input.root, leftover, false))) return
  await RulesStore.update(input.root, (s) => {
    s.host_pending = s.host_pending.filter((session) => session !== leftover)
  })
  await runRounds(input, leftover, undefined, async () => undefined)
}

async function checkSession(input: Parameters<typeof check>[0], session: string, transcript: DigestSource | undefined): Promise<string> {
  const deps: RuleTrigger.TriggerDeps = {
    source: async () => {
      if (transcript) return transcript
      const corrections = (await readSignals(input.root, Playbook.DEFAULT_NAME))
        .filter((signal) => signal.kind === "user_correction" && signal.sessionID === session)
        .map((signal) => signal.text)
      return { prompts: corrections, calls: [] }
    },
    generate: (source, onUsage) => generate(input.learn?.model, source, onUsage),
  }
  const outcome = await RuleTrigger.afterTurn({ sessionID: session, root: input.root, directory: input.directory, learn: input.learn, deps, persist: true })
  // A failed check is retried as a leftover only after `RETRY_FAILED_MS`; its own session's next turn retries it anyway.
  await RulesStore.update(input.root, (s) => {
    for (const [key, at] of Object.entries(s.host_retry)) if (Date.parse(at) <= Date.now()) delete s.host_retry[key]
    if (outcome.startsWith("failed")) s.host_retry[session] = new Date(Date.now() + RETRY_FAILED_MS).toISOString()
    else delete s.host_retry[session]
  }).catch((error) => log.warn("host check retry not recorded", { error: errorText(error) }))
  return outcome
}

/** A transcript path from the host is read only when it is a regular file (a FIFO would block the check). */
async function regularFile(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile(), () => false)
}

/** The drafting model: `learn.model`, else the default model (like `learn reflect` without `--model`). */
async function generate(model: string | undefined, source: DigestSource, onUsage?: Parameters<RuleTrigger.TriggerDeps["generate"]>[1]) {
  const [{ Provider }, { AppRuntime }, { DEFAULT_TIMEOUT_MS, providerGenerate }, { learnModel }] = await Promise.all([
    import("@/provider/provider"),
    import("@/effect/app-runtime"),
    import("../learn/reflect"),
    import("../learn/auto"),
  ])
  const chosen = learnModel(model)
  const parsed = chosen ? Provider.parseModel(chosen) : source.model
  if (!parsed) {
    const { FreeTier } = await import("../free/client")
    await FreeTier.autoRegisterWithin(undefined, () => {})
  }
  return AppRuntime.runPromise(providerGenerate(parsed, DEFAULT_TIMEOUT_MS, undefined, onUsage))
}

const CODEX_INJECTED = /^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/

/** The newest part of a transcript read at most: the drafter sees a bounded digest anyway. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

/**
 * A digest source from a host transcript (JSON lines): Claude Code (`{type: "user" | "assistant", message}`) or Codex
 * (`{type: "response_item", payload}`). Undefined when it holds no prompt.
 */
export async function sourceFromTranscript(file: string): Promise<DigestSource | undefined> {
  const handle = await fs.open(file, "r")
  let text: string
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, MAX_TRANSCRIPT_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    text = buffer.toString("utf8")
    // Started mid-line: the first line is partial (and with no line break, so is everything read).
    if (size > length) {
      const start = text.indexOf("\n")
      text = start < 0 ? "" : text.slice(start + 1)
    }
  } finally {
    await handle.close()
  }
  const prompts: string[] = []
  const calls: DigestCall[] = []
  const byId = new Map<string, DigestCall>()
  let finalText: string | undefined
  const call = (id: string | undefined, name: string, input: unknown) => {
    const entry: DigestCall = { name, input }
    calls.push(entry)
    if (id) byId.set(id, entry)
  }
  const result = (id: string | undefined, output: unknown, error?: boolean) => {
    const entry = id ? byId.get(id) : undefined
    if (!entry) return
    const value = typeof output === "string" ? output : JSON.stringify(output)
    if (error) entry.error = value
    else entry.output = value
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type === "user" || row?.type === "assistant") {
      // Claude Code. Rows it injects (command output, reminders) and a subagent's are not the person's conversation.
      if (row.isMeta === true || row.isSidechain === true) continue
      const content = row.message?.content
      if (typeof content === "string") {
        if (row.type === "user") prompts.push(content)
        else finalText = content
        continue
      }
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          if (row.type === "user") prompts.push(part.text)
          else finalText = part.text
        } else if (part?.type === "tool_use") call(part.id, String(part.name), part.input)
        else if (part?.type === "tool_result") result(part.tool_use_id, part.content, part.is_error === true)
      }
    } else if (row?.type === "response_item") {
      // Codex
      const item = row.payload
      if (item?.type === "message" && Array.isArray(item.content)) {
        const said = item.content.filter((part: any) => typeof part?.text === "string").map((part: any) => part.text).join("\n")
        if (!said) continue
        // Codex sends the environment and AGENTS.md instructions as user messages.
        if (item.role === "user" && !CODEX_INJECTED.test(said)) prompts.push(said)
        else if (item.role === "assistant") finalText = said
      } else if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        let args: unknown = item.arguments ?? item.input
        if (typeof args === "string") {
          try {
            args = JSON.parse(args)
          } catch {}
        }
        call(item.call_id, String(item.name), args)
      } else if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
        result(item.call_id, item.output?.content ?? item.output)
      }
    }
  }
  if (!prompts.length) return undefined
  return { prompts, calls, ...(finalText ? { finalText } : {}) }
}

export * as RulesHost from "./host"

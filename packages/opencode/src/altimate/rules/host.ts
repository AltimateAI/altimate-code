// altimate_change - new file
//
// Workspace rules in a host agent's session (Claude Code or Codex through the altimate-code plugin). altimate-code never
// sees that conversation: the plugin's hooks call `altimate-code learn hook <event>` with the host's hook input.
// - session start: a bounded sync, then the team rules for this repository, the proposals waiting for the person and
//   reviews since the last session, as context for the host agent. The rules given are recorded as shown to that
//   session, so "corrected again", usage and the shown-rule edit path count it.
// - prompt submit: a message that reads as a correction is recorded as a signal of the host session. No model call.
// - stop: the after-turn check for the host session (at most one drafting call). No client shows cards there, so a
//   proposal is stored for `learn proposals` (the plugin's `/altimate-code:rules`).
// Every step follows the same gates as delivery and capture: learning on for this project, workspaces on, linked.
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { correctionReason } from "../learn/correction"
import type { DigestCall, DigestSource } from "../learn/digest"
import * as Playbook from "../learn/playbook"
import { appendSignal, readSignals } from "../learn/signals"
import { printable } from "./printable"
import { RuleProposal } from "./proposal"
import { alive } from "./remember"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"
import { RuleTrigger } from "./trigger"

const log = Log.create({ service: "rules.host" })

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
}

/** How long a session start waits for a sync before answering from the last one. */
export const START_WAIT_MS = 3_000

/** Learning is on, workspaces are on, the project is linked to a workspace, and someone is signed in to Altimate (a sync
 * that would clear the rules after a sign-out may not have run yet). No network. */
async function on(root: string, learn: LearnConfig, state?: RulesStore.State) {
  if (!RulesSync.rulesEnabled(learn)) return false
  const current = state ?? (await RulesStore.read(root))
  if (!current.workspace || !RuleTrigger.learningEnabled(learn, current)) return false
  const { WorkspaceApi } = await import("../workspace/api-client")
  return !!(await WorkspaceApi.captureCredentials())
}

/** A review notice older than this is not reported at a host session start: the first one after an upgrade would
 * otherwise report every review ever kept. */
export const NOTICE_MAX_AGE_MS = 14 * 24 * 60 * 60_000
/** A check that has run this long is taken to have died (its process killed with the host's). */
export const CHECK_STALE_MS = 10 * 60_000

/**
 * The team rules, open proposals and new review notices for a host session start. With `session`, the rules are
 * recorded as shown to it and the notices reported are not reported again. Waits at most `waitMs` for a sync.
 */
export async function start(input: { root: string; directory: string; learn: LearnConfig; session?: string; waitMs?: number }): Promise<Start> {
  const none: Start = { rules: [], proposals: 0, notices: [] }
  const { RulesService } = await import("./service")
  if (!RulesSync.rulesEnabled(input.learn) || !(await RulesService.linked(input.root, input.directory))) return none
  await RulesSync.sessionStart(input.root, input.directory, input.learn, { waitMs: input.waitMs ?? START_WAIT_MS })
  const state = await RulesStore.read(input.root)
  // A sync that signs out or unlinks clears the rules; one that did not finish in time has not: no credential, no rules.
  if (!(await on(input.root, input.learn, state))) return none
  const all = state.rules.map(RulesStore.toLesson)
  // Recorded as shown when the learn lock allows (a busy TUI may hold it): the rules are given either way.
  const lessons = input.session
    ? await import("../learn/delivery")
        .then(({ Delivery }) =>
          new Delivery(input.root, input.learn as ConstructorParameters<typeof Delivery>[1], input.directory).recordStart(input.session!, RulesStore.WORKSPACE_RULES_STORE))
        .catch((error) => {
          log.warn("host session rules not recorded as shown", { error: error instanceof Error ? error.message : String(error) })
          return all
        })
    : all
  const seen = new Set(state.host_notices_seen)
  const now = Date.now()
  const notices = state.notices.filter((notice) => !seen.has(noticeKey(notice)) && !(now - Date.parse(notice.at) > NOTICE_MAX_AGE_MS))
  if (input.session && notices.length)
    await RulesStore.update(input.root, (s) => {
      s.host_notices_seen = [...s.host_notices_seen, ...notices.map(noticeKey).filter((key) => !s.host_notices_seen.includes(key))]
    })
  return {
    workspace: state.workspace,
    rules: lessons.map((lesson) => ({ text: lesson.text, applies_to: lesson.trigger?.paths ?? [] })),
    proposals: (await RuleProposal.stored(input.root)).length,
    notices,
  }
}

const noticeKey = (notice: RulesStore.Notice) => `${notice.public_id}|${notice.status}`

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
    lines.push(`${start.proposals} proposed team ${start.proposals === 1 ? "rule is" : "rules are"} waiting for the person's answer: they can review ${start.proposals === 1 ? "it" : "them"} with ${command}.`)
  if (start.notices.length) {
    lines.push(`Reviews of the person's proposed rules in ${ws} since their last session:`)
    for (const notice of start.notices) {
      const status = notice.status === "active" ? "approved" : printable(notice.status)
      lines.push(`- ${status}${notice.reviewer ? ` by ${printable(notice.reviewer)}` : ""}: "${printable(notice.text)}"${notice.reason ? ` — ${printable(notice.reason)}` : ""}`)
    }
  }
  return lines.join("\n")
}

/** Record `text` as a correction of host session `session` when it reads as one. No model call. */
export async function recordCorrection(input: { root: string; learn: LearnConfig; session: string; text: string }): Promise<"recorded" | "duplicate" | "not_correction" | "off"> {
  if (!(await on(input.root, input.learn))) return "off"
  const reason = correctionReason(input.text)
  if (!reason) return "not_correction"
  const signal = await appendSignal(input.root, {
    kind: "user_correction",
    sessionID: input.session,
    text: input.text,
    reason,
    correctedAt: new Date().toISOString(),
  })
  return signal ? "recorded" : "duplicate"
}

/** The after-turn check for host session `session`, its proposal stored; then a sync when one is due or proposals are
 * queued. Returns what the check decided. */
export async function check(input: { root: string; directory: string; learn: LearnConfig; session: string; transcript?: string }): Promise<string> {
  if (!(await on(input.root, input.learn))) return "learning or workspaces are off, signed out, or this project is not linked"
  // One check per host session at a time, across processes: each turn's Stop hook is its own process, and a check
  // waiting on the model must not be joined by the next turn's (two drafting calls for the same corrections).
  let held = false
  await RulesStore.update(input.root, (s) => {
    const claim = s.host_checks[input.session]
    if (claim && claim.pid !== process.pid && alive(claim.pid) && Date.now() - Date.parse(claim.at) < CHECK_STALE_MS) return void (held = true)
    s.host_checks[input.session] = { pid: process.pid, at: new Date().toISOString() }
  })
  if (held) return "another check of this session is running"
  try {
    return await checkClaimed(input)
  } finally {
    await RulesStore.update(input.root, (s) => {
      if (s.host_checks[input.session]?.pid === process.pid) delete s.host_checks[input.session]
    }).catch((error) => log.warn("host check claim not released", { error: error instanceof Error ? error.message : String(error) }))
  }
}

async function checkClaimed(input: Parameters<typeof check>[0]): Promise<string> {
  const deps: RuleTrigger.TriggerDeps = {
    source: async () => {
      const corrections = (await readSignals(input.root, Playbook.DEFAULT_NAME))
        .filter((signal) => signal.kind === "user_correction" && signal.sessionID === input.session)
        .map((signal) => signal.text)
      const fromTranscript = input.transcript ? await sourceFromTranscript(input.transcript).catch((error) => {
        log.warn("host transcript not read", { error: error instanceof Error ? error.message : String(error) })
        return undefined
      }) : undefined
      return fromTranscript ?? { prompts: corrections, calls: [] }
    },
    generate: (source, onUsage) => generate(input.learn?.model, source, onUsage),
  }
  await RuleTrigger.afterTurn({ sessionID: input.session, root: input.root, directory: input.directory, learn: input.learn, deps, persist: true })
  const state = await RulesStore.read(input.root)
  if (state.outbox.length || (await RulesSync.due(input.root)))
    await RulesSync.runShared(input.root, input.directory, input.learn, "cli").catch((error) =>
      log.warn("rules sync after host check failed", { error: error instanceof Error ? error.message : String(error) }))
  return state.last_check?.session === input.session ? state.last_check.outcome : "no new corrections"
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

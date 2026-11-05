// altimate_change - new file
//
// Workspace rules in a host agent's session (Claude Code or Codex through the altimate-code plugin). altimate-code does
// not run that conversation: the plugin's hooks call `altimate-code learn hook <event>` with the host's hook input (the
// prompt, and at Stop the path of the host's transcript, which the check reads).
// - session start: a bounded pull, then the team rules for this repository, the proposals waiting for the person and
//   reviews since the last session, as context for the host agent. The rules given are recorded as shown to that
//   session, so "corrected again", usage and the shown-rule edit path count it.
// - prompt submit: "remember … as a team rule" becomes a stored proposal; a message that reads as a correction is
//   recorded as a signal of the host session. No model call.
// - stop: the after-turn check for the host session (one drafting call per check round: up to `MAX_CHECK_ROUNDS` for
//   this session, then as many for one session with leftover corrections). No client shows cards there, so a proposal
//   is stored for `learn proposals` (the plugin's `/altimate-code:rules`). Then queued proposals and usage are sent.
// Every step follows the same gates as in an altimate-code session: team rules are given when workspaces are on, the
// project is linked and the person is signed in as the account they were pulled for; corrections are captured and
// drafted only with learning from sessions on as well.
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { correctionReason } from "../learn/correction"
import type { DigestCall, DigestSource } from "../learn/digest"
import * as Playbook from "../learn/playbook"
import { appendSignal, isHostSession, readSignals } from "../learn/signals"
import { printable } from "./printable"
import { RuleProposal } from "./proposal"
import { processAlive } from "./remember"
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
  /** "Remember … as a team rule" requests from a prompt that were not stored: said once. */
  unstored?: RulesStore.State["host_unstored"]
}

/** How long a session start waits for a pull before answering from the last one. */
export const START_WAIT_MS = 3_000
/** A project with no pulled rules yet waits longer: without them, nothing else here runs. */
export const FIRST_PULL_WAIT_MS = 8_000
/** The whole session start, reading the hook's input and the pull included, ends within this: the plugin's hook timeout
 * is 15s, the CLI takes about a second to start, and the hook's exit waits up to `HOOK_EXIT_LOCKS_MS` for a learn lock it
 * holds and `HOOK_EXIT_TELEMETRY_MS` for telemetry. Recording the rules as shown and marking notices seen are best effort
 * within what is left. */
export const START_DEADLINE_MS = 10_000
/** How long a hook's exit waits for learn locks it still holds (work past the deadline): an exit inside one would leave
 * the project's learn lock to go stale. */
export const HOOK_EXIT_LOCKS_MS = 1_500
/** How long a hook's exit waits for telemetry to flush. */
export const HOOK_EXIT_TELEMETRY_MS = 1_000
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

/** Team rules may be given: learn and workspaces on, the project linked to a workspace, and the person signed in now is
 * the one the rules were pulled for (a sync that would clear them after a sign-out or an account change may not have run
 * yet). As in an altimate-code session, this does not depend on learning from sessions. */
async function delivering(root: string, learn: LearnConfig, state?: RulesStore.State) {
  if (!RulesSync.rulesEnabled(learn)) return false
  const current = state ?? (await RulesStore.read(root))
  return !!current.workspace && (await RulesStore.verified(current))
}

/** Corrections may be captured and drafted into proposals: `delivering`, and learning from sessions on. */
async function on(root: string, learn: LearnConfig, state?: RulesStore.State) {
  const current = state ?? (await RulesStore.read(root))
  return RuleTrigger.learningEnabled(learn, current) && (await delivering(root, learn, current))
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
  /** What is left of `START_DEADLINE_MS` (the hook spent some reading its input); tests set their own. */
  deadlineMs?: number
}): Promise<Start> {
  const none: Start = { rules: [], proposals: 0, notices: [] }
  const deadline = Date.now() + (input.deadlineMs ?? START_DEADLINE_MS)
  const left = () => Math.max(0, deadline - Date.now())
  /** `work`, or `fallback` once the deadline passes (the work goes on; the hook's process may exit under it). */
  const within = <T>(work: Promise<T>, fallback: T) =>
    Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), left()).unref?.())])
  const { RulesService } = await import("./service")
  if (!RulesSync.rulesEnabled(input.learn) || !(await within(RulesService.linked(input.root, input.directory), false))) return none
  const before = await RulesStore.read(input.root)
  // The folder's link as cached now (no network): relinked to another workspace, the last pull's rules are not its own.
  // A link cache that cannot be read may hide a relink, so it is taken as one.
  const bound = await within(RulesService.localBinding(input.root, input.directory, { strict: true }).catch(() => "unreadable" as const), null)
  const relinked = (state: RulesStore.State) =>
    !!bound && !!state.scope && (bound === "unreadable" || bound.datamateId !== state.scope.datamateId)
  if (!(await RulesSync.pullFailedRecently(before)) && (relinked(before) || !(await RulesStore.verified(before)) || (await RulesSync.due(input.root))))
    await RulesSync.pullWithin(input.root, input.directory, input.learn, Math.min(left(), input.waitMs ?? (before.scope ? START_WAIT_MS : FIRST_PULL_WAIT_MS)))
  const state = await RulesStore.read(input.root)
  if (relinked(state) || !(await delivering(input.root, input.learn, state))) return none
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
  const notices = state.notices.filter((notice) => !seen.has(RulesStore.hostNoticeKey(notice)) && !(now - Date.parse(notice.at) > NOTICE_MAX_AGE_MS))
  const failed = state.last_check?.outcome.startsWith("failed") && !seen.has(RulesStore.hostCheckKey(state.last_check)) ? state.last_check : undefined
  const unstored = state.host_unstored
  // Marked seen only if the write lands in time: otherwise they are said again next time, never lost.
  if (input.session && (notices.length || failed || unstored.length))
    await within(
      RulesStore.update(input.root, (s) => {
        const keys = [...notices.map(RulesStore.hostNoticeKey), ...(failed ? [RulesStore.hostCheckKey(failed)] : [])]
        s.host_notices_seen = [...s.host_notices_seen, ...keys.filter((key) => !s.host_notices_seen.includes(key))]
        s.host_unstored = s.host_unstored.filter((entry) => !unstored.some((said) => said.at === entry.at && said.text === entry.text))
      }).catch((error) => log.warn("host notices not marked seen", { error: errorText(error) })),
      undefined,
    )
  return {
    workspace: state.workspace,
    rules: lessons.map((lesson) => ({ text: lesson.text, applies_to: lesson.trigger?.paths ?? [] })),
    proposals: (await within(RuleProposal.storedFor(input.root), [])).length,
    notices,
    ...(failed ? { check_failed: failed.outcome.replace(/^failed:\s*/, "") } : {}),
    ...(unstored.length ? { unstored } : {}),
  }
}

/** `start` as context for the host agent; empty when there is nothing to say. Server text is made printable. */
export function context(start: Start, command = "/altimate-code:rules"): string {
  const ws = printable(start.workspace?.name ?? "the workspace")
  return [
    ...ruleLines(start, ws),
    ...proposalLines(start, command),
    ...noticeLines(start, ws),
    ...(start.check_failed
      ? [`The last check of the person's corrections for proposed team rules failed (${printable(start.check_failed)}). It needs a model altimate-code can use: \`altimate learn status\` shows the setting.`]
      : []),
  ].join("\n")
}

function ruleLines(start: Start, ws: string): string[] {
  if (!start.rules.length) return []
  const scope = (rule: Start["rules"][number]) => (rule.applies_to.length ? ` (applies to ${rule.applies_to.map(printable).join(", ")})` : "")
  return [
    `Team rules from ${ws} for this repository (approved by the workspace owner; they apply to all work here, including code you write yourself):`,
    ...start.rules.map((rule) => `- ${printable(rule.text)}${scope(rule)}`),
  ]
}

function proposalLines(start: Start, command: string): string[] {
  const lines: string[] = []
  if (start.proposals) {
    const one = start.proposals === 1
    const full = start.proposals >= RulesStore.MAX_STORED_PROPOSALS ? " New proposals from corrections wait until some are answered." : ""
    lines.push(`${start.proposals} proposed team ${one ? "rule is" : "rules are"} waiting for the person's answer: they can review ${one ? "it" : "them"} with ${command}.${full}`)
  }
  for (const entry of start.unstored ?? [])
    lines.push(`The person asked to remember "${printable(entry.text)}" as a team rule, but it was not proposed: ${unstoredReason(entry, command)}. Tell them, so they can ask again.`)
  return lines
}

function unstoredReason(entry: NonNullable<Start["unstored"]>[number], command: string): string {
  if (entry.reason === "full") return `too many proposals are waiting (answer some with ${command} first)`
  if (entry.reason === "invalid") return `it is not a one-line team rule (${printable(entry.detail ?? "it did not pass the rule check")})`
  return `it could not be saved (${printable(entry.detail ?? "a write failed")})`
}

function noticeLines(start: Start, ws: string): string[] {
  if (!start.notices.length) return []
  const line = (notice: RulesStore.Notice) => {
    const status = notice.status === "active" ? "approved" : printable(notice.status)
    const by = notice.reviewer ? ` by ${printable(notice.reviewer)}` : ""
    return `- ${status}${by}: "${printable(notice.text)}"${notice.reason ? ` — ${printable(notice.reason)}` : ""}`
  }
  return [`Reviews of the person's proposed rules in ${ws} since their last session:`, ...start.notices.map(line)]
}

/** "Remember this as a team rule: X", "save as a rule - X", "don't forget, team rule: X": a request that names a team rule,
 * and what it is. Only explicit wording: "remember to run the tests" or "do you remember …?" is the conversation, not a
 * rule. The cue words are the ones `RulesRemember` treats as asking to remember. The rule may start on the next line. */
const REMEMBER = /\b(?:remember|don'?t forget|do not forget|keep in mind|note|save|from now on)\b,?(?:\s+(?:this|that|it))?\s+(?:as\s+)?(?:an?\s+)?(?:team\s+)?rule\b[ \t]*[:,-]\s*(.+)/i
/** Shorter than this after the cue is not a rule ("remember?", "remember this"). */
const MIN_REMEMBERED = 8

/** The rule a "remember … as a team rule" prompt asks for: its first line, up to the first sentence end. What follows
 * ("… Now fix stg_orders.") is the rest of the conversation. */
export function rememberedRule(prompt: string): string | undefined {
  const rest = REMEMBER.exec(prompt)?.[1]
  if (!rest) return undefined
  const line = rest.split(/\r?\n/)[0]
  // A sentence end. An abbreviation's dot ("e.g.", "i.e.", "etc.", "vs.", "cf.") ends it only when no lowercase word
  // follows: "etc. Then rerun the build." is two sentences, "e.g. in staging models" one.
  const end = /(?<!\b(?:[Ee]\.g|[Ii]\.e|[Ee]tc|[Vv]s|[Cc]f))[.!?](?=\s|$)|(?<=\b(?:[Ee]\.g|[Ii]\.e|[Ee]tc|[Vv]s|[Cc]f))\.(?=\s*$|\s+[^\s\p{Ll}])/u.exec(line)
  const rule = (end ? line.slice(0, end.index + 1) : line).trim()
  return rule.length >= MIN_REMEMBERED ? rule : undefined
}

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
  const remembered = rememberedRule(input.text)
  // A request is handled once, by the prompt hook: read back from the transcript at Stop it is not a correction too.
  if (remembered && input.explicit === false) return "not_correction"
  if (remembered) {
    const outcome = await rememberAsked(input, remembered)
    if (outcome) return outcome
  }
  const reason = correctionReason(input.text)
  if (!reason) return "not_correction"
  // The prompt starts the turn it corrects: a rule shown at session start, before it, was shown to that turn
  // ("corrected again"). Attribution needs the turn to start strictly before its correction.
  const now = Date.now()
  const at = new Date(now).toISOString()
  const signal = await appendSignal(input.root, {
    kind: "user_correction",
    sessionID: input.session,
    text: input.text,
    reason,
    correctedAt: at,
    turnStartedAt: new Date(now - 1).toISOString(),
  })
  if (!signal) return "duplicate"
  // A check of this session already running took its corrections before this one: it checks again before it ends.
  await RulesStore.update(input.root, (s) => {
    const claim = s.host_checks[input.session]
    if (claim && claim.pid !== process.pid) claim.pending = (claim.pending ?? 0) + 1
  }).catch((error) => log.warn("host check not told of a new correction", { error: errorText(error) }))
  return "recorded"
}

/**
 * A "remember … as a team rule" request: stored as a proposal ("proposed"), or, when it cannot be, kept to be said at
 * the next session start ("not_stored"): this hook runs in the background and cannot answer the person. A fact or
 * preference is left to the host agent's own memory (undefined: the prompt is read as a correction like any other).
 */
async function rememberAsked(
  input: Parameters<typeof recordCorrection>[0],
  remembered: string,
): Promise<"proposed" | "not_stored" | undefined> {
  let refused: "full" | "scope_changed" | "failed" | undefined
  const result = await RuleTrigger.explicit({
    sessionID: input.session, root: input.root, directory: input.directory, learn: input.learn, text: remembered, said: input.text,
    persist: true, request: { session: input.session, via: "training" }, onNotStored: (reason) => void (refused = reason),
  })
  if (result.status === "memory") return undefined
  if (result.status === "shown" && result.card) return "proposed"
  // Drafted for an account or workspace that changed meanwhile: nothing to tell this one.
  if (refused === "scope_changed") return "not_stored"
  const entry: RulesStore.State["host_unstored"][number] = result.status === "invalid"
    ? { at: new Date().toISOString(), text: remembered, reason: "invalid", detail: result.reason }
    : { at: new Date().toISOString(), text: remembered, reason: refused === "failed" ? "failed" : "full" }
  await RulesStore.update(input.root, (s) => void s.host_unstored.push(entry))
    .catch((error) => log.warn("unstored host request not kept", { error: errorText(error) }))
  return "not_stored"
}

/** Claim the check of `session` for this process. False while another live process holds it; then that check is told to
 * run again (`pending`), so this Stop's corrections are not left unchecked. */
async function claimCheck(root: string, session: string, markPending: boolean): Promise<boolean> {
  let held = false
  await RulesStore.update(root, (s) => {
    const claim = s.host_checks[session]
    if (claim && claim.pid !== process.pid && processAlive(claim.pid) && Date.now() - Date.parse(claim.at) < CHECK_STALE_MS) {
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
 * usage are sent when due. One drafting call per check round at most. Returns what this session's check decided.
 */
export async function check(input: { root: string; directory: string; learn: LearnConfig; session: string; transcript?: string }): Promise<string> {
  const state = await RulesStore.read(input.root)
  if (!(await delivering(input.root, input.learn, state))) return "learning or workspaces are off, signed out, or this project is not linked"
  if (!RuleTrigger.learningEnabled(input.learn, state)) {
    // Nothing is captured or drafted, but replies the person queued (`learn proposals reply` in a sandbox without
    // network) are theirs to send: only the workspace, sign-in and link gates apply to them.
    await syncAfterCheck(input)
    return "learning from sessions is off"
  }
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
  await syncAfterCheck(input)
  return outcome
}

/** Queued proposals and usage sent, rules pulled, when due: not while the last pull failed recently (each hook is a new
 * process, so only the state on disk remembers it). A failed run is recorded there too. */
async function syncAfterCheck(input: Parameters<typeof check>[0]) {
  const state = await RulesStore.read(input.root)
  if (await RulesSync.pullFailedRecently(state)) return
  if (!state.outbox.length && !(await RulesSync.due(input.root))) return
  const report = await RulesSync.runShared(input.root, input.directory, input.learn, "cli").catch((error) => {
    log.warn("rules sync after host check failed", { error: errorText(error) })
    return undefined
  })
  await RulesSync.recordPullOutcome(input.root, report)
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
  const NONE = "no new corrections"
  let outcome = NONE
  try {
    outcome = await checkSession(input, session, transcript)
    for (let round = 1; await releaseCheck(input.root, session); round++) {
      if (round >= MAX_CHECK_ROUNDS) {
        await RulesStore.update(input.root, (s) => {
          if (!s.host_pending.includes(session)) s.host_pending.push(session)
        })
        break
      }
      // A later round with nothing new does not hide what an earlier one did.
      const next = await checkSession(input, session, await reread())
      if (next !== NONE) outcome = next
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
 * (`host_pending`), then the oldest unchecked correction's session. Skipped: sessions another check holds, and sessions
 * whose check failed or could not store its proposal within `RETRY_FAILED_MS`.
 */
async function checkLeftover(input: Parameters<typeof check>[0]) {
  const state = await RulesStore.read(input.root)
  const processed = new Set(state.processed_signals)
  const now = Date.now()
  const eligible = (session: string) => {
    if (session === input.session) return false
    const claim = state.host_checks[session]
    if (claim && processAlive(claim.pid) && now - Date.parse(claim.at) < CHECK_STALE_MS) return false
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
  // A check that failed, or could not store its proposal, is retried as a leftover only after `RETRY_FAILED_MS`; its own
  // session's next turn retries it anyway.
  await RulesStore.update(input.root, (s) => {
    for (const [key, at] of Object.entries(s.host_retry)) if (Date.parse(at) <= Date.now()) delete s.host_retry[key]
    if (outcome.startsWith("failed") || outcome.startsWith("not stored"))
      s.host_retry[session] = new Date(Date.now() + RETRY_FAILED_MS).toISOString()
    else delete s.host_retry[session]
  }).catch((error) => log.warn("host check retry not recorded", { error: errorText(error) }))
  return outcome
}

/** A transcript path from the host is read only when it is a regular file (a FIFO would block the check). */
async function regularFile(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile(), () => false)
}

/** The drafting model: `learn.model`, else altimate-code's default model (like `learn reflect` without `--model`). Never
 * a sign-up: this runs in the background of a host session with no one to tell, so with no model configured the check
 * fails, and the next session start says so. */
export async function generate(model: string | undefined, source: DigestSource, onUsage?: Parameters<RuleTrigger.TriggerDeps["generate"]>[1]) {
  const [{ Provider }, { AppRuntime }, { DEFAULT_TIMEOUT_MS, providerGenerate }, { learnModel }] = await Promise.all([
    import("@/provider/provider"),
    import("@/effect/app-runtime"),
    import("../learn/reflect"),
    import("../learn/auto"),
  ])
  const chosen = learnModel(model)
  const parsed = chosen ? Provider.parseModel(chosen) : source.model
  return AppRuntime.runPromise(providerGenerate(parsed, DEFAULT_TIMEOUT_MS, undefined, onUsage)).catch((error) => {
    if (parsed) throw error
    throw new Error(`no model altimate-code can use (set \`learn.model\`, or configure a provider for altimate-code): ${errorText(error)}`)
  })
}

const CODEX_INJECTED = /^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/
/** Claude Code rows typed as the person's that they did not write: an interrupt marker, a slash command's expansion or
 * its local output, the caveat before them. */
const CLAUDE_INJECTED = /^\s*(?:\[Request interrupted by user|<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stderr>|Caveat: The messages below were generated by the user while running local commands)/

/** The newest part of a transcript read at most: the drafter sees a bounded digest anyway. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

/** What a transcript row adds to a digest source. */
interface TranscriptParts {
  prompts: string[]
  calls: DigestCall[]
  byId: Map<string, DigestCall>
  finalText?: string
}

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

function addCall(parts: TranscriptParts, id: unknown, name: unknown, input: unknown) {
  const entry: DigestCall = { name: String(name), input }
  parts.calls.push(entry)
  if (typeof id === "string") parts.byId.set(id, entry)
}

function addResult(parts: TranscriptParts, id: unknown, output: unknown, error = false) {
  const entry = typeof id === "string" ? parts.byId.get(id) : undefined
  if (!entry) return
  const value = typeof output === "string" ? output : JSON.stringify(output)
  if (error) entry.error = value
  else entry.output = value
}

/** A Claude Code row (`{type: "user" | "assistant", message}`). Rows it adds itself (command output, reminders, a
 * compaction summary, interrupt markers) and a subagent's are not the person's conversation. */
function readClaudeRow(row: Row, parts: TranscriptParts) {
  if (row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return
  const user = row.type === "user"
  const said = (value: string) => {
    if (!user) parts.finalText = value
    else if (!CLAUDE_INJECTED.test(value)) parts.prompts.push(value)
  }
  const content = isRow(row.message) ? row.message.content : undefined
  if (typeof content === "string") return said(content)
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!isRow(part)) continue
    if (part.type === "text" && typeof part.text === "string") said(part.text)
    else if (part.type === "tool_use") addCall(parts, part.id, part.name, part.input)
    else if (part.type === "tool_result") addResult(parts, part.tool_use_id, part.content, part.is_error === true)
  }
}

/** A Codex row (`{type: "response_item", payload}`). Codex sends the environment and AGENTS.md instructions as user
 * messages. */
function readCodexRow(row: Row, parts: TranscriptParts) {
  const item = row.payload
  if (!isRow(item)) return
  if (item.type === "message" && Array.isArray(item.content)) {
    const said = item.content.map((part) => (isRow(part) ? text(part.text) : undefined)).filter((part) => part !== undefined).join("\n")
    if (!said) return
    if (item.role === "user" && !CODEX_INJECTED.test(said)) parts.prompts.push(said)
    else if (item.role === "assistant") parts.finalText = said
  } else if (item.type === "function_call" || item.type === "custom_tool_call") {
    let args = item.arguments ?? item.input
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {}
    }
    addCall(parts, item.call_id, item.name, args)
  } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    addResult(parts, item.call_id, isRow(item.output) && "content" in item.output ? item.output.content : item.output)
  }
}

/** The newest `MAX_TRANSCRIPT_BYTES` of `file`, from its first whole line. */
async function readTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r")
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, MAX_TRANSCRIPT_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    const tail = buffer.toString("utf8", 0, bytesRead)
    // Started mid-line: the first line is partial (and with no line break, so is everything read).
    if (size <= length) return tail
    const start = tail.indexOf("\n")
    return start < 0 ? "" : tail.slice(start + 1)
  } finally {
    await handle.close()
  }
}

/**
 * A digest source from a host transcript (JSON lines): Claude Code (`{type: "user" | "assistant", message}`) or Codex
 * (`{type: "response_item", payload}`). Undefined when it holds no prompt.
 */
export async function sourceFromTranscript(file: string): Promise<DigestSource | undefined> {
  const parts: TranscriptParts = { prompts: [], calls: [], byId: new Map() }
  for (const line of (await readTail(file)).split("\n")) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRow(row)) continue
    if (row.type === "user" || row.type === "assistant") readClaudeRow(row, parts)
    else if (row.type === "response_item") readCodexRow(row, parts)
  }
  if (!parts.prompts.length) return undefined
  return { prompts: parts.prompts, calls: parts.calls, ...(parts.finalText ? { finalText: parts.finalText } : {}) }
}

export * as RulesHost from "./host"

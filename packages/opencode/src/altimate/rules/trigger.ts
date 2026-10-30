// altimate_change - new file
//
// When a correction becomes a proposed rule, and the one model call that words it.
//
// After each turn (session idle) the new correction signals of that session are checked:
// - (a) recurrence: the same topic corrected in 2 or more sessions with no rule covering it → an "add" card;
// - (c) a correction of a team rule the session was shown → an "edit" card (or "retire" when the drafter
//   says the rule is wrong), shown with the current text struck through.
// (b) — the person asking to remember something — comes from `training_save` (`explicit`).
//
// The drafter is the reflector, scoped to the triggering corrections with the team rules as its playbook:
// an ADD becomes an add card, an EDIT or REMOVE of a team rule becomes an edit or retire card, and a
// HELPFUL on a team rule (the rule already says it) makes no card.
import { Log } from "@/util/log"
import { booleanFlag, learnEnabled } from "../learn/config"
import { lint } from "../learn/curator"
import { readShownSnapshots } from "../learn/delivery"
import { buildDigest, type DigestSource } from "../learn/digest"
import * as Playbook from "../learn/playbook"
import { approvedLessons, unmatchedCorrectionTopics } from "../learn/recurrence"
import { reflect, type Generate, type GenerateUsage } from "../learn/reflect"
import { createUsageTracker } from "../learn/usage"
import { readSignals, type Signal } from "../learn/signals"
import { RuleClassify } from "./classify"
import { RuleProposal, excerpt, type Draft } from "./proposal"
import { RulesStore } from "./store"
import { RulesTelemetry } from "./telemetry"

const log = Log.create({ service: "rules.trigger" })
export const RECURRENCE_SESSIONS = 2
const MAX_WHY = 280

export interface TriggerDeps {
  /** The model for one drafting call, resolved for this session; `onUsage` receives its token and cost usage. */
  generate: (source: DigestSource, onUsage?: (usage: GenerateUsage) => void) => Promise<Generate>
  source: (sessionID: string) => Promise<DigestSource>
}

type LearnConfig = { enabled?: boolean; capture?: boolean; capture_policy?: boolean } | undefined

export type LearningSource = "organization" | "you" | "workspace" | "default"

/**
 * Whether sessions here learn from corrections (capture them and propose rules), and who decided. In order: the
 * learning kill switch (`ALTIMATE_LEARN`, `learn.enabled`); `ALTIMATE_LEARN_CAPTURE`; `learn.capture` set by a config
 * layer above project files (`capture_policy`: managed config, MDM, the account's config …); the person's `/rules`
 * choice (`personal_learning`, git-ignored); `learn.capture` (`learn enable` / `learn disable`); a linked workspace's
 * "Learn from sessions"; otherwise off. Env flags parse like `learn/config.ts`, so the two agree.
 */
export function learningDecision(learn: LearnConfig, state: RulesStore.State, env: NodeJS.ProcessEnv = process.env): { on: boolean; source: LearningSource } {
  if (!learnEnabled(learn, env)) return { on: false, source: "you" }
  const forced = booleanFlag(env.ALTIMATE_LEARN_CAPTURE)
  if (forced !== undefined) return { on: forced, source: "you" }
  if (learn?.capture_policy && learn.capture !== undefined) return { on: learn.capture, source: "organization" }
  if (state.personal_learning !== undefined) return { on: state.personal_learning, source: "you" }
  if (learn?.capture !== undefined) return { on: learn.capture, source: "you" }
  if (state.workspace) return { on: state.settings?.learning_enabled === true, source: "workspace" }
  return { on: false, source: "default" }
}

export function learningEnabled(learn: LearnConfig, state: RulesStore.State, env: NodeJS.ProcessEnv = process.env): boolean {
  return learningDecision(learn, state, env).on
}

const STOP = new Set("the and for with that this from into when then than are was were have has had not use using should must always never only all any each your you our its their them they these those also but can will would could does like just".split(" "))
/** Content words of a text, for the edit-candidate filter. */
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w)))
/** Shared content words that make a shown team rule the subject of a correction. */
export const EDIT_OVERLAP = 3
/** Shared content words that make a correction evidence for a rule the person asked to remember. */
const RELATED_OVERLAP = 2

/** Path globs per proposal, and their length: the server's lint bounds (a glob longer than a rule is not a path the
 * person meant). Shared with the history path (`from-history.ts`). */
export const MAX_APPLIES_TO = 4
export const MAX_GLOB = 140

const KNOWN_DIRS = new Set(["models", "macros", "seeds", "snapshots", "tests", "analyses", "src", "app", "lib", "dags", "sql", "scripts"])

/** Path globs a correction points at: directories of the paths it mentions. */
export function appliesTo(texts: readonly string[]): string[] {
  const globs = new Set<string>()
  for (const text of texts)
    for (const match of text.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)+)[\w.*-]*/g)) {
      const dir = match[1].replace(/^\.\//, "").replace(/\/$/, "")
      // Paths are lowercase directory names ("models/staging"); "FLOAT/DOUBLE" or "and/or" are not.
      const segments = dir.split("/")
      if (!dir || dir.startsWith("..") || segments.some((segment) => !/^[a-z0-9_.-]+$/.test(segment))) continue
      if (segments.length === 1 && !/[._]/.test(segments[0]) && !KNOWN_DIRS.has(segments[0])) continue
      globs.add(`${dir}/**`)
    }
  return [...globs].filter((glob) => glob.length <= MAX_GLOB).slice(0, MAX_APPLIES_TO)
}

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + "…")
const teamBullets = (state: RulesStore.State): Playbook.Bullet[] =>
  state.rules.map((rule) => ({ id: RulesStore.lessonId(rule.rule_key), text: rule.text, helpful: 0, harmful: 0 }))

async function draft(input: {
  deps: TriggerDeps
  sessionID: string
  trigger: "shown_rule" | "recurrence"
  signals: readonly Signal[]
  state: RulesStore.State
  target?: string
  /** Only an ADD is usable (the recurrence path): other deltas are skipped. */
  addOnly?: boolean
  /** Why no proposal came out, for the check record. */
  note?: (outcome: string) => void
}): Promise<{ text: string; change: Draft["change"]; replaces?: Draft["replaces"]; reason: string } | "covered" | undefined> {
  const source = await input.deps.source(input.sessionID)
  // The model call runs in the background after a turn: its tokens and cost are reported, failed or not.
  const tracker = createUsageTracker()
  const startedAt = Date.now()
  let ok = false
  const bullets = teamBullets(input.state)
  const deltas = await (async () => {
    try {
      const result = await reflect({
        digest: buildDigest(source),
        feedback: input.signals.map((signal) => signal.text).join("\n\n"),
        kind: "user",
        bullets: input.target ? bullets.filter((b) => b.id === input.target) : bullets,
      }, await input.deps.generate(source, tracker.add))
      ok = true
      return result
    } finally {
      RulesTelemetry.drafted({ sessionID: input.sessionID, trigger: input.trigger, ok, usage: tracker.usage, startedAt })
    }
  })()
  log.info("rule draft", { session: input.sessionID, target: input.target, deltas: deltas.map((d) => d.op) })
  const rules = new Map(input.state.rules.map((rule) => [RulesStore.lessonId(rule.rule_key), rule]))
  for (const delta of deltas) {
    const target = delta.id ? rules.get(delta.id) : undefined
    if (input.addOnly && delta.op !== "ADD") continue
    if (delta.op === "HELPFUL" && target) {
      input.note?.(`the team rule already covers it (${delta.reason})`)
      return "covered"
    }
    if (delta.op === "EDIT" && target && delta.text && !lint(delta.text))
      return { text: delta.text.trim(), change: "edit", replaces: { public_id: target.public_id, text: target.text, version: target.version }, reason: delta.reason }
    if (delta.op === "REMOVE" && target)
      return { text: target.text, change: "retire", replaces: { public_id: target.public_id, text: target.text, version: target.version }, reason: delta.reason }
    // With a target, an ADD is a separate constraint on the same subject: a new rule beside it.
    if (delta.op === "ADD" && delta.text && !lint(delta.text))
      return { text: delta.text.trim(), change: "add", reason: delta.reason }
  }
  input.note?.(`drafter proposed nothing usable (${deltas.map((d) => d.op).join(", ") || "no changes"})`)
  return undefined
}

const running = new Set<string>()

/** Check the session's new corrections and show at most one card. Never throws. */
export async function afterTurn(input: {
  sessionID: string
  root: string
  directory: string
  learn: LearnConfig
  deps: TriggerDeps
}): Promise<void> {
  // Idle can fire twice for one turn; one check per session at a time.
  if (running.has(input.sessionID)) return
  running.add(input.sessionID)
  let outcome = "no new corrections"
  let checked: string[] = []
  const note = (text: string) => { outcome = text }
  try {
    const state = await RulesStore.read(input.root)
    if (!learningEnabled(input.learn, state)) return
    const processed = new Set(state.processed_signals)
    const fresh = (await readSignals(input.root, Playbook.DEFAULT_NAME)).filter((signal) =>
      signal.kind === "user_correction" && signal.sessionID === input.sessionID && !processed.has(signal.id))
    if (!fresh.length) return
    // Nothing attached would show a card (`altimate-code run`, ACP, a plugin): the corrections are left unprocessed,
    // so a later turn of this session with a card client attached proposes them.
    if (!RuleProposal.rendererAttached(input.directory)) {
      outcome = "no client that shows cards is attached; corrections kept for a later check"
      return RulesTelemetry.skipped(input.sessionID, undefined, "no_renderer")
    }
    // One card at a time per session: an explicit "remember" may already have shown one for this turn.
    if (RuleProposal.list(input.directory, input.sessionID).length)
      return RulesTelemetry.skipped(input.sessionID, undefined, "card_open")
    // Marked processed once the check completes; a failed check is retried after the next turn.
    checked = fresh.map((signal) => signal.id)
    // The model call takes a while: if the client that shows cards went away meanwhile, the card would not be seen,
    // so the corrections are left for a later check instead.
    const stillShown = () => {
      if (RuleProposal.rendererAttached(input.directory)) return true
      checked = []
      outcome = "the client that shows cards went away during the check; corrections kept for a later check"
      RulesTelemetry.skipped(input.sessionID, undefined, "no_renderer")
      return false
    }
    const newest = fresh[fresh.length - 1]
    const correction = { excerpt: excerpt(newest.text), at: newest.correctedAt ?? newest.at }

    // (c) A team rule shown in this session before the correction, on the same subject: propose changing it.
    // A loose word-overlap filter picks the candidate; the drafter decides (HELPFUL = the rule already says it).
    const snapshot = (await readShownSnapshots(input.root)).snapshots.find((s) => s.session === input.sessionID)
    const correctedAt = Date.parse(newest.correctedAt ?? newest.at)
    const shownIds = new Set((snapshot?.shown ?? [])
      .filter((entry) => entry.name === RulesStore.WORKSPACE_RULES_STORE && !(Date.parse(entry.at) >= correctedAt))
      .map((entry) => entry.id))
    const said = words(fresh.map((signal) => signal.text).join(" "))
    const hit = state.rules
      .map((rule) => ({ id: RulesStore.lessonId(rule.rule_key), overlap: [...words(rule.text)].filter((w) => said.has(w)).length }))
      .filter((rule) => shownIds.has(rule.id) && rule.overlap >= EDIT_OVERLAP && !RulesStore.dismissed(state, rule.id))
      .sort((a, b) => b.overlap - a.overlap)[0]
    log.info("rule edit candidate", { session: input.sessionID, hit: hit?.id, overlap: hit?.overlap, shown: shownIds.size })
    if (hit) {
      const drafted = await draft({ deps: input.deps, sessionID: input.sessionID, trigger: "shown_rule", signals: fresh, state, target: hit.id, note })
      // The shown rule already says it: no card, and no second drafting call for recurrence.
      if (drafted === "covered") return RulesTelemetry.skipped(input.sessionID, "shown_rule", "covered")
      if (drafted) {
        if (!stillShown()) return
        const card = await RuleProposal.ask({
          sessionID: input.sessionID, root: input.root, directory: input.directory, learn: input.learn, trigger: "shown_rule",
          draft: {
            text: drafted.text,
            // An edit or retire keeps the rule's scope; a new rule beside it takes the correction's.
            applies_to: drafted.change === "add"
              ? appliesTo(fresh.map((signal) => signal.text))
              : state.rules.find((r) => RulesStore.lessonId(r.rule_key) === hit.id)?.applies_to ?? [],
            why: clip(`${drafted.change === "add" ? "Corrected on the subject of a team rule" : "Corrected again after the rule was shown"}: ${drafted.reason}`, MAX_WHY),
            change: drafted.change, ...(drafted.replaces ? { replaces: drafted.replaces } : {}),
            origin: "session", evidence: { sessions: 1, correction }, topics: [hit.id],
          },
        })
        outcome = card ? `showed a ${drafted.change} card for a shown team rule` : "the proposal for this team rule was dismissed"
        return
      }
      // At most one drafting call per turn: the drafter found nothing to propose about the shown rule's subject.
      return RulesTelemetry.skipped(input.sessionID, "shown_rule", "no_draft")
    }

    // (a) The same topic corrected in 2 or more sessions, with no rule covering it. From the corrections themselves:
    // a project with no approved rules yet has no delivery snapshots, and must still be able to get its first rule.
    const all = await readSignals(input.root, Playbook.DEFAULT_NAME)
    const topics = unmatchedCorrectionTopics(all, await approvedLessons(input.root))
    const freshIds = new Set(fresh.map((signal) => signal.id))
    const candidates = topics.filter((t) => t.sessions >= RECURRENCE_SESSIONS && t.signal_ids.some((id) => freshIds.has(id)))
    const topic = candidates.find((t) => !RulesStore.dismissed(state, t.identifier))
    if (!topic) {
      if (!hit) outcome = "no team rule shown on this subject and no topic corrected in 2+ sessions"
      return RulesTelemetry.skipped(input.sessionID, "recurrence", candidates.length ? "topic_dismissed" : "no_topic")
    }
    const backing = all.filter((signal) => topic.signal_ids.includes(signal.id))
    const drafted = await draft({ deps: input.deps, sessionID: input.sessionID, trigger: "recurrence", signals: backing, state, addOnly: true, note })
    if (!drafted || drafted === "covered" || drafted.change !== "add")
      return RulesTelemetry.skipped(input.sessionID, "recurrence", drafted === "covered" ? "covered" : "no_draft")
    if (!stillShown()) return
    const card = await RuleProposal.ask({
      sessionID: input.sessionID, root: input.root, directory: input.directory, learn: input.learn, trigger: "recurrence",
      draft: {
        text: drafted.text,
        applies_to: appliesTo(backing.map((signal) => signal.text)),
        why: clip(`Corrected in ${topic.sessions} sessions: ${drafted.reason}`, MAX_WHY),
        change: "add", origin: "session",
        evidence: { sessions: topic.sessions, correction },
        topics: [topic.identifier],
      },
    })
    outcome = card ? `showed an add card for topic ${topic.identifier}` : `topic ${topic.identifier} was dismissed`
  } catch (error) {
    checked = []
    outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
    RulesTelemetry.skipped(input.sessionID, undefined, "failed")
    log.warn("rule proposal check failed", { error: outcome })
  } finally {
    running.delete(input.sessionID)
    if (outcome !== "no new corrections" || checked.length) {
      // Keep only ids of signals still on disk, so the list cannot grow past them or forget a live one. When the
      // signals cannot be read, nothing is pruned: an empty read must not wipe what was processed.
      const signals = checked.length ? await readSignals(input.root, Playbook.DEFAULT_NAME).catch(() => undefined) : undefined
      const live = signals ? new Set(signals.map((signal) => signal.id)) : undefined
      await RulesStore.update(input.root, (s) => {
        s.last_check = { at: new Date().toISOString(), session: input.sessionID, outcome }
        if (!checked.length) return
        const kept = live ? s.processed_signals.filter((id) => live.has(id)) : s.processed_signals
        s.processed_signals = [...kept, ...checked.filter((id) => !kept.includes(id))]
      }).catch(() => {})
    }
  }
}

/** "Remember this as a rule": a card right away, worded as the agent saved it. */
export async function explicit(input: {
  sessionID: string
  root: string
  directory: string
  learn: LearnConfig
  text: string
  /** The person's own message that asked for it: their words decide rule or memory as much as the agent's. */
  said?: string
  /** The memory block the agent meant to write, kept for the card's Memory choice. */
  memory?: { id: string; tags: string[] }
  /** Saves the request as before cards if the card closes unanswered (`RuleProposal.ask`). */
  unanswered?: (text: string) => Promise<void>
  /** What to keep on disk while the card is open (`RuleProposal.ask`). */
  request?: import("./proposal").RequestRecord
}): Promise<
  | { status: "shown"; card: Awaited<ReturnType<typeof RuleProposal.ask>>; choose: boolean }
  | { status: "invalid"; reason: string; kind: "rule" | "ambiguous" }
  | { status: "memory"; cue: string }
> {
  const text = input.text.replace(/\s+/g, " ").trim()
  const own = input.said ? RuleClassify.classify(input.said) : { kind: "ambiguous" as const }
  const { kind, cue } = own.kind === "ambiguous" ? RuleClassify.classify(text) : own
  if (kind === "memory") return { status: "memory", cue: cue ?? "a fact or preference" }
  const reason = lint(text)
  if (reason) return { status: "invalid", reason, kind }
  // The session's latest correction is evidence only when it is about the same thing: an unrelated quote would reach the
  // owner (and widen `applies_to`) for a rule it has nothing to do with.
  const said = words(text)
  const last = (await readSignals(input.root, Playbook.DEFAULT_NAME).catch(() => [] as Signal[]))
    .filter((signal) => signal.kind === "user_correction" && signal.sessionID === input.sessionID)
    .findLast((signal) => [...words(signal.text)].filter((w) => said.has(w)).length >= RELATED_OVERLAP)
  // Always a new rule: shared words are not a reason to replace a team rule (dbt rules share "model", "test",
  // "staging"), and the card has no "add instead". Changing a team rule is the correction path's job, where the
  // drafter decides whether the shown rule is the subject.
  const card = await RuleProposal.ask({
    sessionID: input.sessionID, root: input.root, directory: input.directory, learn: input.learn, unanswered: input.unanswered, request: input.request,
    draft: {
      text,
      applies_to: appliesTo([text, ...(last ? [last.text] : [])]),
      why: kind === "rule" ? "You asked to remember this as a rule" : "You asked to remember this",
      change: "add",
      origin: "explicit",
      evidence: { sessions: 1, ...(last ? { correction: { excerpt: excerpt(last.text), at: last.correctedAt ?? last.at } } : {}) },
      topics: [],
      ...(kind === "ambiguous" ? { choose: true } : {}),
      ...(input.memory ? { memory: input.memory } : {}),
    },
  })
  return { status: "shown", card, choose: kind === "ambiguous" }
}

export * as RuleTrigger from "./trigger"

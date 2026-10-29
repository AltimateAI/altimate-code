// altimate_change - new file
//
// Telemetry for workspace rules: one place that turns cards, replies and sync reports into events, so the call
// sites stay one line and no rule text, quote, path or glob can slip into a property.
import { Telemetry } from "../telemetry"
import type { ProposalCard } from "./events"
import type { RulesSync } from "./sync"

type Event = Telemetry.Event
type Of<T extends Event["type"]> = Extract<Event, { type: T }>
export type CardTrigger = Of<"rule_proposal_shown">["trigger"]
export type SyncTrigger = Of<"rules_sync">["trigger"]
export type AnswerOutcome = NonNullable<Of<"rule_proposal_answered">["outcome"]>

/**
 * Telemetry must never break the feature it observes. `betweenTurns`: the event can happen after a turn ended (a
 * card answered over HTTP, the after-turn check, the sync timer), and `serve` shuts telemetry down at the end of
 * every turn, so it would wait for the next turn and die with the process if none came. init() is idempotent and
 * honours an opt-out (it clears the buffer). Events raised inside a turn (delivery, the save tools) skip it.
 */
function send(event: Event, betweenTurns = true) {
  try {
    Telemetry.track(event)
    if (betweenTurns) void Telemetry.init().catch(() => {})
  } catch {}
}

export function shown(card: ProposalCard, trigger: CardTrigger, repeat: boolean) {
  send({
    type: "rule_proposal_shown",
    timestamp: Date.now(),
    session_id: card.sessionID,
    card_id: card.id,
    trigger,
    change: card.change,
    choose: !!card.choose,
    linked: !!card.workspace,
    is_owner: !!card.workspace?.is_owner,
    actions: [...card.actions],
    weakens_verification: !!card.weakens_verification,
    evidence_sessions: card.evidence.sessions,
    from_correction: !!card.evidence.correction,
    applies_to_count: card.applies_to.length,
    chars: card.chars,
    repeat,
  })
}

export function answered(input: {
  card: ProposalCard
  trigger: CardTrigger
  action: Of<"rule_proposal_answered">["action"]
  status: Of<"rule_proposal_answered">["status"]
  outcome?: AnswerOutcome
  edits: number
  shownAt: number
}) {
  send({
    type: "rule_proposal_answered",
    timestamp: Date.now(),
    session_id: input.card.sessionID,
    card_id: input.card.id,
    trigger: input.trigger,
    action: input.action,
    status: input.status,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    edits: input.edits,
    ms_since_shown: Math.max(0, Date.now() - input.shownAt),
  })
}

export function skipped(
  sessionID: string,
  trigger: Of<"rule_proposal_skipped">["trigger"],
  reason: Of<"rule_proposal_skipped">["reason"],
) {
  send({ type: "rule_proposal_skipped", timestamp: Date.now(), session_id: sessionID, ...(trigger ? { trigger } : {}), reason })
}

export function routed(sessionID: string, via: "training" | "memory", outcome: Of<"rule_remember_routed">["outcome"]) {
  send({ type: "rule_remember_routed", timestamp: Date.now(), session_id: sessionID, via, outcome }, false)
}

export function synced(trigger: SyncTrigger, report: RulesSync.RunReport, startedAt: number) {
  const base = { type: "rules_sync" as const, timestamp: Date.now(), session_id: "", trigger, duration_ms: Date.now() - startedAt }
  const { context, push, pull, usage } = report
  if (context.status !== "ready") return send({ ...base, status: context.status, reason: context.code })
  send({
    ...base,
    status: pull?.ok ? "ok" : "failed",
    ...(pull?.ok ? { rules: pull.rules, pending: pull.pending, notices: pull.notices.length } : {}),
    ...(push
      ? {
          sent: push.sent.filter((row) => !row.error).length,
          refused: push.sent.filter((row) => row.error).length,
          queued: push.queued,
          push_failed: !!push.error,
        }
      : {}),
    ...(usage ? { usage_items: usage.items, usage_failed: !!usage.error } : {}),
  })
}

export function delivered(input: Omit<Of<"rules_delivered">, "type" | "timestamp">) {
  if (input.rules > 0) send({ type: "rules_delivered", timestamp: Date.now(), ...input }, false)
}

export function learningChanged(on: boolean | null, learning: boolean, decidedBy: Of<"rules_learning_changed">["decided_by"]) {
  send({
    type: "rules_learning_changed",
    timestamp: Date.now(),
    session_id: "",
    choice: on === null ? "workspace" : on ? "on" : "off",
    learning,
    decided_by: decidedBy,
  })
}

export function command(name: string) {
  send({ type: "rules_command", timestamp: Date.now(), session_id: "", command: name })
}

export * as RulesTelemetry from "./telemetry"

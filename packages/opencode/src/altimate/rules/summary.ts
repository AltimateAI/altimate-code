// altimate_change - new file
//
// What clients show about workspace rules, from local state only (no network): the sidebar line, the
// `/rules` menu, `GET /altimate/rules/summary` and `learn status`.
import { RulesStore } from "./store"
import { RuleTrigger } from "./trigger"

type LearnConfig = Parameters<typeof RuleTrigger.learningEnabled>[0]

export interface Summary {
  linked: boolean
  workspace?: { name: string; owner_name?: string | null; is_owner: boolean }
  team_rules: number
  /** Proposals waiting for the owner, workspace-wide in this repository's scope. */
  pending_review: number
  /** This person's proposals still waiting. */
  mine_pending: number
  queued: number
  learning: boolean
  /** Who decided `learning`: an organization policy (`learn.capture` above project files), the person's own setting,
   * the workspace's "Learn from sessions", or the default. */
  learning_source: RuleTrigger.LearningSource
  /** The person's `/rules` choice, when they made one (absent: following config or the workspace). */
  personal_learning?: boolean
  pulled_at?: string
  last_error?: string
  notices: RulesStore.Notice[]
  /** Decisions on the person's own skill and knowledge submissions to the linked workspace, newest first, kept until
   * replaced by newer ones (`ReviewNotices`): clients show each once, like `notices`. */
  review_notices: ReviewNotice[]
  /** What the last post-turn check decided. */
  last_check?: { at: string; session: string; outcome: string }
}

/** A skill or knowledge decision as clients replay it: the fields of `rule.proposal.reviewed`. */
export interface ReviewNotice {
  public_id: string
  text: string
  status: string
  reason?: string
  reviewer?: string
  kind: "skill" | "knowledge"
  at: string
}

/** `directory`: where the session runs, whose workspace link names the review notices. Every server and CLI caller
 * passes the session's; it defaults to `root` only for callers with no session. */
export async function summary(root: string, learn: LearnConfig, env: NodeJS.ProcessEnv = process.env, directory = root): Promise<Summary> {
  const state = await RulesStore.read(root)
  const { ReviewNotices } = await import("../workspace/review-notices")
  const reviewNotices = (await ReviewNotices.stored(directory)).slice(-10).reverse().map((n): ReviewNotice => ({
    public_id: n.public_id,
    text: n.name,
    status: n.status,
    kind: n.kind,
    at: n.at,
    ...(n.reason ? { reason: n.reason } : {}),
    ...(n.reviewer ? { reviewer: n.reviewer } : {}),
  }))
  const learning = RuleTrigger.learningDecision(learn, state, env)
  // Dropped proposals first: the person was told they were queued, and a later pull does not clear it.
  const lastError = [RulesStore.scopeDropNote(state), state.last_error].filter(Boolean).join("; ")
  return {
    linked: !!state.workspace,
    ...(state.workspace ? { workspace: state.workspace } : {}),
    team_rules: state.rules.length,
    pending_review: state.pending_count,
    mine_pending: state.sent.filter((s) => s.status === "pending").length,
    queued: state.outbox.length,
    learning: learning.on,
    learning_source: learning.source,
    ...(state.personal_learning !== undefined ? { personal_learning: state.personal_learning } : {}),
    ...(state.pulled_at ? { pulled_at: state.pulled_at } : {}),
    ...(lastError ? { last_error: lastError } : {}),
    notices: state.notices.slice(-10).reverse(),
    review_notices: reviewNotices,
    ...(state.last_check ? { last_check: state.last_check } : {}),
  }
}

/** "6 team rules · 3 pending review": zero counts after the first are left out. */
export function sidebarLine(s: Pick<Summary, "team_rules" | "pending_review" | "queued">): string {
  const parts = [`${s.team_rules} team ${s.team_rules === 1 ? "rule" : "rules"}`]
  if (s.pending_review > 0) parts.push(`${s.pending_review} pending review`)
  if (s.queued > 0) parts.push(`${s.queued} queued`)
  return parts.join(" · ")
}

export interface RuleRow {
  public_id: string
  text: string
  applies_to: string[]
  pinned: boolean
  status: string
  reason?: string
  reviewer?: string
  source: "team" | "mine"
}

/** Active team rules, then this person's proposals (newest first) with their status and reason. */
export async function rows(root: string, view: "active" | "mine" | "all" = "all"): Promise<RuleRow[]> {
  const state = await RulesStore.read(root)
  const active: RuleRow[] = state.rules.map((rule) => ({
    public_id: rule.public_id, text: rule.text, applies_to: rule.applies_to, pinned: rule.pinned, status: "active", source: "team",
  }))
  const mine: RuleRow[] = [
    ...state.outbox.map((entry) => ({ public_id: entry.id, text: entry.item.text, applies_to: entry.item.applies_to, pinned: false, status: "queued", source: "mine" as const })),
    ...[...state.sent].reverse().map((sent) => ({
      public_id: sent.public_id, text: sent.text, applies_to: [], pinned: false, status: sent.status,
      ...(sent.reason ? { reason: sent.reason } : {}), ...(sent.reviewer ? { reviewer: sent.reviewer } : {}), source: "mine" as const,
    })),
  ]
  return view === "active" ? active : view === "mine" ? mine : [...active, ...mine]
}

export * as RulesSummary from "./summary"

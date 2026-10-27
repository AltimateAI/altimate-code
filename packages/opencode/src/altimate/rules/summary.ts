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
  /** Who decided `learning`: the person's own setting, or the workspace's "Learn from sessions". */
  learning_source: "you" | "workspace" | "default"
  pulled_at?: string
  last_error?: string
  notices: RulesStore.Notice[]
  /** What the last post-turn check decided. */
  last_check?: { at: string; session: string; outcome: string }
}

export async function summary(root: string, learn: LearnConfig, env: NodeJS.ProcessEnv = process.env): Promise<Summary> {
  const state = await RulesStore.read(root)
  const own = env.ALTIMATE_LEARN_CAPTURE !== undefined && env.ALTIMATE_LEARN_CAPTURE !== "" || learn?.capture !== undefined || learn?.enabled === false
  return {
    linked: !!state.scope,
    ...(state.workspace ? { workspace: state.workspace } : {}),
    team_rules: state.rules.length,
    pending_review: state.pending_count,
    mine_pending: state.sent.filter((s) => s.status === "pending").length,
    queued: state.outbox.length,
    learning: RuleTrigger.learningEnabled(learn, state, env),
    learning_source: own ? "you" : state.scope ? "workspace" : "default",
    ...(state.pulled_at ? { pulled_at: state.pulled_at } : {}),
    ...(state.last_error ? { last_error: state.last_error } : {}),
    notices: state.notices.slice(-10).reverse(),
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

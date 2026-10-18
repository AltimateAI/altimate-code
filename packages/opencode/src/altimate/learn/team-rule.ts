// altimate_change - new file
//
// A rule a person asks the agent to remember, routed into learn when lesson sync is on: staged as a lesson and sent
// to the workspace owner's review queue, instead of being written to project training where it would apply at once
// and reach the team through git without review. Staging goes through `reflectCore` with the rule as its only change,
// so curation (dedupe against local and team lessons), proposals and history are the same as a reflection's.
import { syncEnabled } from "./config"
import { lint, normalizeText } from "./curator"
import * as Playbook from "./playbook"
import * as Sync from "./sync"

type LearnConfig = Parameters<typeof syncEnabled>[0]

export type TeamRuleResult =
  /** Sync is off or the project is not linked: the caller keeps its own behaviour. */
  | { status: "not_routed" }
  /** Staged and queued for the owner's review. */
  | { status: "proposed"; text: string }
  /** The same lesson already exists, locally or in the team's set. */
  | { status: "exists"; text: string }
  /** The text cannot be a lesson as it is: one line, within the lesson length limit, no commands or secrets. */
  | { status: "invalid"; reason: string }

export async function saveTeamRule(input: {
  root: string
  directory: string
  learn: LearnConfig
  text: string
  session?: string
}): Promise<TeamRuleResult> {
  if (!syncEnabled(input.learn)) return { status: "not_routed" }
  const scope = await Sync.proposalScope(input.root, input.directory, input.learn).catch(() => undefined)
  if (!scope) return { status: "not_routed" }
  // The same per-text check `Store.validateCandidate` applies: lint the text as given, then refuse hidden or
  // non-normalized characters rather than silently rewriting the rule.
  const text = input.text.trim()
  const reason = lint(text) ?? (normalizeText(text) !== text ? "contains hidden or non-normalized characters" : undefined)
  if (reason) return { status: "invalid", reason }
  const { reflectCore } = await import("./session-reflect")
  const result = await reflectCore({
    root: input.root,
    name: Playbook.DEFAULT_NAME,
    source: { prompts: [], calls: [] },
    feedback: text,
    kind: "user",
    origin: input.session ?? "training_save",
    session: input.session,
    deltas: [{ op: "ADD", text, reason: "a rule the person asked the agent to remember" }],
    recoverPending: false,
    sync: { scope, origin: "manual" },
  })
  if (result.curated.applied.some((a) => a.op === "ADD")) {
    void Sync.pushSoon(input.root, input.directory, input.learn)
    return { status: "proposed", text }
  }
  const rejected = result.curated.rejected[0]?.reason
  if (rejected) return { status: "invalid", reason: rejected }
  // Folded into an existing lesson (a near-duplicate counts as helpful there): nothing new to propose.
  return { status: "exists", text }
}

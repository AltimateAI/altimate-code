// altimate_change - new file
//
// "Your requests" for clients other than the TUI (the VS Code extension, the Claude Code and Codex plugins): one list of
// what the person sent to the linked workspace for review — team rules, skills and knowledge bases — with each one's
// status, the reviewer and their reason, and the actions the person may take on a skill or knowledge request (withdraw
// a waiting one, remove an approved one from the workspace). Approving and rejecting stay in the web app.
//
// Rules come from the person's local rules state (`RulesSummary.rows`, no network), shown only for the account and
// workspace it was pulled for. Skill and knowledge requests are read from the server with one captured credential, checked against the account the project's link was resolved
// with, as the review poll does.
import { Log } from "@/util/log"
import { RulesApiError } from "../rules/api"
import { printable } from "../rules/printable"
import { ReviewApi } from "./review-api"

const log = Log.create({ service: "altimate-workspace-review-requests" })

export type RequestKind = "rule" | "skill" | "knowledge"
// altimate_change start — workspace review: request changes (`resubmit`: a rule's author sends a new wording)
export type RequestAction = "withdraw" | "remove" | "resubmit"
// altimate_change end

/** One request as clients show it. Server text is made printable. */
export interface Request {
  kind: RequestKind
  public_id: string
  name: string
  /** Rules: `queued`, `pending`, `active`, `rejected`, `retired`, … Skills and knowledge: `pending`, `active`,
   * `rejected`, `superseded`, `withdrawn`, `retired`. */
  status: string
  /** Skills and knowledge: `add` (new) or `edit` (an update to an approved one). */
  change?: string
  reason?: string
  reviewer?: string
  at?: string
  /** Skills and knowledge: the request's version, sent back as `expected_version` with an action. */
  version?: number
  /** A request waiting past the review window (it can still be decided). */
  expired?: boolean
  /** What the person may do from a client: withdraw a waiting or sent-back one, remove an approved one, send a new
   * wording of a rule sent back for changes. */
  actions: RequestAction[]
}

export type ReviewListing =
  /** `complete` is false when a page was not read or a row could not be read by this version (`skipped`). */
  | { status: "ok"; workspace: { id: number; name: string }; items: ReviewApi.Contribution[]; complete: boolean }
  | { status: "signed_out" | "not_linked" | "account_changed" | "unsupported" }
  | { status: "failed"; error: string }

/** The person's own skill and knowledge requests on the project's workspace. Never throws. */
export async function listReview(directory: string): Promise<ReviewListing> {
  try {
    const ctx = await context(directory)
    if (!ctx.ready) return ctx.status === "unconfirmed" ? { status: "failed", error: UNCONFIRMED } : { status: ctx.status }
    const listed = await ReviewApi.listMine(ctx.datamateId, ctx.actAs)
    return { status: "ok", workspace: { id: ctx.datamateId, name: ctx.name }, items: listed.items, complete: listed.complete && listed.skipped === 0 }
  } catch (error) {
    if (ReviewApi.unavailable(error)) return { status: "unsupported" }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

/** A skill or knowledge request as a `Request`. */
export function fromContribution(item: ReviewApi.Contribution): Request {
  const actions: RequestAction[] = []
  // A request sent back for changes is still with its author: they may take it back too.
  if (item.status === "pending" || item.status === "changes_requested") actions.push("withdraw")
  if (item.status === "active") actions.push("remove")
  return {
    kind: item.kind,
    public_id: item.public_id,
    name: printable(item.name),
    status: item.status,
    change: item.change,
    ...(item.review_reason ? { reason: printable(item.review_reason) } : {}),
    ...(item.reviewed_by_name ? { reviewer: printable(item.reviewed_by_name) } : {}),
    at: item.reviewed_at ?? item.updated_at,
    version: item.version,
    ...(item.expired ? { expired: true } : {}),
    actions,
  }
}

/** The person's team rule requests (local rules state, no network), only when that state was pulled for the account
 * signed in now and for the workspace the project is on: `workspaceId` when the skill listing resolved it, else the
 * folder's cached link. A folder with no cached link, or one that cannot be read, hides them. Text is made printable. */
export async function ruleRequests(root: string, directory: string, workspaceId?: number): Promise<Request[]> {
  const [{ RulesStore }, { RulesSummary }, { RulesService }] = await Promise.all([
    import("../rules/store"),
    import("../rules/summary"),
    import("../rules/service"),
  ])
  const state = await RulesStore.read(root)
  if (!state.scope || !(await RulesStore.verified(state))) return []
  const expected =
    workspaceId ?? (await RulesService.localBinding(root, directory, { strict: true }).then((b) => b?.datamateId, () => undefined))
  if (expected !== state.scope.datamateId) return []
  // altimate_change start — workspace review: request changes (a rule still open on the server can be acted on)
  const open = new Map(state.my_pending.map((p) => [p.public_id, p]))
  return (await RulesSummary.rows(root, "mine")).map((row) => {
    const pending = open.get(row.public_id)
    // Still open on the server: its status and comment are the last pull's (the local row may not have heard yet).
    const status = pending ? (pending.status ?? "pending") : row.status
    const reason = pending ? (pending.review_reason ?? undefined) : row.reason
    return {
      kind: "rule" as const,
      public_id: row.public_id,
      name: printable(row.text),
      status,
      ...(reason ? { reason: printable(reason) } : {}),
      ...(row.reviewer ? { reviewer: printable(row.reviewer) } : {}),
      ...(pending?.version ? { version: pending.version } : {}),
      actions: pending?.version ? ruleActions(pending.status ?? "pending", pending.change) : [],
    }
  })
  // altimate_change end
}

// altimate_change start — workspace review: request changes
/** What the author may do on a rule proposal still open on the server: withdraw it, and, sent back for changes, send a
 * new wording (not for a retirement: there is no wording to change). */
function ruleActions(status: string, change: string): RequestAction[] {
  if (status === "changes_requested") return change === "retire" ? ["withdraw"] : ["resubmit", "withdraw"]
  return status === "pending" ? ["withdraw"] : []
}
// altimate_change end

export type ActionResult =
  | { ok: true; request: Request }
  // altimate_change start — workspace review: request changes (`uncertain`: the server's answer leaves its state unknown)
  | { ok: false; status: ActionStatus; code: string; error: string; uncertain?: true }
  // altimate_change end

const UNCONFIRMED = "Could not confirm the project's workspace link just now. Try again shortly."
const PASSED: readonly number[] = [400, 401, 403, 404, 409, 422]
type ActionStatus = 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503

/** Withdraw or remove one of the person's skill or knowledge requests on the project's workspace. Never throws. */
export async function act(
  directory: string,
  publicId: string,
  // altimate_change start — workspace review: request changes (`resubmit` is a rule's, `actOnRule`)
  action: "withdraw" | "remove",
  // altimate_change end
  body: { expected_version: number; reason?: string },
): Promise<ActionResult> {
  try {
    const ctx = await context(directory)
    if (!ctx.ready) return notReady(ctx.status)
    const item =
      action === "withdraw"
        ? await ReviewApi.withdraw(ctx.datamateId, publicId, { expected_version: body.expected_version }, ctx.actAs)
        : await ReviewApi.retire(ctx.datamateId, publicId, body, ctx.actAs)
    return { ok: true, request: fromContribution(item) }
  } catch (error) {
    return failure(error)
  }
}

type RulesState = import("../rules/store").State

/** Out of the open proposals now, and remembered against a pull already on its way (`closed_locally`), with the new
 * proposal a resend opened. Returns the open entry it took out, if any. */
function closeLocally(s: RulesState, publicId: string, at: string, replacedBy?: RulesState["my_pending"][number]) {
  const removed = s.my_pending.find((p) => p.public_id === publicId)
  s.my_pending = s.my_pending.filter((p) => p.public_id !== publicId)
  s.close_seq += 1
  s.closed_locally.push({ public_id: publicId, at, seq: s.close_seq, ...(replacedBy ? { replaced_by: replacedBy } : {}) })
  return removed
}

/** The author closed it: the reviewer and comment of the earlier decision are not who closed it, or why. */
function authorClosed(sent: { status: string; updated_at: string; reason?: string; reviewer?: string }, status: string, at: string) {
  Object.assign(sent, { status, updated_at: at })
  delete sent.reason
  delete sent.reviewer
}

function notReady(status: "signed_out" | "not_linked" | "account_changed" | "unconfirmed"): ActionResult {
  if (status === "signed_out") return { ok: false, status: 401, code: "signed_out", error: "Sign in to Altimate first." }
  if (status === "unconfirmed") return { ok: false, status: 503, code: "link_unconfirmed", error: UNCONFIRMED }
  return { ok: false, status: 409, code: status, error: "This project is not linked to a workspace for the account signed in now." }
}

function failure(error: unknown): ActionResult {
  if (error instanceof RulesApiError) {
    // A stale `expected_version` (412) is a conflict the client resolves by refreshing. Every answer carries a code:
    // a client tells a server refusal from the serve route's own 409s by it.
    const status = (error.status === 412 ? 409 : error.status && PASSED.includes(error.status) ? error.status : 502) as ActionStatus
    const code = error.code ?? (error.status === 412 ? "version_conflict" : status === 502 ? "upstream_failed" : "refused")
    return { ok: false, status, code, error: printable(error.message), ...(UNCERTAIN.has(code) ? { uncertain: true as const } : {}) }
  }
  return { ok: false, status: 502, code: "upstream_failed", error: printable(error instanceof Error ? error.message : String(error)), uncertain: true }
}

// altimate_change start — workspace review: request changes
/** Server answers that leave the proposal's state unknown here (no answer, or a conflict meaning it changed since the
 * last pull), marked `uncertain` on the result: the caller syncs, so `/rules` shows what the server has. A refusal
 * decided here, before any server call, is not one. */
const UNCERTAIN: ReadonlySet<string> = new Set(["upstream_failed", "invalid_status", "version_conflict"])

/** Withdraw one of the person's rule proposals, or send a new wording of one sent back for changes, on the project's
 * workspace. The proposal's version comes from the last pull (`my_pending`); `expectedVersion`, when the caller read
 * one, must still be it. The local rules state records the answer at once, so `/rules` shows it before the next pull,
 * but only while it is still the state pulled for this account, workspace and credential. Never throws. */
export async function actOnRule(
  root: string,
  directory: string,
  publicId: string,
  action: "withdraw" | "resubmit",
  text?: string,
  expectedVersion?: number,
): Promise<ActionResult> {
  try {
    const ctx = await context(directory)
    if (!ctx.ready) return notReady(ctx.status)
    const [{ RulesStore }, { RulesApi }, { RulesSync }, { lint, normalizeText }] = await Promise.all([
      import("../rules/store"),
      import("../rules/api"),
      import("../rules/sync"),
      import("../learn/curator"),
    ])
    const state = await RulesStore.read(root)
    // The rules state must be the one pulled for this workspace with the credential signed in now, and an answer is
    // recorded only into that same state: another account or workspace may be adopted while the request is out.
    if (state.scope?.datamateId !== ctx.datamateId || !(await RulesStore.verified(state)))
      return { ok: false, status: 409, code: "not_open", error: NOT_OPEN }
    const scope = state.scope
    const pulledWith = state.pulled_with
    const ours = (s: RulesState) => RulesStore.sameScope(s.scope, scope) && s.pulled_with === pulledWith
    const pending = state.my_pending.find((p) => p.public_id === publicId)
    if (!pending?.version) return { ok: false, status: 409, code: "not_open", error: NOT_OPEN }
    if (expectedVersion !== undefined && expectedVersion !== pending.version)
      return { ok: false, status: 409, code: "version_conflict", error: "This proposal changed since you read it. Open /rules again." }
    const actions = ruleActions(pending.status ?? "pending", pending.change)
    if (!actions.includes(action))
      return { ok: false, status: 409, code: "not_allowed", error: action === "resubmit" ? "Only a proposal sent back for changes can be sent again." : "This proposal cannot be withdrawn." }
    // The server already acted when this runs: a busy learn lock is waited out (`record`), and a write that still
    // fails is logged, not reported as a failed action (the next pull records it).
    const recordLocally = (change: (s: RulesState) => void) =>
      RulesSync.record(root, (s) => (ours(s) ? change(s) : undefined)).catch((error) =>
        log.warn("rule action applied on the server; not recorded locally", { error: error instanceof Error ? error.message : String(error) }),
      )
    if (action === "withdraw") {
      await RulesApi.withdraw(ctx.actAs, ctx.datamateId, publicId, { expected_version: pending.version })
      // Stamped once the server answered: a pull that started before then cannot know about it (`RulesSync.pull`).
      const at = new Date().toISOString()
      await recordLocally((s) => {
        const removed = closeLocally(s, publicId, at)
        // Counted once, against what the state holds now: a pull or another withdrawal may have taken it out already.
        if (removed && (removed.status ?? "pending") === "pending") s.pending_count = Math.max(0, s.pending_count - 1)
        const sent = s.sent.find((x) => x.public_id === publicId)
        if (sent && !AUTHOR_CLOSED.has(sent.status)) authorClosed(sent, "withdrawn", at)
      })
      return { ok: true, request: { kind: "rule", public_id: publicId, name: printable(pending.text), status: "withdrawn", actions: [] } }
    }
    // Checked like an edited proposal: one line, within the length, no commands, links or secrets. Linted as typed (a
    // line break is a control character the normalized form drops), sent normalized.
    const typed = text?.trim() ?? ""
    if (!typed) return { ok: false, status: 400, code: "invalid_text", error: "Write the new wording of the rule." }
    const problem = lint(typed)
    if (problem) return { ok: false, status: 400, code: "invalid_text", error: `The new wording was not sent: ${problem}.` }
    const wording = normalizeText(typed).trim()
    const result = await RulesApi.resubmit(ctx.actAs, ctx.datamateId, publicId, { expected_version: pending.version, text: wording })
    if (result.status !== "pending" || !result.public_id)
      return { ok: false, status: 422, code: result.error_code ?? result.status, error: printable(result.error_detail || result.error_code || result.status) }
    const newId = result.public_id
    const at = new Date().toISOString()
    const opened = {
      ...pending,
      public_id: newId,
      rule_key: result.rule_key ?? pending.rule_key,
      text: wording,
      created_at: at,
      status: "pending",
      version: result.version,
      review_reason: null,
    }
    await recordLocally((s) => {
      // A pull that ran meanwhile may know it already: decided (a notice recorded), or listed. Its record stands.
      const decision = s.notices.filter((n) => n.public_id === newId).at(-1)
      const open = !decision && !!result.version
      closeLocally(s, publicId, at, open ? opened : undefined)
      // The new proposal waits for review: it can be withdrawn, and reaches the person's sessions, before the next pull.
      if (open && !s.my_pending.some((p) => p.public_id === newId)) {
        s.my_pending.push(opened)
        s.pending_count += 1
      }
      const sent = s.sent.find((x) => x.public_id === publicId)
      if (sent && !AUTHOR_CLOSED.has(sent.status)) authorClosed(sent, "superseded", at)
      if (!s.sent.some((x) => x.public_id === newId))
        s.sent.push({
          public_id: newId,
          text: wording,
          change: pending.change,
          status: decision?.status ?? "pending",
          ...(decision?.reason ? { reason: decision.reason } : {}),
          ...(decision?.reviewer ? { reviewer: decision.reviewer } : {}),
          sent_at: at,
          updated_at: decision?.at ?? at,
        })
    })
    return { ok: true, request: { kind: "rule", public_id: newId, name: printable(wording), status: "pending", ...(result.version ? { version: result.version } : {}), actions: ["withdraw"] } }
  } catch (error) {
    return failure(error)
  }
}

const NOT_OPEN = "This proposal is not waiting for review in the last sync. Sync rules and try again."
/** Statuses only the author sets: not overwritten by a later local record. */
const AUTHOR_CLOSED: ReadonlySet<string> = new Set(["withdrawn", "superseded"])
// altimate_change end

/** The workspace the project is linked to, with one captured credential that is still the one signed in. */
export async function context(
  directory: string,
): Promise<
  | { ready: false; status: "signed_out" | "not_linked" | "account_changed" | "unconfirmed" }
  | { ready: true; actAs: import("./api-client").ActAs; datamateId: number; name: string }
> {
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }] = await Promise.all([
    import("./api-client"),
    import("./state"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { ready: false, status: "signed_out" }
  // The link is resolved with the credential signed in at the time: it must be the captured one before and after, or
  // one account's workspace could be paired with another account's credential.
  const captured = credentialDigest(actAs.url, actAs.instance, actAs.apiKey)
  if ((await accountDigest()) !== captured) return { ready: false, status: "account_changed" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  // `unknown`: the link could not be confirmed (no answer, an unreadable pin), which is not the same as no link.
  if (outcome.status === "unknown") return { ready: false, status: "unconfirmed" }
  if (outcome.status !== "bound") return { ready: false, status: "not_linked" }
  if ((await accountDigest()) !== captured) return { ready: false, status: "account_changed" }
  return { ready: true, actAs, datamateId: outcome.binding.datamateId, name: printable(outcome.binding.datamateName) }
}

export * as ReviewRequests from "./review-requests"

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
import { RulesApiError } from "../rules/api"
import { printable } from "../rules/printable"
import { ReviewApi } from "./review-api"

export type RequestKind = "rule" | "skill" | "knowledge"
export type RequestAction = "withdraw" | "remove"

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
  /** What the person may do from a client: withdraw a waiting one, remove an approved one. */
  actions: RequestAction[]
}

export type ReviewListing =
  | { status: "ok"; workspace: { id: number; name: string }; items: ReviewApi.Contribution[]; complete: boolean }
  | { status: "signed_out" | "not_linked" | "account_changed" | "unsupported" }
  | { status: "failed"; error: string }

/** The person's own skill and knowledge requests on the project's workspace. Never throws. */
export async function listReview(directory: string): Promise<ReviewListing> {
  try {
    const ctx = await context(directory)
    if (!ctx.ready) return { status: ctx.status }
    const listed = await ReviewApi.listMine(ctx.datamateId, ctx.actAs)
    return { status: "ok", workspace: { id: ctx.datamateId, name: ctx.name }, items: listed.items, complete: listed.complete }
  } catch (error) {
    if (ReviewApi.unavailable(error)) return { status: "unsupported" }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

/** A skill or knowledge request as a `Request`. */
export function fromContribution(item: ReviewApi.Contribution): Request {
  const actions: RequestAction[] = []
  if (item.status === "pending") actions.push("withdraw")
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
 * folder's cached link. A link cache that cannot be read hides them. Text is made printable. */
export async function ruleRequests(root: string, directory: string, workspaceId?: number): Promise<Request[]> {
  const [{ RulesStore }, { RulesSummary }, { RulesService }] = await Promise.all([
    import("../rules/store"),
    import("../rules/summary"),
    import("../rules/service"),
  ])
  const state = await RulesStore.read(root)
  if (!state.scope || !(await RulesStore.verified(state))) return []
  const expected =
    workspaceId ?? (await RulesService.localBinding(root, directory, { strict: true }).then((b) => b?.datamateId ?? state.scope!.datamateId, () => undefined))
  if (expected !== state.scope.datamateId) return []
  return (await RulesSummary.rows(root, "mine")).map((row) => ({
    kind: "rule" as const,
    public_id: row.public_id,
    name: printable(row.text),
    status: row.status,
    ...(row.reason ? { reason: printable(row.reason) } : {}),
    ...(row.reviewer ? { reviewer: printable(row.reviewer) } : {}),
    actions: [],
  }))
}

export type ActionResult =
  | { ok: true; request: Request }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 422 | 502; code?: string; error: string }

/** Withdraw or remove one of the person's skill or knowledge requests on the project's workspace. Never throws. */
export async function act(
  directory: string,
  publicId: string,
  action: RequestAction,
  body: { expected_version: number; reason?: string },
): Promise<ActionResult> {
  try {
    const ctx = await context(directory)
    if (!ctx.ready) {
      if (ctx.status === "signed_out") return { ok: false, status: 401, code: "signed_out", error: "Sign in to Altimate first." }
      return { ok: false, status: 409, code: ctx.status, error: "This project is not linked to a workspace for the account signed in now." }
    }
    const item =
      action === "withdraw"
        ? await ReviewApi.withdraw(ctx.datamateId, publicId, { expected_version: body.expected_version }, ctx.actAs)
        : await ReviewApi.retire(ctx.datamateId, publicId, body, ctx.actAs)
    return { ok: true, request: fromContribution(item) }
  } catch (error) {
    if (error instanceof RulesApiError) {
      const status = (error.status && [400, 401, 403, 404, 409, 422].includes(error.status) ? error.status : 502) as 400 | 401 | 403 | 404 | 409 | 422 | 502
      return { ok: false, status, ...(error.code ? { code: error.code } : {}), error: printable(error.message) }
    }
    return { ok: false, status: 502, error: printable(error instanceof Error ? error.message : String(error)) }
  }
}

/** The workspace the project is linked to, with one captured credential that is still the one signed in. */
async function context(
  directory: string,
): Promise<
  | { ready: false; status: "signed_out" | "not_linked" | "account_changed" }
  | { ready: true; actAs: import("./api-client").ActAs; datamateId: number; name: string }
> {
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }] = await Promise.all([
    import("./api-client"),
    import("./state"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { ready: false, status: "signed_out" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  if (outcome.status !== "bound") return { ready: false, status: "not_linked" }
  if ((await accountDigest()) !== credentialDigest(actAs.url, actAs.instance, actAs.apiKey)) return { ready: false, status: "account_changed" }
  return { ready: true, actAs, datamateId: outcome.binding.datamateId, name: printable(outcome.binding.datamateName) }
}

export * as ReviewRequests from "./review-requests"

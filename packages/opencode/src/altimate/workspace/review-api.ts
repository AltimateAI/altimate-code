// altimate_change - new file
//
// Wire client for workspace review in altimate-backend (`/datamates/{id}/reviews*`): a member submits their own skill or
// knowledge base to a workspace, and the owner or an admin approves or rejects it in the web app. The CLI only submits and reads
// status; it never approves or rejects.
//
// Errors are classified by the rules client's `classify` (one mapping for both features): a 404 `reviews_not_available`,
// or a 404 whose detail is plain text (a server without these routes answers `{"detail": "Not Found"}`), is
// `unsupported`; a 404 with an object detail comes from these routes and is a refusal. A 401, or a 403 with no code, is
// `auth`, never a decision about the request; a coded 409 is `conflict`.
//
// Every call takes the credential its caller captured once (`ActAs`): a sign-in change mid-flow never splits one flow
// across two accounts.
import z from "zod"
import { classify, RulesApiError } from "../rules/api"
import { altimateRequest, type ActAs } from "./api-client"

/** The 404 code of a tenant whose database has no review tables yet. */
const UNAVAILABLE = "reviews_not_available"
/** Pages of `view=mine` read at most (50 per page): the server caps open requests per author at 50, so this holds every
 * open one and the most recent decisions. */
export const MAX_PAGES = 10
const PAGE_SIZE = 50

export const Summary = z.object({
  is_owner: z.boolean(),
  /** `owner`, `admin` or `member` (absent from servers older than workspace roles: see `WorkspaceRole.roleOf`). */
  role: z.string().nullable().optional(),
  review_enabled: z.boolean(),
  owner_name: z.string().nullable().optional(),
  pending_count: z.number().int(),
  mine_pending_count: z.number().int(),
})
export type Summary = z.infer<typeof Summary>

export const Contribution = z.object({
  public_id: z.string(),
  kind: z.enum(["skill", "knowledge"]),
  subject_id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  change: z.enum(["add", "edit"]),
  // `withdrawn`: the author withdrew it (or it was withdrawn when the author deleted the item or lost access);
  // `retired`: removed from the workspace after approval, by an owner, an admin or the author. A status this version
  // does not know makes the row unreadable (skipped and counted), never misread.
  status: z.enum(["pending", "active", "rejected", "superseded", "withdrawn", "retired"]),
  version: z.number().int(),
  is_mine: z.boolean(),
  proposed_by_name: z.string().nullable().optional(),
  reviewed_by_name: z.string().nullable().optional(),
  reviewed_at: z.string().nullable().optional(),
  review_reason: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable().optional(),
  expired: z.boolean().default(false),
  file_count: z.number().int().nullable().optional(),
  document_version: z.number().int().nullable().optional(),
  /** Whether the caller made the last decision (`reviewed_by`): a person is not told of their own retire. Absent from
   * older servers: read as not. */
  decided_by_me: z.boolean().default(false),
})
export type Contribution = z.infer<typeof Contribution>

export const SubmitResult = z.object({
  status: z.enum(["active", "pending"]),
  attached_directly: z.boolean(),
  duplicate: z.boolean(),
  // A row a later server shapes differently (a new status) must not turn an accepted submission into a failure.
  contribution: Contribution.nullable().catch(null),
})
export type SubmitResult = z.infer<typeof SubmitResult>

const Page = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().nullable().optional(),
  page: z.number().int().nullable().optional(),
  pages: z.number().int().nullable().optional(),
})

/** One request; any failure (transport, status, or a body that does not parse) is a classified `RulesApiError`. */
async function call<T>(
  schema: z.ZodType<T>,
  method: string,
  datamateId: number,
  subpath: string,
  opts: { actAs: ActAs; body?: unknown; query?: Record<string, string>; expectedStatuses?: readonly number[] },
): Promise<T> {
  try {
    const raw = await altimateRequest<unknown>(method, `/${datamateId}/reviews${subpath}`, {
      base: "/datamates",
      actAs: opts.actAs,
      ...(opts.expectedStatuses ? { expectedStatuses: opts.expectedStatuses } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.query ? { query: opts.query } : {}),
    })
    return schema.parse(raw)
  } catch (error) {
    throw classify(error, UNAVAILABLE)
  }
}

/** Whether `error` says this server or tenant has no workspace review: the caller falls back to what it did before. */
export function unavailable(error: unknown): boolean {
  return error instanceof RulesApiError && error.kind === "unsupported"
}

/** The caller's view of review on the workspace: owner or member, whether review is on, and the owner's name. */
export function summary(datamateId: number, actAs: ActAs): Promise<Summary> {
  return call(Summary, "GET", datamateId, "/summary", { actAs })
}

/** Submit the caller's own skill or knowledge base to the workspace. The owner's is attached directly. `source` is
 * recorded in the request's audit events. */
export function submit(datamateId: number, body: { kind: "skill" | "knowledge"; subject_id: string; source?: "cli" }, actAs: ActAs): Promise<SubmitResult> {
  return call(SubmitResult, "POST", datamateId, "", { actAs, body })
}

/** The caller's own submissions to the workspace, newest first, every page up to `MAX_PAGES`. A row this version cannot
 * read is skipped and counted. `complete` is false when the list was cut at the page cap, or when the server's paging
 * does not add up (a page short of `total`): only a complete list may say a request no longer exists. */
export async function listMine(datamateId: number, actAs: ActAs): Promise<{ items: Contribution[]; skipped: number; complete: boolean }> {
  const items: Contribution[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await call(Page, "GET", datamateId, "", {
      actAs,
      query: { view: "mine", page: String(page), size: String(PAGE_SIZE) },
      // A server or tenant without review answers 404 here on every poll: an answer, not an API error to report.
      expectedStatuses: [404],
    })
    const before = items.length + skipped
    for (const row of body.items) {
      const parsed = Contribution.safeParse(row)
      if (!parsed.success) {
        skipped += 1
        continue
      }
      // A row that moved across a page boundary between two reads is listed once.
      if (seen.has(parsed.data.public_id)) continue
      seen.add(parsed.data.public_id)
      items.push(parsed.data)
    }
    // A later page that adds nothing new (a server that ignores `page` repeats the first) ends the read, incomplete.
    if (page > 1 && body.items.length > 0 && items.length + skipped === before) return { items, skipped, complete: false }
    // Without `pages`, a full page may have more after it.
    const pages = body.pages ?? (body.items.length < PAGE_SIZE ? page : page + 1)
    if (page >= pages || body.items.length === 0) {
      const short = typeof body.total === "number" && items.length + skipped < body.total
      return { items, skipped, complete: !short }
    }
  }
  return { items, skipped, complete: false }
}

/** One of the caller's own requests by id (the author may read their own), or null when the server no longer has it.
 * For a request the capped list did not reach: its decision is noticed even when newer requests push it past the cap. */
export async function getMine(datamateId: number, publicId: string, actAs: ActAs): Promise<Contribution | null> {
  try {
    return await call(Contribution, "GET", datamateId, `/${encodeURIComponent(publicId)}`, { actAs, expectedStatuses: [404] })
  } catch (error) {
    if (error instanceof RulesApiError && error.kind === "rejected" && error.status === 404) return null
    throw error
  }
}

/** The author takes back their own request still waiting for review (`withdrawn`). Answers the request as it is now; a
 * repeat changes nothing. Refusals arrive classified: 403 `author_only`, 409 `already_decided` / `version_conflict`. */
export function withdraw(datamateId: number, publicId: string, body: { expected_version: number }, actAs: ActAs): Promise<Contribution> {
  return call(Contribution, "POST", datamateId, `/${encodeURIComponent(publicId)}/withdraw`, {
    actAs,
    body: { ...body, source: "cli" },
  })
}

/** Remove an approved contribution from the workspace (`retired`), with no review: its author, the owner or an admin.
 * A reason is required when removing someone else's (422 `reason_required`). */
export function retire(
  datamateId: number,
  publicId: string,
  body: { expected_version: number; reason?: string },
  actAs: ActAs,
): Promise<Contribution> {
  return call(Contribution, "POST", datamateId, `/${encodeURIComponent(publicId)}/retire`, {
    actAs,
    body: { ...body, source: "cli" },
  })
}

export * as ReviewApi from "./review-api"

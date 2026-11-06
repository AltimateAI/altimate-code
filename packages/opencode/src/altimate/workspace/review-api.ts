// altimate_change - new file
//
// Wire client for workspace review in altimate-backend (`/datamates/{id}/reviews*`): a member submits their own skill or
// knowledge base to a workspace, and the owner approves or rejects it in the web app. The CLI only submits and reads
// status; it never approves or rejects.
//
// Errors are classified by the rules client's `classify` (one mapping for both features): a 404 `reviews_not_available`
// or a 404 with no code (a server without these routes) is `unsupported`; a 401, or a 403 with no code, is `auth`, never
// a decision about the request; a coded 409 is `conflict`.
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
  status: z.enum(["pending", "active", "rejected", "superseded"]),
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
})
export type Contribution = z.infer<typeof Contribution>

export const SubmitResult = z.object({
  status: z.enum(["active", "pending"]),
  attached_directly: z.boolean(),
  duplicate: z.boolean(),
  contribution: Contribution.nullable(),
})
export type SubmitResult = z.infer<typeof SubmitResult>

const Page = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().nullable().optional(),
  page: z.number().int().nullable().optional(),
  pages: z.number().int().nullable().optional(),
})

/** One request; any failure (transport, status, or a body that does not parse) is a classified `RulesApiError`. */
async function call<T>(schema: z.ZodType<T>, method: string, datamateId: number, subpath: string, opts: { actAs?: ActAs; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  try {
    const raw = await altimateRequest<unknown>(method, `/${datamateId}/reviews${subpath}`, {
      base: "/datamates",
      ...(opts.actAs ? { actAs: opts.actAs } : {}),
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
export function summary(datamateId: number, actAs?: ActAs): Promise<Summary> {
  return call(Summary, "GET", datamateId, "/summary", { actAs })
}

/** Submit the caller's own skill or knowledge base to the workspace. The owner's is attached directly. */
export function submit(datamateId: number, body: { kind: "skill" | "knowledge"; subject_id: string }, actAs?: ActAs): Promise<SubmitResult> {
  return call(SubmitResult, "POST", datamateId, "", { actAs, body })
}

/** The caller's own submissions to the workspace, newest first, every page up to `MAX_PAGES`. A row this version cannot
 * read is skipped and counted. `complete` is false when the list was cut at the page cap. */
export async function listMine(datamateId: number, actAs?: ActAs): Promise<{ items: Contribution[]; skipped: number; complete: boolean }> {
  const items: Contribution[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await call(Page, "GET", datamateId, "", {
      actAs,
      query: { view: "mine", page: String(page), size: String(PAGE_SIZE) },
    })
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
    const pages = body.pages ?? 1
    if (page >= pages || body.items.length === 0) return { items, skipped, complete: true }
  }
  return { items, skipped, complete: false }
}

export * as ReviewApi from "./review-api"

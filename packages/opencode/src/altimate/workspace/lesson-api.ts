// altimate_change - new file
//
// Wire client for the learned-lesson routes in altimate-backend
// (`/datamates/{datamate_id}/lessons/*`). `learn/sync.ts` is the only caller.
//
// Every call takes the credential captured for one sync scope (`ActAs`), never the ambient one:
// lessons, proposals and usage are per tenant and per account, and an account switch part-way
// through a pull or a push must not send one account's data with another's key.
//
// Responses are parsed with zod rather than cast. A malformed body is a contract break and fails
// the call; the caller treats it like any other failure and keeps its cache.
import z from "zod"
import { altimateRequest, ForbiddenError, NotFoundError, WorkspaceApiError, type ActAs } from "./api-client"

const LESSON_KEY = /^L-[0-9a-f]{4,32}$/
const Key = z.string().regex(LESSON_KEY)
const BATCH_TIMEOUT_MS = 30_000

export const CoexistsRef = z.object({
  lesson_key: Key,
  source_text_hash: z.string(),
  target_text_hash: z.string(),
})
export type CoexistsRef = z.infer<typeof CoexistsRef>

export const TargetRef = z.object({ public_id: z.string(), version: z.number().int() })
export type TargetRef = z.infer<typeof TargetRef>

export const LessonOut = z.object({
  public_id: z.string(),
  lesson_key: Key,
  repo_identity: z.string().nullable(),
  store: z.string(),
  text: z.string(),
  tags: z.array(z.string()).default([]),
  trigger_paths: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  /** Projected server-side: keys of lessons that are live and whose text is unchanged since compatibility was declared. */
  coexists: z.array(z.string()).default([]),
  helpful: z.number().int().nonnegative().default(0),
  harmful: z.number().int().nonnegative().default(0),
  applied: z.number().int().nonnegative().default(0),
  version: z.number().int(),
  updated_at: z.string(),
})
export type LessonOut = z.infer<typeof LessonOut>

export const Tombstone = z.object({ repo_identity: z.string().nullable(), store: z.string(), lesson_key: Key })
export type Tombstone = z.infer<typeof Tombstone>

export const SyncResponse = z.object({
  unchanged: z.boolean().default(false),
  revision: z.number().int(),
  repo_identity: z.string(),
  share_lessons_across_repos: z.boolean().default(false),
  pending_count: z.number().int().nonnegative().default(0),
  lessons: z.array(LessonOut).default([]),
  tombstones: z.array(Tombstone).default([]),
})
export type SyncResponse = z.infer<typeof SyncResponse>

export const Submission = z.object({
  public_id: z.string(),
  lesson_key: Key,
  repo_identity: z.string().nullable(),
  store: z.string(),
  status: z.string(),
  version: z.number().int(),
  submission_hash: z.string(),
  content_hash: z.string().nullable().optional(),
  status_reason: z.string().nullable().optional(),
  updated_at: z.string(),
})
export type Submission = z.infer<typeof Submission>

export const ORIGINS = ["manual", "auto_reflect", "auto_promote", "bootstrap", "import_reviews", "backfill", "ui"] as const
export type Origin = (typeof ORIGINS)[number]

export const BatchItem = z.object({
  lesson_key: Key,
  change_type: z.enum(["add", "edit", "remove"]),
  text: z.string(),
  tags: z.array(z.string()),
  trigger_paths: z.array(z.string()),
  coexists: z.array(CoexistsRef),
  pinned: z.boolean(),
  provenance: z.string().nullable(),
  origin: z.enum(ORIGINS),
  replaces: z.array(TargetRef),
  revises_public_id: z.string().nullable(),
  revises_version: z.number().int().nullable(),
})
export type BatchItem = z.infer<typeof BatchItem>

export const BatchResult = z.object({
  lesson_key: z.string(),
  submission_hash: z.string().nullable().optional(),
  public_id: z.string().nullable().optional(),
  version: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  duplicate: z.boolean().default(false),
  error_code: z.string().nullable().optional(),
  error_detail: z.string().nullable().optional(),
  existing: TargetRef.nullable().optional(),
})
export type BatchResult = z.infer<typeof BatchResult>
const BatchResponse = z.object({ results: z.array(BatchResult) })

export const UsageItem = z.object({
  public_id: z.string(),
  applied: z.number().int().min(0).max(50),
  helpful: z.number().int().min(0).max(50),
  harmful: z.number().int().min(0).max(50),
})
export type UsageItem = z.infer<typeof UsageItem>
const UsageResponse = z.object({ duplicate: z.boolean().default(false), applied_items: z.number().int().default(0) })

export const MAX_BATCH_ITEMS = 100
export const MAX_USAGE_ITEMS = 500
export const MAX_LOCAL_KEYS = 1000

/** How a failed call should be treated. Only `transient` keeps a cache and retries later as if nothing happened. */
export type FailureKind =
  /** The server has no lesson routes (an older backend): FastAPI's bare 404. */
  | "unsupported"
  /** The workspace is gone or no longer visible: invalidate everything cached for it. */
  | "workspace_not_found"
  | "forbidden"
  /** This repository is not bound to the workspace (any more). */
  | "repo_not_bound"
  /** The usage batch id was reused with a different payload. */
  | "batch_conflict"
  | "transient"
  | "rejected"

export class LessonApiError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "LessonApiError"
  }
}

const code = (detail: Record<string, unknown> | undefined) => (typeof detail?.code === "string" ? detail.code : undefined)

/** Map api-client's typed errors onto what sync does about them. */
export function classify(error: unknown): LessonApiError {
  if (error instanceof LessonApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NotFoundError) {
    // The contract's 404 always carries a code; a route that does not exist answers a bare string.
    if (code(error.detail) === "workspace_not_found") return new LessonApiError("workspace_not_found", message, 404)
    return new LessonApiError(error.detail ? "rejected" : "unsupported", message, 404)
  }
  if (error instanceof ForbiddenError) return new LessonApiError("forbidden", message, 403)
  if (error instanceof WorkspaceApiError) {
    const kind = code(error.detail)
    if (kind === "repo_not_bound") return new LessonApiError("repo_not_bound", message, error.status)
    if (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500)
      return new LessonApiError("transient", message, error.status)
    return new LessonApiError("rejected", message, error.status)
  }
  const name = (error as { name?: string } | undefined)?.name
  if (name === "ConflictError") {
    const detail = (error as { detail?: Record<string, unknown> }).detail
    return new LessonApiError(code(detail) === "batch_conflict" ? "batch_conflict" : "rejected", message, 409)
  }
  // zod parse failures and anything unexpected: not retried blindly, but never fatal to a run.
  return new LessonApiError(name === "ZodError" ? "rejected" : "transient", message)
}

async function call<T>(schema: z.ZodType<T>, actAs: ActAs, method: string, datamateId: number, subpath: string, opts: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  try {
    const raw = await altimateRequest<unknown>(method, subpath, {
      base: `/datamates/${datamateId}/lessons`,
      actAs,
      body: opts.body,
      query: opts.query,
      timeoutMs: opts.timeoutMs,
      boundResponse: true,
    })
    return schema.parse(raw)
  } catch (error) {
    throw classify(error)
  }
}

export namespace LessonApi {
  /** Session pull: approved lessons in scope, tombstones for the keys sent, and the caller's queue size. */
  export function sync(actAs: ActAs, datamateId: number, body: { repo_remote: string; store: string; known_revision?: number; local_keys: string[] }) {
    return call(SyncResponse, actAs, "POST", datamateId, "/sync", { body })
  }

  /** The caller's own proposals, so the ledger sees owner edits, approvals and rejections. */
  export function submissions(actAs: ActAs, datamateId: number, since?: string) {
    return call(z.array(Submission), actAs, "GET", datamateId, "/submissions", since ? { query: { since } } : {})
  }

  export async function batch(actAs: ActAs, datamateId: number, body: { repo_remote: string; store: string; items: BatchItem[] }) {
    return (await call(BatchResponse, actAs, "POST", datamateId, "/batch", { body, timeoutMs: BATCH_TIMEOUT_MS })).results
  }

  export function usage(actAs: ActAs, datamateId: number, body: { batch_id: string; items: UsageItem[] }) {
    return call(UsageResponse, actAs, "POST", datamateId, "/usage", { body })
  }
}

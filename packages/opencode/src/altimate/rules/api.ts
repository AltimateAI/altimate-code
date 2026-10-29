// altimate_change - new file
//
// Wire client for the workspace rules routes in altimate-backend (`/datamates/{id}/rules/*`).
//
// Every call takes the credential captured for one scope (`ActAs`), never the ambient one: rules,
// proposals and usage are per tenant and account, and an account switch part-way through a pull must
// not send one account's data with another's key. Responses are parsed with zod; a malformed body fails the
// call as `transient` (the server may already have applied it, so the client keeps what it sent and retries).
// Pulled rules are parsed one by one: an invalid rule is skipped, not a reason to freeze every rule.
import z from "zod"
import { altimateRequest, ForbiddenError, NotFoundError, WorkspaceApiError, type ActAs } from "../workspace/api-client"

export const Settings = z.object({
  learning_enabled: z.boolean(),
  include_quotes: z.boolean(),
  share_across_repos: z.boolean(),
})
export type Settings = z.infer<typeof Settings>

export const RuleOut = z.object({
  public_id: z.string(),
  rule_key: z.string().regex(/^R-[0-9a-f]{12}$/),
  repo_identity: z.string().nullable().optional(),
  text: z.string(),
  applies_to: z.array(z.string()),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  version: z.number().int(),
  updated_at: z.string(),
})
export type RuleOut = z.infer<typeof RuleOut>

export const Reviewed = z.object({
  public_id: z.string(),
  rule_key: z.string(),
  text: z.string(),
  change: z.string(),
  status: z.string(),
  review_reason: z.string().nullable().optional(),
  reviewed_by_name: z.string().nullable().optional(),
  reviewed_at: z.string().nullable().optional(),
  updated_at: z.string(),
})
export type Reviewed = z.infer<typeof Reviewed>

export const SyncResponse = z.object({
  unchanged: z.boolean(),
  revision: z.number().int(),
  repo_identity: z.string(),
  workspace_name: z.string(),
  owner_name: z.string().nullable().optional(),
  is_owner: z.boolean(),
  settings: Settings,
  pending_count: z.number().int(),
  // Each rule is validated on its own in `sync` below.
  rules: z.array(z.unknown()),
  my_reviewed: z.array(Reviewed),
  cursor: z.string(),
})
export type SyncResponse = Omit<z.infer<typeof SyncResponse>, "rules"> & { rules: RuleOut[]; skipped: number }

export const ORIGINS = ["session", "explicit", "bootstrap", "import_reviews"] as const
export type Origin = (typeof ORIGINS)[number]

export interface ProposalItem {
  change: "add" | "edit" | "retire"
  text: string
  applies_to: string[]
  why?: string
  origin: Origin
  replaces?: string
  replaces_version?: number
  evidence_sessions: number
  corrections: { excerpt: string; corrected_at: string; session_ref?: string }[]
}

export const ProposalResult = z.object({
  index: z.number().int(),
  status: z.string(),
  public_id: z.string().nullable().optional(),
  rule_key: z.string().nullable().optional(),
  version: z.number().int().nullable().optional(),
  duplicate: z.boolean().default(false),
  weakens_verification: z.boolean().default(false),
  verification_reason: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_detail: z.string().nullable().optional(),
})
export type ProposalResult = z.infer<typeof ProposalResult>

export const RuleDetail = z.object({ public_id: z.string(), status: z.string(), version: z.number().int() }).passthrough()

export interface UsageItem {
  public_id: string
  applied: number
  helpful: number
  harmful: number
  corrected_again: number
}

export type FailureKind =
  /** The server has no rules routes, or the tenant is not migrated yet. */
  | "unsupported"
  /** The workspace is gone or no longer visible. */
  | "workspace_not_found"
  | "forbidden"
  /** This repository is not linked to the workspace (any more). */
  | "repo_not_bound"
  /** A review refused for a coded reason (verification_flagged, target_changed, version_conflict...). */
  | "conflict"
  /** The credential was refused (expired or revoked key): nothing is wrong with what was sent. */
  | "auth"
  | "transient"
  /** The server refused this request's content (400/422 with a code): sending it again cannot succeed. */
  | "rejected"

export class RulesApiError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "RulesApiError"
  }
}

const codeOf = (detail: Record<string, unknown> | undefined) => (typeof detail?.code === "string" ? detail.code : undefined)
const messageOf = (detail: Record<string, unknown> | undefined, fallback: string) =>
  typeof detail?.message === "string" ? detail.message : fallback

/** Map api-client's typed errors onto what callers do about them. */
export function classify(error: unknown): RulesApiError {
  if (error instanceof RulesApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NotFoundError) {
    const code = codeOf(error.detail)
    if (code === "workspace_not_found") return new RulesApiError("workspace_not_found", messageOf(error.detail, message), code, 404)
    if (code === "rules_not_available" || !error.detail) return new RulesApiError("unsupported", messageOf(error.detail, message), code, 404)
    return new RulesApiError("rejected", messageOf(error.detail, message), code, 404)
  }
  if (error instanceof ForbiddenError) {
    const code = codeOf(error.detail)
    // A 403 with no code is the credential, not a decision about this workspace.
    return code ? new RulesApiError("forbidden", messageOf(error.detail, message), code, 403) : new RulesApiError("auth", message, undefined, 403)
  }
  if (error instanceof WorkspaceApiError) {
    const code = codeOf(error.detail)
    if (code === "repo_not_bound") return new RulesApiError("repo_not_bound", messageOf(error.detail, message), code, error.status)
    if (error.status === 401 || error.status === 407) return new RulesApiError("auth", message, code, error.status)
    // Only a coded 400/422 is about the request's content; anything else (a proxy 413, an uncoded 400) is kept.
    if ((error.status === 400 || error.status === 422) && code) return new RulesApiError("rejected", messageOf(error.detail, message), code, error.status)
    return new RulesApiError("transient", message, code, error.status)
  }
  const named = error as { name?: string; detail?: Record<string, unknown> } | undefined
  if (named?.name === "ConflictError") return new RulesApiError("conflict", messageOf(named.detail, message), codeOf(named.detail), 409)
  if (named?.name === "PreconditionFailedError") return new RulesApiError("conflict", messageOf(named.detail, message), codeOf(named.detail), 412)
  return new RulesApiError("transient", message)
}

async function call<T>(schema: z.ZodType<T>, actAs: ActAs, method: string, datamateId: number, subpath: string, body?: unknown): Promise<T> {
  try {
    const raw = await altimateRequest<unknown>(method, subpath, { base: `/datamates/${datamateId}/rules`, actAs, body })
    return schema.parse(raw)
  } catch (error) {
    throw classify(error)
  }
}

export async function sync(actAs: ActAs, datamateId: number, body: { repo_remote: string; known_revision?: number; reviewed_since?: string }): Promise<SyncResponse> {
  const raw = await call(SyncResponse, actAs, "POST", datamateId, "/sync", body)
  const rules = raw.rules.flatMap((rule) => {
    const parsed = RuleOut.safeParse(rule)
    return parsed.success ? [parsed.data] : []
  })
  return { ...raw, rules, skipped: raw.rules.length - rules.length }
}

export async function propose(actAs: ActAs, datamateId: number, body: { repo_remote: string; items: ProposalItem[] }) {
  return (await call(z.object({ results: z.array(ProposalResult) }), actAs, "POST", datamateId, "/proposals", body)).results
}

/** Owner only: "Approve now" from the card. */
export function review(actAs: ActAs, datamateId: number, publicId: string, body: { action: "approve" | "approve_anyway" | "reject"; expected_version: number; reason?: string }) {
  return call(RuleDetail, actAs, "POST", datamateId, `/${encodeURIComponent(publicId)}/review`, { ...body, source: "cli" })
}

export function usage(actAs: ActAs, datamateId: number, body: { batch_id: string; items: UsageItem[] }) {
  return call(z.object({ duplicate: z.boolean(), applied_items: z.number(), skipped_items: z.number() }), actAs, "POST", datamateId, "/usage", body)
}

export * as RulesApi from "./api"

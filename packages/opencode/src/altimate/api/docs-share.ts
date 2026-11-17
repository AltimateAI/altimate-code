import z from "zod"
import { AltimateApi } from "./client"

// The shared-docs comment endpoints of the Altimate backend. Shapes follow what the backend returns for
// a docs share: its threads ("conversation groups") and the messages in each.

export interface DocsShareMessage {
  conversation_id: number
  message: string
  timestamp: string
  user_id: number
}

export interface DocsShareRange {
  start: { line: number; character: number }
  end?: { line: number; character: number }
}

export interface DocsShareThread {
  conversation_group_id: number
  owner?: number
  /** "Pending" is open; "Resolved" is closed. */
  status: "Pending" | "Resolved"
  meta?: {
    field?: "description"
    column?: string
    highlight?: string
    uniqueId?: string
    filePath?: string
    resource_type?: string
    range?: DocsShareRange | null
  } | null
  conversations: DocsShareMessage[]
}

export interface DocsShare {
  share_id: number
  name?: string
  description?: string
  project_name?: string
  conversation_group: DocsShareThread[]
}

export interface DocsShareUser {
  id: number
  display_name?: string
  first_name?: string
  last_name?: string
  email?: string
}

// What a share and its threads must carry for the tool to read them: an answer without these is an
// error, so a changed or broken response is never shown as "no open comments".
const Range = z.object({
  start: z.object({ line: z.number(), character: z.number() }),
  end: z.object({ line: z.number(), character: z.number() }).optional(),
})
const SharesAnswer = z.array(
  z.object({
    share_id: z.number(),
    name: z.string().nullish(),
    project_name: z.string().nullish(),
    conversation_group: z.array(
      z.object({
        conversation_group_id: z.number(),
        // The backend's status is a closed set: a value outside it is an error, never "no open threads".
        status: z.enum(["Pending", "Resolved"]),
        // A range that is partial (the editor extension can store one without a start) drops the
        // line of the thread, never the thread or the list.
        meta: z.object({ range: Range.nullish().catch(undefined) }).passthrough().nullish(),
        conversations: z.array(
          z.object({ conversation_id: z.number(), message: z.string(), timestamp: z.string(), user_id: z.number() }),
        ),
      }),
    ),
  }),
)

/** The shares of the given dbt projects, each with its comment threads. */
export async function listSharedDocs(projects: string[], signal?: AbortSignal): Promise<DocsShare[]> {
  const params = new URLSearchParams()
  for (const project of projects) params.append("projects", project)
  const shares = await AltimateApi.apiRequest("GET", `/dbt/dbt_docs_share/all?${params.toString()}`, undefined, signal)
  // A paginated answer wraps the shares in `items`; a bare array is accepted too.
  const list = shares && !Array.isArray(shares) && Array.isArray(shares.items) ? shares.items : shares
  const parsed = SharesAnswer.safeParse(list)
  if (!parsed.success) throw new Error("The shared docs service returned an unexpected answer for the shares.")
  return parsed.data as DocsShare[]
}

/** The people in the tenant, for naming who wrote each message. */
export async function listTenantUsers(signal?: AbortSignal): Promise<DocsShareUser[]> {
  const users = await AltimateApi.apiRequest("GET", "/users/chat", undefined, signal)
  return Array.isArray(users) ? users : []
}

export async function replyToThread(shareId: number, groupId: number, message: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return AltimateApi.apiRequest("POST", `/dbt/dbt_docs_share/${shareId}/conversation_group/${groupId}/conversation`, { message }, signal)
}

export async function resolveThread(shareId: number, groupId: number, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return AltimateApi.apiRequest("POST", `/dbt/dbt_docs_share/${shareId}/conversation_group/${groupId}/resolve`, { resolved: true }, signal)
}

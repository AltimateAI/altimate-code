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
  end: { line: number; character: number }
}

export interface DocsShareThread {
  conversation_group_id: number
  owner: number
  status: "Pending" | "Resolved"
  meta: {
    field?: "description"
    column?: string
    highlight?: string
    uniqueId?: string
    filePath?: string
    resource_type?: string
    range?: DocsShareRange
  }
  conversations: DocsShareMessage[]
}

export interface DocsShare {
  share_id: number
  name: string
  description?: string
  project_name: string
  conversation_group: DocsShareThread[]
}

export interface DocsShareUser {
  id: number
  display_name?: string
  first_name?: string
  last_name?: string
  email?: string
}

/** The shares of the given dbt projects, each with its comment threads. */
export async function listSharedDocs(projects: string[]): Promise<DocsShare[]> {
  const params = new URLSearchParams()
  for (const project of projects) params.append("projects", project)
  const shares = await AltimateApi.apiRequest("GET", `/dbt/dbt_docs_share/all?${params.toString()}`)
  return Array.isArray(shares) ? shares : []
}

/** The people in the tenant, for naming who wrote each message. */
export async function listTenantUsers(): Promise<DocsShareUser[]> {
  const users = await AltimateApi.apiRequest("GET", "/users/chat")
  return Array.isArray(users) ? users : []
}

export async function replyToThread(shareId: number, groupId: number, message: string): Promise<{ ok: boolean }> {
  return AltimateApi.apiRequest("POST", `/dbt/dbt_docs_share/${shareId}/conversation_group/${groupId}/conversation`, {
    message,
  })
}

export async function resolveThread(shareId: number, groupId: number): Promise<{ ok: boolean }> {
  return AltimateApi.apiRequest("POST", `/dbt/dbt_docs_share/${shareId}/conversation_group/${groupId}/resolve`, {
    resolved: true,
  })
}

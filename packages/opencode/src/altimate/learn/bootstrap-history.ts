// altimate_change - new file
// Bounded, internal history readers for bootstrap. Session.list has no keyset cursor,
// and MessageV2.stream walks backwards; neither can provide this chronological pass.
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, asc, desc, eq, gt, gte, isNull, lt, or } from "drizzle-orm"
import { Database } from "@/storage/db"
import { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

export interface HistoryCursor {
  created: number
  id: string
}

export interface HistorySession {
  id: string
  projectID: string
  directory: string
  time: { created: number; updated: number }
}

interface Scope {
  projectID: string
  directory: string
}

const sessionFields = {
  id: SessionTable.id,
  projectID: SessionTable.project_id,
  directory: SessionTable.directory,
  created: SessionTable.time_created,
  updated: SessionTable.time_updated,
  metadata: SessionTable.metadata,
}

function scope(input: Scope) {
  return and(
    eq(SessionTable.project_id, ProjectV2.ID.make(input.projectID)),
    eq(SessionTable.directory, input.directory),
    isNull(SessionTable.parent_id),
  )
}

function eligible(metadata: Record<string, unknown> | null): boolean {
  // The session schema has no dedicated privacy/import-origin flags. Honor explicit
  // metadata markers if a client supplies them. share_url describes outgoing shares
  // and does not establish that a session was imported from elsewhere.
  return metadata?.private !== true && metadata?.visibility !== "private" && !metadata?.sharedFrom
}

function fromRow(row: {
  id: string
  projectID: string
  directory: string
  created: number
  updated: number
}): HistorySession {
  return {
    id: row.id,
    projectID: row.projectID,
    directory: row.directory,
    time: { created: row.created, updated: row.updated },
  }
}

/** Lookup for resumed reflections, with the same project/root/privacy scope as traversal. */
export function historySession(input: Scope & { sessionID: string }): HistorySession | undefined {
  const row = Database.use((db) => db.select(sessionFields).from(SessionTable)
    .where(and(scope(input), eq(SessionTable.id, SessionID.make(input.sessionID)))).get())
  return row && eligible(row.metadata) ? fromRow(row) : undefined
}

/** Newest-first creation order; each SQL read is capped and ties use the session id. */
export function* historySessions(input: Scope & {
  since: number
  limit: number
  before?: HistoryCursor
  pageSize?: number
}): Generator<HistorySession> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new Error("Session limit must be a non-negative integer.")
  const size = pageSize(input.pageSize)
  let before = input.before
  let remaining = input.limit
  while (remaining > 0) {
    const limit = Math.min(size, remaining)
    const rows = Database.use((db) => db.select(sessionFields).from(SessionTable).where(and(
      scope(input),
      gte(SessionTable.time_created, input.since),
      before ? or(
        lt(SessionTable.time_created, before.created),
        and(eq(SessionTable.time_created, before.created), lt(SessionTable.id, SessionID.make(before.id))),
      ) : undefined,
    )).orderBy(desc(SessionTable.time_created), desc(SessionTable.id)).limit(limit).all())
    if (rows.length === 0) return
    for (const row of rows) {
      before = { created: row.created, id: row.id }
      if (!eligible(row.metadata)) continue
      remaining--
      yield fromRow(row)
    }
    if (rows.length < limit) return
  }
}

function pageSize(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("History page size must be a positive integer.")
  return Math.min(value, 100)
}

/** Oldest-first messages, retaining at most one page of message records and one message's parts. */
export function* historyMessages(sessionID: string, size = 50): Generator<MessageV2.WithParts> {
  const limit = pageSize(size)
  const sid = SessionID.make(sessionID)
  let after: HistoryCursor | undefined
  while (true) {
    const rows = Database.use((db) => db.select().from(MessageTable).where(and(
      eq(MessageTable.session_id, sid),
      after ? or(
        gt(MessageTable.time_created, after.created),
        and(eq(MessageTable.time_created, after.created), gt(MessageTable.id, MessageID.make(after.id))),
      ) : undefined,
    )).orderBy(asc(MessageTable.time_created), asc(MessageTable.id)).limit(limit).all())
    if (rows.length === 0) return
    for (const row of rows) {
      const parts = Database.use((db) => db.select().from(PartTable)
        .where(and(eq(PartTable.message_id, row.id), eq(PartTable.session_id, sid)))
        .orderBy(asc(PartTable.id)).all())
      after = { created: row.time_created, id: row.id }
      yield {
        info: { ...row.data, id: row.id, sessionID: row.session_id } as unknown as MessageV2.Info,
        parts: parts.map((part) => ({
          ...part.data, id: part.id, messageID: part.message_id, sessionID: part.session_id,
        })) as MessageV2.Part[],
      }
    }
    if (rows.length < limit) return
  }
}

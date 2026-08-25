// altimate_change - new file
//
// Wire client for the memory routes in altimate-backend (/datamates/memory/*).
// Those routes proxy to a Lambda which runs an LLM extractor before storing, so
// the behaviour here is shaped by two facts established against the live
// service rather than inferred:
//
//   * A create runs the extractor. It rewrites the submitted text and
//     overwrites the ``memory_type`` and ``title`` metadata keys, and it can
//     decline the content entirely and store nothing while still answering 200.
//     ``update`` does NOT run the extractor — it writes text and metadata
//     verbatim. Every create is therefore followed by an update that restores
//     the block exactly as the user wrote it.
//   * ``extracted`` is not a stored/not-stored signal. It is false both when
//     the extractor declined (no ``result``) and when the extractor errored and
//     the raw messages were stored as a fallback (``result`` present, content
//     stored). Presence of ``result`` is the only reliable signal, which is why
//     ``add`` reports an id rather than a boolean.
//
// Records are tagged with ``metadata.source`` so the backend can keep them out
// of ordinary Datamate reads; this client opts back in explicitly on every read.
import { altimateRequest } from "./api-client"

/** Stamped on every record this CLI writes, and the value the backend filters
 * on. Reads must opt in by name or they come back empty. */
export const MIRROR_SOURCE = "altimate-code"

const BASE = "/datamates/memory"

/** Upper bound on records requested per read. The service does not honour
 * paging parameters — a repeated request re-runs the identical query — so this
 * is a single bounded fetch rather than the first page of several. */
export const LIST_LIMIT = 200

/** A record as returned by ``/list``. */
export interface CloudMemoryRecord {
  id: string
  memory: string
  created_at?: string
  updated_at?: string
  metadata?: Record<string, unknown> | null
}

/** Metadata written on every mirrored record. Names and types are fixed so
 * that lookup and filtering agree across independent call sites. */
export interface MirrorMetadata {
  source: typeof MIRROR_SOURCE
  block_id: string
  block_scope: "global" | "project"
  /** Always "private" in v0. Written so a later sharing feature can promote a
   * record without a backfill; nothing reads it today. */
  visibility: "private"
  block_created: string
  block_updated: string
  /** Absent for global blocks — that is what makes them span workspaces. */
  datamate_id?: string
  datamate_name?: string
  /** Project provenance and the cross-machine convergence key. */
  repo_remote?: string
  project_path?: string
  block_tags?: string
  /** ISO-8601. Mirrored so a TTL'd block expires everywhere rather than living
   * forever in the workspace once it has left the machine that wrote it. */
  block_expires?: string
  archived?: "true"
  archived_at?: string
}

export function isMirrorRecord(record: CloudMemoryRecord): boolean {
  const meta = record.metadata
  if (!meta || typeof meta !== "object") return false
  return meta.source === MIRROR_SOURCE
}

export function isArchived(record: CloudMemoryRecord): boolean {
  return record.metadata?.archived === "true"
}

/** Pull every created record id out of a create response.
 *
 * A create runs an extractor server-side, and an extractor is free to split one
 * submission into several records — each carrying the metadata we sent, so each
 * looks like our block. Returning only the first would leave the rest holding
 * rewritten text, never repaired, never indexed and never archived, while the
 * read path injected all of them under one block id.
 *
 * The payload shape is not a published contract, so this accepts the observed
 * forms rather than guessing: a bare array, or an object wrapping one under
 * ``results``/``memories``/``data``. An empty result is the expected outcome
 * when the extractor declines the content. */
export function extractRecordIds(result: unknown): string[] {
  const rows = (() => {
    if (Array.isArray(result)) return result
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>
      for (const key of ["results", "memories", "data"]) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[]
      }
    }
    return []
  })()

  const ids: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const id = (row as Record<string, unknown>).id ?? (row as Record<string, unknown>).memory_id
    if (typeof id === "string" && id) ids.push(id)
  }
  return ids
}

/** Convenience for callers that only need to know whether anything was stored. */
export function extractRecordId(result: unknown): string | undefined {
  return extractRecordIds(result)[0]
}

export namespace MemoryApi {
  /** Create a record and report the ids it produced.
   *
   * Returns an empty array when the service stored nothing. That is not an error —
   * the extractor declines content it judges unremarkable — so the caller
   * should leave the block unindexed and let a later edit retry, rather than
   * treating it as a failure. */
  export async function add(content: string, metadata: MirrorMetadata): Promise<string[]> {
    const res = await altimateRequest<{ message?: string; result?: unknown }>("POST", "/", {
      base: BASE,
      allowEmptyBody: true,
      body: {
        messages: [{ role: "user", content }],
        memory_options: { metadata },
      },
    })
    return extractRecordIds(res?.result)
  }

  /** Overwrite a record verbatim. Does not run the extractor, and replaces the
   * metadata dict wholesale, so callers must pass the complete metadata. */
  export async function update(
    memoryId: string,
    content: string,
    metadata: MirrorMetadata,
  ): Promise<void> {
    await altimateRequest<{ message?: string }>("PATCH", `/${encodeURIComponent(memoryId)}`, {
      base: BASE,
      allowEmptyBody: true,
      body: { memory: content, metadata },
    })
  }

  /** Read this user's mirrored records.
   *
   * ``include_sources`` is required: the backend excludes this client's records
   * from list/search by default so they do not surface in Datamate sessions.
   * No workspace filter is sent — the service's own query for a caller's
   * records is not scoped by workspace, so narrowing happens in the caller.
   *
   * Deliberately NOT capped at ``LIST_LIMIT``. The service ignores paging, so a
   * cap here would discard real records before anything could rank them, and
   * the user would lose memory with no signal. Session context is already
   * bounded downstream: ``MemoryPrompt.inject`` scores every block and appends
   * only while it fits the caller's budget. ``LIST_LIMIT`` is used to recognise
   * a possibly-cut-short read (see ``fetchKnownRecords``), not to trim one. */
  export async function list(): Promise<CloudMemoryRecord[]> {
    const rows = await altimateRequest<CloudMemoryRecord[] | { memories?: CloudMemoryRecord[] }>(
      "GET",
      "/list",
      {
        base: BASE,
        allowEmptyBody: true,
        query: { include_sources: MIRROR_SOURCE, page_size: String(LIST_LIMIT) },
      },
    )
    if (!rows) return []
    if (Array.isArray(rows)) return rows
    return Array.isArray(rows.memories) ? rows.memories : []
  }
}

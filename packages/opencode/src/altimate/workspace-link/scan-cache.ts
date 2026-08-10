// altimate_change — WorkspaceLink feature. Read/write helpers for the
// `workspace_link_scan_cache` table (packages/core/src/workspace-link/scan-cache.sql.ts),
// CONTRACT.md §3 "light local persistence". One row per project, overwritten on every scan,
// with a short TTL so stale detection results don't silently feed a workspace creation much
// later.
import { eq, sql } from "drizzle-orm"
import { WorkspaceLinkScanCacheTable } from "@opencode-ai/core/workspace-link/scan-cache.sql"
import { Database } from "@/storage/db"

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour, per CONTRACT.md §3

// altimate_change start — POC scope: the formal migration
// (packages/core/src/database/migration/20260805093202_workspace_link_scan_cache.ts) is written
// but deliberately NOT registered in migration.gen.ts/schema.gen.ts for this proof-of-concept —
// regenerating those repo-wide files is out of scope (see the POC rules in the conversation this
// shipped from). So this module creates its own table directly, matching the migration's DDL
// exactly, the first time it's touched. Before this feature ships for real, drop this and rely
// on the registered migration instead.
let tableEnsured = false
function ensureTable(db: Database.TxOrDb) {
  if (tableEnsured) return
  db.run(sql`
    CREATE TABLE IF NOT EXISTS workspace_link_scan_cache (
      project_id text PRIMARY KEY,
      name text,
      adapter text,
      model_count integer,
      source_count integer,
      test_count integer,
      git_remote text,
      git_branch text,
      has_warehouse integer NOT NULL,
      scanned_at integer NOT NULL,
      expires_at integer NOT NULL
    )
  `)
  tableEnsured = true
}
// altimate_change end

export interface ScanCacheInput {
  name: string | null
  adapter: string | null
  modelCount: number | null
  sourceCount: number | null
  testCount: number | null
  gitRemote: string | null
  gitBranch: string | null
  hasWarehouse: boolean
}

export interface ScanCacheRow extends ScanCacheInput {
  projectId: string
  scannedAt: number
  expiresAt: number
}

function fromRow(row: typeof WorkspaceLinkScanCacheTable.$inferSelect): ScanCacheRow {
  return {
    projectId: row.project_id,
    name: row.name,
    adapter: row.adapter,
    modelCount: row.model_count,
    sourceCount: row.source_count,
    testCount: row.test_count,
    gitRemote: row.git_remote,
    gitBranch: row.git_branch,
    hasWarehouse: row.has_warehouse,
    scannedAt: row.scanned_at,
    expiresAt: row.expires_at,
  }
}

/** Upsert the scan-cache row for `projectId`. Called once, at the same `tool.execute.after`
 * interception point already used for onboarding telemetry (onboarding-telemetry.ts). */
export function writeScanCache(projectId: string, input: ScanCacheInput, ttlMs = DEFAULT_TTL_MS): void {
  const now = Date.now()
  const values = {
    project_id: projectId,
    name: input.name,
    adapter: input.adapter,
    model_count: input.modelCount,
    source_count: input.sourceCount,
    test_count: input.testCount,
    git_remote: input.gitRemote,
    git_branch: input.gitBranch,
    has_warehouse: input.hasWarehouse,
    scanned_at: now,
    expires_at: now + ttlMs,
  }
  Database.use((db) => {
    ensureTable(db)
    return db
      .insert(WorkspaceLinkScanCacheTable)
      .values(values)
      .onConflictDoUpdate({ target: WorkspaceLinkScanCacheTable.project_id, set: values })
      .run()
  })
}

/** Read the scan-cache row for `projectId`, or `undefined` if there is none or it has expired
 * (per CONTRACT.md §2's TTL semantics — treated the same as "no cache" by every caller here;
 * this table has no server-side security implications, so there is no need to distinguish
 * "expired" from "absent" the way the WorkspaceLink poll endpoint must). */
export function readFreshScanCache(projectId: string): ScanCacheRow | undefined {
  const row = Database.use((db) => {
    ensureTable(db)
    return db
      .select()
      .from(WorkspaceLinkScanCacheTable)
      .where(eq(WorkspaceLinkScanCacheTable.project_id, projectId))
      .get()
  })
  if (!row) return undefined
  if (row.expires_at < Date.now()) return undefined
  return fromRow(row)
}

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"

// altimate_change start — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §3).
//
// NOTE ON NAMING: this is deliberately "workspace_link_scan_cache", never bare
// "workspace_*" — `packages/core/src/control-plane/workspace.sql.ts` already owns the
// `workspace` table for an unrelated local git-worktree/session-routing concept (gated by
// `OPENCODE_EXPERIMENTAL_WORKSPACES`). This table is unrelated to that feature.
//
// Light local persistence for the (cheap, non-LLM) project detectors' output, so the Path B
// consent dialog and the on-demand `altimate link` command can build a workspace-link
// creation payload without re-running detection or waiting on the full `project_scan` tool.
// One row per project, overwritten on every scan; short TTL (`expires_at`, proposed 1 hour
// from `scanned_at`) so stale data doesn't silently feed a workspace creation much later.
export const WorkspaceLinkScanCacheTable = sqliteTable("workspace_link_scan_cache", {
  project_id: text()
    .notNull()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  // altimate_change — checkpoint 8k bug fix: the scan's own detected project name (dbt project
  // name, when found) was never persisted here, even though the scan computes it — the cached
  // branch of resolveHint() (handlers/workspace-link.ts) had nothing to read but
  // instance.project.name, which is usually unset, and silently fell through to link-service.ts's
  // last-resort "Workspace" default. See onboarding-telemetry.ts's offerWorkspaceLink for where
  // this gets written.
  name: text(),
  adapter: text(),
  model_count: integer(),
  source_count: integer(),
  test_count: integer(),
  git_remote: text(),
  git_branch: text(),
  has_warehouse: integer({ mode: "boolean" }).notNull(),
  scanned_at: integer().notNull(),
  expires_at: integer().notNull(),
})
// altimate_change end

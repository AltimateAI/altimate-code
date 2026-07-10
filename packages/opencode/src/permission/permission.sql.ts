// altimate_change start — restored fork PermissionTable.
// Upstream v1.17.9 moved permission storage into core with a per-resource row
// shape ({ id, project_id, action, resource }) at @opencode-ai/core/permission/sql.
// The fork's permission ruleset is still stored as a single JSON `data` column
// keyed by project_id, which is also what the deployed migration
// (migration/20260511173437_session-metadata) created. This table preserves that
// fork-specific shape so PermissionNext can read the approved ruleset unchanged.
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Timestamps } from "@opencode-ai/core/database/schema.sql"

// Mutable ruleset shape — PermissionNext mutates `state.approved` (.push), so the
// stored type must be a mutable array of rules (not core's readonly Ruleset).
type StoredRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<StoredRule[]>(),
})
// altimate_change end

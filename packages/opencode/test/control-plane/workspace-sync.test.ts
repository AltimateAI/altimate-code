// altimate_change — STALE DRAFT (v1.4.0 bridge). This file tested the old control-plane API
// (`Workspace.startSyncing`, `control-plane/adaptors.installAdaptor`, a local `control-plane/workspace.sql`
// module) that the v1.17.9 upstream merge replaced with `Workspace.Service` + drizzle + the core
// `@opencode-ai/core/control-plane/workspace.sql` table. None of the symbols it imported still exist,
// so it failed at module load. The replacement API is covered by `workspace.test.ts`.
// Skipped (not deleted) so the obsolete surface is visible and can be rewritten or removed deliberately.
// BUG: pending rewrite of workspace-sync coverage against the Effect Workspace.Service API.
import { describe, test } from "bun:test"

describe.skip("control-plane/workspace.startSyncing (stale v1.4.0 draft — superseded by workspace.test.ts)", () => {
  test.skip("rewrite against Workspace.Service sync API", () => {})
})

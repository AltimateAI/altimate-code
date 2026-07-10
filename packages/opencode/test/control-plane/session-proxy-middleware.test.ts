// altimate_change — STALE DRAFT (v1.4.0 bridge). This file tested the old session-proxy middleware
// against the removed control-plane API (`control-plane/adaptors`, the old `Adaptor` type, a local
// `control-plane/workspace.sql` module). The v1.17.9 merge replaced that surface with the Effect
// `Workspace.Service`, `WorkspaceAdapter.target()`, and the core `@opencode-ai/core/control-plane/workspace.sql`
// table, so every import here resolved to a deleted module and the file failed at load.
// Skipped (not deleted) so the obsolete surface stays visible and can be rewritten or removed deliberately.
// BUG: pending rewrite of session-proxy middleware coverage against the WorkspaceAdapter.target() API.
import { describe, test } from "bun:test"

describe.skip("control-plane/session-proxy-middleware (stale v1.4.0 draft — superseded by current router tests)", () => {
  test.skip("rewrite against WorkspaceAdapter.target() proxy path", () => {})
})

/**
 * Regression tests for sql_execute error surfacing (found by 2026-08-25
 * snowflake-setup live eval on account DKZPOBS-TQ14188).
 *
 * Bug: the dispatcher's `sql.execute` handler catches driver errors and
 * returns `{ columns: [], rows: [], row_count: 0, truncated: false,
 * error: <msg> }` instead of throwing. The tool's original code ignored
 * the `error` field and just ran `formatResult(result)`, which sees
 * `row_count === 0` and prints "(0 rows)" — making a real SQL failure
 * indistinguishable from a successful query that happened to return 0 rows.
 *
 * The fix: `sql-execute.ts` now checks `result.error` before formatting and
 * short-circuits into an error response.
 *
 * These tests pin:
 *   (1) The `error` field remains part of the SqlExecuteResult type contract.
 *   (2) The tool's source code branches on `result.error` before formatting.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../..")

describe("sql_execute — error surfacing", () => {
  test("SqlExecuteResult type includes an optional error field", () => {
    const types = readFileSync(join(REPO_ROOT, "src/altimate/native/types.ts"), "utf-8")
    // Locate the SqlExecuteResult interface, then check for `error?: string`.
    const match = types.match(/export interface SqlExecuteResult\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    expect(match![1]).toMatch(/error\?\s*:\s*string/)
  })

  test("sql-execute tool checks result.error before formatting", () => {
    const src = readFileSync(join(REPO_ROOT, "src/altimate/tools/sql-execute.ts"), "utf-8")
    // The fix branches on `result.error` and returns an ERROR title. Assert
    // both the branch and the ERROR return exist within a reasonable window
    // (the two must be co-located; the tool used to `formatResult` unconditionally).
    expect(src).toMatch(/if\s*\(\s*result\.error\s*\)/)
    // The ERROR-title return must be present near the `if (result.error)` branch,
    // not somewhere else in the file (the catch-block also has an ERROR title;
    // that's a different code path).
    const errorBranchIdx = src.search(/if\s*\(\s*result\.error\s*\)/)
    expect(errorBranchIdx).toBeGreaterThan(0)
    const window = src.slice(errorBranchIdx, errorBranchIdx + 400)
    expect(window).toMatch(/title:\s*["']SQL:\s*ERROR["']/)
    expect(window).toMatch(/Failed to execute SQL/)
  })

  test("dispatcher's sql.execute returns error field on driver failure", () => {
    // This test pins the dispatcher's error path so if it changes shape (e.g.
    // starts throwing instead of returning an object), the tool needs updating too.
    const register = readFileSync(join(REPO_ROOT, "src/altimate/native/connections/register.ts"), "utf-8")
    // Locate the sql.execute handler's catch block.
    const sqlExecIdx = register.search(/register\(\s*["']sql\.execute["']/)
    expect(sqlExecIdx).toBeGreaterThan(0)
    // Within the sql.execute handler, the catch clause must return an object with
    // `error` populated — that's the contract the tool relies on.
    const handlerWindow = register.slice(sqlExecIdx, sqlExecIdx + 5000)
    expect(handlerWindow).toMatch(/error:\s*errorMsg/)
    expect(handlerWindow).toMatch(/return\s*\{[^}]+error:/)
  })
})

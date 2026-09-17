/**
 * Behavior tests for the sql_execute tool's error-surfacing fix (found by
 * the 2026-08-25 snowflake-setup live eval on account DKZPOBS-TQ14188).
 *
 * Bug: the dispatcher's `sql.execute` handler catches driver errors and
 * returns `{ columns: [], rows: [], row_count: 0, truncated: false,
 * error: <msg> }` instead of throwing. The tool's original code ignored
 * the `error` field and ran `formatResult(result)`, which sees
 * `row_count === 0` and prints "(0 rows)" — making a real SQL failure
 * indistinguishable from a successful query that happened to return 0 rows.
 *
 * The fix: `sql-execute.ts` now checks `result.error` before formatting and
 * short-circuits into an error response.
 *
 * These tests invoke the tool with a mocked dispatcher and assert the actual
 * returned behavior — not source text. Rewritten in response to PR #1164
 * review comments 2 and 21 which correctly flagged that the prior
 * text-regex assertions gave false confidence (would false-positive on
 * innocuous refactors and false-negative on regressions that preserved the
 * source markers).
 */
import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import { SessionID, MessageID } from "../../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterEach(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("SqlExecuteTool — error surfacing", () => {
  let dispatcherSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = undefined
  })

  function mockDispatcher(response: unknown) {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => response as never)
  }

  test("dispatcher returns { error } → tool surfaces it, does NOT print '(0 rows)'", async () => {
    // Simulate the exact dispatcher shape that caused the bug: driver failed,
    // handler caught the throw and returned a zero-row result with `error` set.
    mockDispatcher({
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      error: "SQL compilation error: syntax error line 1 at position 62 unexpected ','.",
    })

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "GRANT USAGE ON DATABASE X TO ROLE A, B, C", warehouse: "test_wh", limit: 100 },
      ctx as any,
    )

    // The title must indicate an error (not "SQL: GRANT ...").
    expect(result.title).toBe("SQL: ERROR")
    // The output must contain the real driver error message.
    expect(String(result.output)).toContain("Failed to execute SQL")
    expect(String(result.output)).toContain("syntax error")
    // The output must NOT be the misleading bare "(0 rows)" that the bug produced.
    expect(String(result.output)).not.toContain("(0 rows)")
    // Metadata carries the error so downstream telemetry can pick it up.
    expect(result.metadata.error).toBe(
      "SQL compilation error: syntax error line 1 at position 62 unexpected ','.",
    )
    expect(result.metadata.rowCount).toBe(0)
  })

  test("dispatcher returns normal zero-row result → tool prints '(0 rows)' (baseline)", async () => {
    // Legitimate zero-row success case: no error field, empty rows.
    // Must render as "(0 rows)" — this is the ONE case that string was
    // meant to communicate. The bug fix must not break this.
    mockDispatcher({
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
    })

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "SELECT * FROM t WHERE 1=0", warehouse: "test_wh", limit: 100 },
      ctx as any,
    )

    // Not an error — normal SQL title.
    expect(result.title).not.toBe("SQL: ERROR")
    // Formatted as (0 rows) since row_count === 0 and there's no error.
    expect(String(result.output)).toContain("(0 rows)")
    expect(String(result.output)).not.toContain("Failed to execute SQL")
  })

  test("dispatcher returns rows → tool renders the table (no error path)", async () => {
    mockDispatcher({
      columns: ["current_account"],
      rows: [["BA06306"]],
      row_count: 1,
      truncated: false,
    })

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "SELECT CURRENT_ACCOUNT()", warehouse: "test_wh", limit: 100 },
      ctx as any,
    )

    expect(result.title).not.toBe("SQL: ERROR")
    expect(String(result.output)).toContain("BA06306")
    expect(String(result.output)).toContain("(1 rows)")
    expect(String(result.output)).not.toContain("Failed to execute SQL")
  })

  test("dispatcher throws → tool catches and returns ERROR response (pre-existing behavior preserved)", async () => {
    // Confirm the try/catch fallback still works. This path was correct
    // before the fix; the regression risk was that the new `if (result.error)`
    // branch might interfere. Belt-and-suspenders test that it doesn't.
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => {
      throw new Error("connection refused")
    })

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "SELECT 1", warehouse: "test_wh", limit: 100 },
      ctx as any,
    )

    expect(result.title).toBe("SQL: ERROR")
    expect(String(result.output)).toContain("connection refused")
    // The thrown-error path uses a slightly different message prefix but the
    // key contract is the same: title says ERROR, output surfaces the reason.
    expect(String(result.output)).toContain("Failed to execute SQL")
  })
})

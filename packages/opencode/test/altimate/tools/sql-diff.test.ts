/**
 * Tests for SqlDiffTool — the wrapper must read the native handler's ACTUAL
 * contract ({ success, diff, equivalent, equivalence_confidence, differences }).
 * A previous version read fields the handler never returns (has_changes /
 * unified_diff / similarity), so every comparison reported "identical".
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { SqlDiffTool } from "../../../src/altimate/tools/sql-diff"
import { SessionID, MessageID } from "../../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
} as any

function mockDiff(result: Record<string, any>) {
  Dispatcher.register("sql.diff" as any, async () => result)
}

async function runTool(original: string, modified: string) {
  const tool = await initTool(SqlDiffTool)
  return tool.execute({ original, modified, context_lines: 3 }, ctx)
}

describe("SqlDiffTool", () => {
  beforeEach(() => Dispatcher.reset())

  test("differing queries are reported as changed, not identical", async () => {
    mockDiff({
      success: true,
      diff: "- select 1\n+ select 2",
      equivalent: false,
      equivalence_confidence: 0,
      differences: [{ description: "literal differs" }],
    })
    const r = await runTool("select 1", "select 2")
    expect(r.metadata.has_changes).toBe(true)
    expect(r.metadata.change_count).toBe(2)
    expect(String(r.output)).toContain("+ select 2")
    expect(String(r.output)).toContain("literal differs")
    expect(String(r.output)).not.toContain("identical")
  })

  test("identical queries report no text changes", async () => {
    mockDiff({ success: true, diff: "", equivalent: true, equivalence_confidence: 1, differences: [] })
    const r = await runTool("select 1", "select 1")
    expect(r.metadata.has_changes).toBe(false)
    expect(String(r.output)).toContain("textually identical")
  })

  test("handler failure surfaces the error instead of 'no changes'", async () => {
    mockDiff({ success: false, diff: "", equivalent: false, differences: [], error: "engine unavailable" })
    const r = await runTool("select 1", "select 2")
    expect(r.title).toBe("Diff: ERROR")
    expect(String(r.output)).toContain("engine unavailable")
  })

  test("unproven equivalence is never presented as equivalent", async () => {
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalent: false,
      equivalence_confidence: 0.4,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t")
    expect(String(r.output)).toContain("not proven")
  })
})

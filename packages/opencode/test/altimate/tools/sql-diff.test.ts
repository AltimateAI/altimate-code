/**
 * Tests for SqlDiffTool — the wrapper must read the native handler's ACTUAL
 * contract ({ success, diff, equivalence_assessed, equivalent, decidable,
 * equivalence_confidence, differences }). A previous version read fields the
 * handler never returns (has_changes/unified_diff/similarity), so every
 * comparison reported "identical".
 *
 * Equivalence honesty invariants:
 *  - "not assessed" comes from the HANDLER's equivalence_assessed flag (the
 *    check only runs when the schema actually resolves), never from guessing.
 *  - "equivalent" requires equivalent === true AND decidable === true; an
 *    undecidable result reads UNDECIDABLE and metadata.equivalent stays false.
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

let lastParams: Record<string, any> | undefined
function mockDiff(result: Record<string, any>) {
  Dispatcher.register("sql.diff" as any, async (params: any) => {
    lastParams = params
    return result
  })
}

async function runTool(original: string, modified: string, extra: Record<string, any> = {}) {
  const tool = await initTool(SqlDiffTool)
  return tool.execute({ original, modified, context_lines: 3, ...extra }, ctx)
}

const SCHEMA = { t: { a: "INTEGER", b: "INTEGER" } }

describe("SqlDiffTool", () => {
  beforeEach(() => Dispatcher.reset())

  test("differing queries are reported as changed, not identical", async () => {
    mockDiff({
      success: true,
      diff: "- select 1\n+ select 2",
      equivalence_assessed: true,
      equivalent: false,
      decidable: true,
      equivalence_confidence: 0,
      differences: [{ description: "literal differs" }],
    })
    const r = await runTool("select 1", "select 2", { schema_context: SCHEMA })
    expect(r.metadata.has_changes).toBe(true)
    expect(r.metadata.change_count).toBe(2)
    expect(String(r.output)).toContain("+ select 2")
    expect(String(r.output)).toContain("literal differs")
    expect(String(r.output)).not.toContain("identical")
  })

  test("identical queries report no text changes", async () => {
    mockDiff({
      success: true,
      diff: "",
      equivalence_assessed: true,
      equivalent: true,
      decidable: true,
      equivalence_confidence: 1,
      differences: [],
    })
    const r = await runTool("select 1", "select 1", { schema_context: SCHEMA })
    expect(r.metadata.has_changes).toBe(false)
    expect(String(r.output)).toContain("textually identical")
  })

  test("handler failure surfaces the error instead of 'no changes'", async () => {
    mockDiff({
      success: false,
      diff: "",
      equivalence_assessed: false,
      equivalent: false,
      decidable: false,
      differences: [],
      error: "engine unavailable",
    })
    const r = await runTool("select 1", "select 2")
    expect(r.title).toBe("Diff: ERROR")
    expect(String(r.output)).toContain("engine unavailable")
  })

  test("unassessed equivalence reads NOT ASSESSED — driven by the handler flag", async () => {
    // Handler could not resolve the schema (or none was passed) -> the check
    // never ran; `equivalent: false` there means "did not run", not "failed".
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalence_assessed: false,
      equivalent: false,
      decidable: false,
      equivalence_confidence: 0,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t")
    expect(String(r.output)).toContain("not assessed")
    expect(String(r.output)).not.toContain("not proven")
    expect(r.metadata.equivalence_assessed).toBe(false)
    expect(r.metadata.equivalent).toBe(false)
  })

  test("schema_context and dialect are forwarded to the native handler", async () => {
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalence_assessed: true,
      equivalent: true,
      decidable: true,
      equivalence_confidence: 0.9,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t", { schema_context: SCHEMA, dialect: "duckdb" })
    expect(lastParams?.schema_context).toEqual(SCHEMA)
    expect(lastParams?.dialect).toBe("duckdb")
    expect(String(r.output)).toContain("equivalent (confidence 0.9)")
    expect(r.metadata.equivalent).toBe(true)
  })

  test("equivalent:true with decidable:false reads UNDECIDABLE and metadata.equivalent stays false", async () => {
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalence_assessed: true,
      equivalent: true,
      decidable: false,
      equivalence_confidence: 0.9,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t", { schema_context: SCHEMA })
    expect(String(r.output)).toContain("UNDECIDABLE")
    expect(String(r.output)).not.toContain("Semantic equivalence: equivalent")
    expect(r.metadata.equivalent).toBe(false)
    expect(r.metadata.decidable).toBe(false)
  })

  test("equivalent:false with decidable:false is also UNDECIDABLE — abstention is not refutation", async () => {
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalence_assessed: true,
      equivalent: false,
      decidable: false,
      equivalence_confidence: 0,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t", { schema_context: SCHEMA })
    expect(String(r.output)).toContain("UNDECIDABLE")
    expect(String(r.output)).not.toContain("not proven")
  })

  test("assessed but unproven equivalence is presented as 'not proven'", async () => {
    mockDiff({
      success: true,
      diff: "- a\n+ b",
      equivalence_assessed: true,
      equivalent: false,
      decidable: true,
      equivalence_confidence: 0.4,
      differences: [],
    })
    const r = await runTool("select a from t", "select b from t", { schema_context: SCHEMA })
    expect(String(r.output)).toContain("not proven")
    expect(r.metadata.equivalent).toBe(false)
  })
})

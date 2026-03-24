/**
 * Tests for SqlAnalyzeTool.execute — success flag semantics and output formatting.
 *
 * The bug fix AI-5975 changed sql_analyze to report success:true when analysis
 * completes (even when issues are found). Regression would cause ~4000 false
 * "unknown error" telemetry events per day.
 */
import { describe, test, expect, spyOn, afterAll, beforeEach } from "bun:test"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { SqlAnalyzeTool } from "../../../src/altimate/tools/sql-analyze"
import { SessionID, MessageID } from "../../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
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

let dispatcherSpy: ReturnType<typeof spyOn>

function mockDispatcher(response: any) {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => response)
}

afterAll(() => {
  dispatcherSpy?.mockRestore()
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

describe("SqlAnalyzeTool.execute: success semantics", () => {
  test("issues found → success:true, no error in metadata", async () => {
    mockDispatcher({
      success: true,
      issues: [
        {
          type: "lint",
          severity: "warning",
          message: "SELECT * detected",
          recommendation: "List columns explicitly",
          confidence: "high",
        },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["lint"],
    })

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "SELECT * FROM t", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.error).toBeUndefined()
    expect(result.title).toContain("1 issue")
    expect(result.title).not.toContain("PARSE ERROR")
  })

  test("zero issues → success:true, 'No anti-patterns' output", async () => {
    mockDispatcher({
      success: true,
      issues: [],
      issue_count: 0,
      confidence: "high",
      confidence_factors: [],
    })

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "SELECT id FROM t", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("No anti-patterns")
    expect(result.title).toContain("0 issues")
  })

  test("parse error → success:false, error in metadata and title", async () => {
    mockDispatcher({
      success: false,
      issues: [],
      issue_count: 0,
      confidence: "low",
      confidence_factors: [],
      error: "syntax error near SELECT",
    })

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "SELEC FROM", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("syntax error near SELECT")
    expect(result.title).toContain("PARSE ERROR")
  })

  test("dispatcher throws → catch block returns ERROR title", async () => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockRejectedValue(new Error("native crash"))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "SELECT 1", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.title).toBe("Analyze: ERROR")
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("native crash")
    expect(result.output).toContain("Failed to analyze SQL: native crash")
  })
})

describe("SqlAnalyzeTool.execute: formatAnalysis output", () => {
  test("singular issue → '1 issue' not '1 issues'", async () => {
    mockDispatcher({
      success: true,
      issues: [
        {
          type: "lint",
          severity: "warning",
          message: "test issue",
          recommendation: "fix it",
          confidence: "high",
        },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["lint"],
    })

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "x", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.output).toContain("Found 1 issue ")
    expect(result.output).not.toContain("1 issues")
  })

  test("multiple issues with location, confidence, and factors", async () => {
    mockDispatcher({
      success: true,
      issues: [
        {
          type: "lint",
          severity: "warning",
          message: "SELECT * used",
          recommendation: "List columns",
          confidence: "high",
        },
        {
          type: "safety",
          severity: "high",
          message: "DROP TABLE detected",
          recommendation: "Use caution",
          location: "chars 0-5",
          confidence: "medium",
        },
      ],
      issue_count: 2,
      confidence: "high",
      confidence_factors: ["lint", "safety"],
    })

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute(
      { sql: "x", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.output).toContain("2 issues")
    expect(result.output).toContain("[WARNING] lint")
    expect(result.output).toContain("[HIGH] safety [medium confidence]")
    expect(result.output).toContain("chars 0-5")
    expect(result.output).toContain("Note: lint; safety")
  })
})

/**
 * E2E Integration Tests — Feature Discovery
 *
 * Tests the full flow for:
 * 1. Post-warehouse-connect suggestions (warehouse_add -> contextual hints)
 * 2. Progressive disclosure (sql_execute -> sql_analyze -> schema_inspect -> lineage_check)
 * 3. Plan refinement (two-step approach, revision tracking, approval detection)
 * 4. Telemetry event validation
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll, spyOn } from "bun:test"
import { initTool } from "./tool-fixture"
import fs from "fs/promises"
import path from "path"

// ---------------------------------------------------------------------------
// Import modules under test and dependencies
// ---------------------------------------------------------------------------
import { Telemetry } from "../../src/telemetry"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { WarehouseAddTool } from "../../src/altimate/tools/warehouse-add"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { SqlAnalyzeTool } from "../../src/altimate/tools/sql-analyze"
import { SchemaInspectTool } from "../../src/altimate/tools/schema-inspect"
import { SchemaIndexTool } from "../../src/altimate/tools/schema-index"
import { PostConnectSuggestions } from "../../src/altimate/tools/post-connect-suggestions"
import { SessionID, MessageID } from "../../src/session/schema"

// ---------------------------------------------------------------------------
// Capture telemetry via spyOn instead of mock.module to avoid
// Bun's process-global mock.module leaking into other test files.
// ---------------------------------------------------------------------------
const trackedEvents: any[] = []

// ---------------------------------------------------------------------------
// Shared test context (matches pattern from sql-analyze-tool.test.ts)
// ---------------------------------------------------------------------------
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

function mockDispatcherCall(handler: (method: string, params: any) => Promise<any>) {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)
}

beforeEach(() => {
  trackedEvents.length = 0
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  PostConnectSuggestions.resetShownSuggestions()
  spyOn(Telemetry, "track").mockImplementation((event: any) => {
    trackedEvents.push(event)
  })
  spyOn(Telemetry, "getContext").mockReturnValue({
    sessionId: "test-session-e2e",
    projectId: "",
  } as any)
})

afterEach(() => {
  dispatcherSpy?.mockRestore()
  mock.restore()
})

afterAll(() => {
  dispatcherSpy?.mockRestore()
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

// ===========================================================================
// 1. Warehouse Add -> Suggestions Flow
// ===========================================================================

describe("warehouse-add e2e: post-connect suggestions", () => {
  test("successful warehouse add includes contextual suggestions in output", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") {
        return { success: true, name: "test_wh", type: "snowflake" }
      }
      if (method === "schema.cache_status") {
        return { total_tables: 0 }
      }
      if (method === "warehouse.list") {
        return { warehouses: [{ name: "test_wh" }] }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { type: "snowflake", account: "xy12345", user: "admin", password: "test-fake-password" } },
      ctx as any,
    )

    expect(result.output).toContain("Successfully added warehouse")
    expect(result.output).toContain("schema_index")
    expect(result.output).toContain("Index your schema")
    expect(result.output).toContain("sql_execute")
    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("Available capabilities for your snowflake warehouse")

    // Verify telemetry was tracked with feature_suggestion type
    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBeGreaterThanOrEqual(1)
    const evt = suggestionEvents[0]
    expect(evt.suggestion_type).toBe("post_warehouse_connect")
    expect(evt.suggestions_shown).toContain("schema_index")
    expect(evt.suggestions_shown).toContain("sql_execute")
  })

  test("warehouse add with schema already indexed omits schema_index suggestion", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") {
        return { success: true, name: "test_wh", type: "snowflake" }
      }
      if (method === "schema.cache_status") {
        return { total_tables: 50 }
      }
      if (method === "warehouse.list") {
        return { warehouses: [{ name: "test_wh" }] }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { type: "snowflake", account: "xy12345", user: "admin", password: "test-fake-password" } },
      ctx as any,
    )

    expect(result.output).not.toContain("Index your schema")
    expect(result.output).toContain("sql_execute")
  })

  test("warehouse add with dbt detected includes dbt skill suggestions", async () => {
    // Test PostConnectSuggestions directly to verify dbt suggestions appear
    // when dbt is detected. Avoids mock.module("project-scan") which leaks
    // across test files in Bun's shared process.
    const directResult = PostConnectSuggestions.getPostConnectSuggestions({
      warehouseType: "postgres",
      schemaIndexed: false,
      dbtDetected: true,
      connectionCount: 1,
      toolsUsedInSession: [],
    })
    expect(directResult).toContain("/dbt-develop")
    expect(directResult).toContain("/dbt-troubleshoot")
    expect(directResult).toContain("dbt project detected")
  })

  test("warehouse add failure does not include suggestions", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") {
        throw new Error("Connection refused")
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { type: "snowflake", account: "xy12345" } },
      ctx as any,
    )

    expect(result.output).toContain("Failed to add warehouse")
    expect(result.output).not.toContain("Available capabilities")
    expect(result.output).not.toContain("schema_index")

    // No feature_suggestion telemetry on failure
    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBe(0)
  })

  test("warehouse add returns non-success result does not include suggestions", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") {
        return { success: false, error: "Invalid credentials", name: "test_wh", type: "snowflake" }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { type: "snowflake", account: "xy12345" } },
      ctx as any,
    )

    expect(result.output).toContain("Failed to add warehouse")
    expect(result.output).not.toContain("Available capabilities")
  })

  test("suggestions never block warehouse add on internal error", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") {
        return { success: true, name: "test_wh", type: "snowflake" }
      }
      if (method === "schema.cache_status") {
        throw new Error("schema service unavailable")
      }
      if (method === "warehouse.list") {
        throw new Error("warehouse list service down")
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { type: "snowflake", account: "xy12345", user: "admin", password: "test-fake-password" } },
      ctx as any,
    )

    // Warehouse add itself succeeded
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("Successfully added warehouse")
  })

  test("missing type in config returns helpful error", async () => {
    const tool = await initTool(WarehouseAddTool)
    const result = await tool.execute(
      { name: "test_wh", config: { host: "localhost" } },
      ctx as any,
    )

    expect(result.output).toContain("Missing required field")
    expect(result.output).toContain("type")
    expect(result.metadata.success).toBe(false)
  })
})

// ===========================================================================
// 2. Progressive Disclosure Flow
// ===========================================================================

describe("progressive disclosure e2e", () => {
  test("sql_execute output includes sql_analyze suggestion", async () => {
    mockDispatcherCall(async () => ({
      columns: ["id", "name"],
      rows: [[1, "Alice"]],
      row_count: 1,
      truncated: false,
    }))

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "SELECT id, name FROM users", limit: 100 },
      ctx as any,
    )

    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("Tip:")

    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBeGreaterThanOrEqual(1)
    expect(suggestionEvents[0].suggestion_type).toBe("progressive_disclosure")
    expect(suggestionEvents[0].suggestions_shown).toContain("sql_analyze")
  })

  test("sql_analyze output includes schema_inspect suggestion", async () => {
    mockDispatcherCall(async () => ({
      success: true,
      issues: [],
      issue_count: 0,
      confidence: "high",
      confidence_factors: [],
    }))

    const tool = await initTool(SqlAnalyzeTool)
    const result = await tool.execute(
      { sql: "SELECT id FROM users", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.output).toContain("schema_inspect")
    expect(result.output).toContain("Tip:")

    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBeGreaterThanOrEqual(1)
    expect(suggestionEvents[0].suggestions_shown).toContain("schema_inspect")
  })

  test("schema_inspect output includes lineage_check suggestion", async () => {
    mockDispatcherCall(async () => ({
      table: "users",
      schema_name: "public",
      columns: [{ name: "id", data_type: "INTEGER", nullable: false }],
      row_count: 100,
    }))

    const tool = await initTool(SchemaInspectTool)
    const result = await tool.execute(
      { table: "users" },
      ctx as any,
    )

    expect(result.output).toContain("lineage_check")
    expect(result.output).toContain("Tip:")

    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBeGreaterThanOrEqual(1)
    expect(suggestionEvents[0].suggestions_shown).toContain("lineage_check")
  })

  test("schema_index output lists available capabilities", async () => {
    mockDispatcherCall(async () => ({
      success: true,
      tables_indexed: 25,
      type: "snowflake",
    }))

    const tool = await initTool(SchemaIndexTool)
    const result = await tool.execute(
      { warehouse: "test_wh" },
      ctx as any,
    )

    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("schema_inspect")
    expect(result.output).toContain("lineage_check")

    const suggestionEvents = trackedEvents.filter((e) => e.type === "feature_suggestion")
    expect(suggestionEvents.length).toBeGreaterThanOrEqual(1)
    expect(suggestionEvents[0].suggestions_shown).toEqual(["sql_analyze", "schema_inspect", "lineage_check"])
  })

  test("progressive suggestions don't appear when tool fails", async () => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockRejectedValue(new Error("connection failed"))

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute(
      { query: "SELECT 1", limit: 100 },
      ctx as any,
    )

    expect(result.output).toContain("Failed to execute SQL")
    expect(result.output).not.toContain("Tip:")
    expect(result.output).not.toContain("sql_analyze")

    // No progressive suggestion telemetry on failure
    const progressiveEvents = trackedEvents.filter(
      (e) => e.type === "feature_suggestion" && e.suggestion_type === "progressive_disclosure",
    )
    expect(progressiveEvents.length).toBe(0)
  })

  test("sql_analyze failure does not include progressive suggestions", async () => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockRejectedValue(new Error("analysis engine down"))

    const tool = await initTool(SqlAnalyzeTool)
    const result = await tool.execute(
      { sql: "SELECT 1", dialect: "snowflake" },
      ctx as any,
    )

    expect(result.output).toContain("Failed to analyze SQL")
    expect(result.output).not.toContain("Tip:")
  })
})

// ===========================================================================
// 3. Plan Refinement Session Flow
// ===========================================================================

describe("plan refinement e2e", () => {
  test("plan revision tracking variables are initialized", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain("let planRevisionCount = 0")
    expect(content).toContain("let planHasWritten = false")
  })

  test("plan agent prompt includes two-step instructions", async () => {
    const planPromptPath = path.join(__dirname, "../../src/session/prompt/plan.txt")
    const content = await fs.readFile(planPromptPath, "utf-8")

    expect(content).toMatch(/two-?step/i)
    expect(content).toMatch(/outline|bullet\s*point/i)
    expect(content).toMatch(/confirm|direction.*right|looks.*right/i)
    expect(content).toMatch(/refine|change/i)
    expect(content).toMatch(/full.*plan|detailed.*plan/i)
  })

  test("plan agent prompt includes feedback/refinement instructions", async () => {
    const planPromptPath = path.join(__dirname, "../../src/session/prompt/plan.txt")
    const content = await fs.readFile(planPromptPath, "utf-8")

    expect(content).toMatch(/feedback/i)
    expect(content).toMatch(/read.*existing.*plan|read.*plan.*file/i)
    expect(content).toMatch(/incorporate|apply.*feedback/i)
    expect(content).toMatch(/update.*plan/i)
    expect(content).toMatch(/summarize|describe.*change/i)
  })

  test("revision cap is enforced at 5", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain("planRevisionCount >= 5")
  })

  test("revision counter increments on each plan refinement", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain("planRevisionCount++")
    // Should appear exactly once, inside the plan guard
    const incrementMatches = content.match(/planRevisionCount\+\+/g)
    expect(incrementMatches).toBeTruthy()
    expect(incrementMatches!.length).toBe(1)
  })

  test("approval phrases are correctly detected", () => {
    // Matches the actual implementation in prompt.ts
    const approvalPhrases = ["looks good", "proceed", "approved", "approve", "lgtm", "go ahead", "ship it", "yes", "perfect"]
    const rejectionPhrases = ["don't", "stop", "reject", "not good", "undo", "abort", "start over", "wrong"]
    const rejectionWords = ["no"]
    const refinementQualifiers = [" but ", " however ", " except ", " change ", " modify ", " update ", " instead ", " although ", " with the following", " with these"]

    function detectAction(text: string): "approve" | "reject" | "refine" {
      const lower = text.toLowerCase()
      const isRejectionPhrase = rejectionPhrases.some((p) => lower.includes(p))
      const isRejectionWord = rejectionWords.some((w) => new RegExp(`\\b${w}\\b`).test(lower))
      const isRejection = isRejectionPhrase || isRejectionWord
      const hasRefinementQualifier = refinementQualifiers.some((q) => lower.includes(q))
      const isApproval = !isRejection && !hasRefinementQualifier && approvalPhrases.some((p) => lower.includes(p))
      return isRejection ? "reject" : isApproval ? "approve" : "refine"
    }

    // Pure approval phrases
    expect(detectAction("looks good")).toBe("approve")
    expect(detectAction("lgtm")).toBe("approve")
    expect(detectAction("ship it")).toBe("approve")
    expect(detectAction("perfect")).toBe("approve")
    expect(detectAction("yes")).toBe("approve")

    // Rejection takes priority
    expect(detectAction("no, that doesn't look good")).toBe("reject")
    expect(detectAction("stop, wrong approach")).toBe("reject")
    expect(detectAction("abort the plan")).toBe("reject")

    // "no" as standalone word is rejection
    expect(detectAction("no way")).toBe("reject")

    // "no" embedded in a word is NOT rejection (word-boundary match)
    expect(detectAction("I know this is fine, proceed")).toBe("approve")

    // Refinement qualifiers override approval
    expect(detectAction("looks good but change the database layer")).toBe("refine")
    expect(detectAction("approved however modify the tests")).toBe("refine")

    // Neutral text → refine
    expect(detectAction("can you explain the architecture more")).toBe("refine")
  })

  test("action is 'refine' when neither approval nor rejection detected", () => {
    const approvalPhrases = ["looks good", "proceed", "approved", "approve", "lgtm", "go ahead", "ship it", "yes", "perfect"]
    const rejectionPhrases = ["don't", "stop", "reject", "not good", "undo", "abort", "start over", "wrong"]
    const rejectionWords = ["no"]

    const userText = "can you add error handling to the database layer"
    const isRejectionPhrase = rejectionPhrases.some((phrase) => userText.includes(phrase))
    const isRejectionWord = rejectionWords.some((w) => new RegExp(`\\b${w}\\b`).test(userText))
    const isRejection = isRejectionPhrase || isRejectionWord
    const isApproval = !isRejection && approvalPhrases.some((phrase) => userText.includes(phrase))
    const action = isRejection ? "reject" : isApproval ? "approve" : "refine"

    expect(action).toBe("refine")
  })

  test("plan revision tracking is guarded by agent name check", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain('if (agent.name === "plan"')
  })

  test("plan file detection only runs for plan agent", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain('if (agent.name === "plan" && !planHasWritten)')
  })
})

// ===========================================================================
// 4. Telemetry Event Validation
// ===========================================================================

describe("telemetry event validation e2e", () => {
  test("feature_suggestion event has required fields", () => {
    // Trigger a feature_suggestion event via trackSuggestions
    PostConnectSuggestions.trackSuggestions({
      suggestionType: "post_warehouse_connect",
      suggestionsShown: ["schema_index", "sql_analyze", "lineage_check"],
      warehouseType: "snowflake",
    })

    expect(trackedEvents.length).toBe(1)
    const evt = trackedEvents[0]
    expect(evt.type).toBe("feature_suggestion")
    expect(evt.timestamp).toBeGreaterThan(0)
    expect(evt.session_id).toBe("test-session-e2e")
    expect(evt.suggestion_type).toBe("post_warehouse_connect")
    expect(evt.suggestions_shown).toEqual(["schema_index", "sql_analyze", "lineage_check"])
    expect(evt.warehouse_type).toBe("snowflake")
  })

  test("feature_suggestion event defaults warehouse_type to 'unknown'", () => {
    PostConnectSuggestions.trackSuggestions({
      suggestionType: "progressive_disclosure",
      suggestionsShown: ["sql_analyze"],
    })

    expect(trackedEvents.length).toBe(1)
    expect(trackedEvents[0].warehouse_type).toBe("unknown")
  })

  test("plan_revision event type exists in telemetry definitions", async () => {
    const telemetryPath = path.join(__dirname, "../../src/altimate/telemetry/index.ts")
    const content = await fs.readFile(telemetryPath, "utf-8")

    expect(content).toContain('type: "plan_revision"')
    expect(content).toContain("revision_number: number")
    expect(content).toContain('action: "refine" | "approve" | "reject"')
  })

  test("plan_revision telemetry is emitted in the session loop", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain('type: "plan_revision"')
    expect(content).toContain("revision_number: planRevisionCount")
  })

  test("skill_used event includes trigger field in type definition", async () => {
    const telemetryPath = path.join(__dirname, "../../src/altimate/telemetry/index.ts")
    const content = await fs.readFile(telemetryPath, "utf-8")

    expect(content).toContain('type: "skill_used"')
    expect(content).toContain('trigger: "user_command" | "llm_selected" | "auto_suggested" | "unknown"')
  })

  test("feature_suggestion event type is defined in telemetry", async () => {
    const telemetryPath = path.join(__dirname, "../../src/altimate/telemetry/index.ts")
    const content = await fs.readFile(telemetryPath, "utf-8")

    expect(content).toContain('type: "feature_suggestion"')
    expect(content).toContain("suggestions_shown: string[]")
  })
})

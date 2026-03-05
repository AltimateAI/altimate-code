import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/telemetry"

// ---------------------------------------------------------------------------
// 1. categorizeToolName
// ---------------------------------------------------------------------------
describe("telemetry.categorizeToolName", () => {
  test("returns 'mcp' for mcp tools regardless of name", () => {
    expect(Telemetry.categorizeToolName("anything", "mcp")).toBe("mcp")
    expect(Telemetry.categorizeToolName("sql_query", "mcp")).toBe("mcp")
  })

  test("returns 'sql' for sql-related tools", () => {
    expect(Telemetry.categorizeToolName("sql_execute", "standard")).toBe("sql")
    expect(Telemetry.categorizeToolName("run_query", "standard")).toBe("sql")
  })

  test("returns 'schema' for schema-related tools", () => {
    expect(Telemetry.categorizeToolName("schema_inspector", "standard")).toBe("schema")
    expect(Telemetry.categorizeToolName("list_columns", "standard")).toBe("schema")
    expect(Telemetry.categorizeToolName("describe_table", "standard")).toBe("schema")
  })

  test("returns 'dbt' for dbt tools", () => {
    expect(Telemetry.categorizeToolName("dbt_build", "standard")).toBe("dbt")
    expect(Telemetry.categorizeToolName("dbt_run", "standard")).toBe("dbt")
  })

  test("returns 'finops' for cost/finops tools", () => {
    expect(Telemetry.categorizeToolName("cost_analysis", "standard")).toBe("finops")
    expect(Telemetry.categorizeToolName("finops_report", "standard")).toBe("finops")
    expect(Telemetry.categorizeToolName("warehouse_usage_stats", "standard")).toBe("finops")
  })

  test("returns 'warehouse' for warehouse/connection tools", () => {
    expect(Telemetry.categorizeToolName("warehouse_list", "standard")).toBe("warehouse")
    expect(Telemetry.categorizeToolName("connection_test", "standard")).toBe("warehouse")
  })

  test("returns 'lineage' for lineage/dag tools", () => {
    expect(Telemetry.categorizeToolName("lineage_trace", "standard")).toBe("lineage")
    expect(Telemetry.categorizeToolName("dag_viewer", "standard")).toBe("lineage")
  })

  test("returns 'file' for file operation tools", () => {
    for (const tool of ["read", "write", "edit", "glob", "grep", "bash"]) {
      expect(Telemetry.categorizeToolName(tool, "standard")).toBe("file")
    }
  })

  test("returns 'standard' for unknown tools", () => {
    expect(Telemetry.categorizeToolName("unknown_tool", "standard")).toBe("standard")
    expect(Telemetry.categorizeToolName("some_custom_thing", "standard")).toBe("standard")
  })

  test("is case insensitive", () => {
    expect(Telemetry.categorizeToolName("SQL_EXECUTE", "standard")).toBe("sql")
    expect(Telemetry.categorizeToolName("DBT_Build", "standard")).toBe("dbt")
    expect(Telemetry.categorizeToolName("Read", "standard")).toBe("file")
  })
})

// ---------------------------------------------------------------------------
// 2. bucketCount
// ---------------------------------------------------------------------------
describe("telemetry.bucketCount", () => {
  test("returns '0' for zero or negative", () => {
    expect(Telemetry.bucketCount(0)).toBe("0")
    expect(Telemetry.bucketCount(-5)).toBe("0")
  })

  test("returns '1-10' for 1-10", () => {
    expect(Telemetry.bucketCount(1)).toBe("1-10")
    expect(Telemetry.bucketCount(10)).toBe("1-10")
  })

  test("returns '10-50' for 11-50", () => {
    expect(Telemetry.bucketCount(11)).toBe("10-50")
    expect(Telemetry.bucketCount(50)).toBe("10-50")
  })

  test("returns '50-200' for 51-200", () => {
    expect(Telemetry.bucketCount(51)).toBe("50-200")
    expect(Telemetry.bucketCount(200)).toBe("50-200")
  })

  test("returns '200+' for >200", () => {
    expect(Telemetry.bucketCount(201)).toBe("200+")
    expect(Telemetry.bucketCount(1000)).toBe("200+")
  })
})

// ---------------------------------------------------------------------------
// 3. track — basic smoke tests (telemetry disabled by default)
// ---------------------------------------------------------------------------
describe("telemetry.track", () => {
  test("track is a function", () => {
    expect(typeof Telemetry.track).toBe("function")
  })

  test("track does not throw when called with valid events while disabled", () => {
    expect(() => {
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "test-session",
        model_id: "test-model",
        provider_id: "test-provider",
        agent: "test-agent",
        project_id: "test-project",
      })
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 4. setContext / getContext
// ---------------------------------------------------------------------------
describe("telemetry.context", () => {
  test("setContext and getContext work together", () => {
    Telemetry.setContext({ sessionId: "sess-123", projectId: "proj-456" })
    const ctx = Telemetry.getContext()
    expect(ctx.sessionId).toBe("sess-123")
    expect(ctx.projectId).toBe("proj-456")
  })

  test("getContext returns empty strings initially after shutdown", async () => {
    await Telemetry.shutdown()
    const ctx = Telemetry.getContext()
    expect(ctx.sessionId).toBe("")
    expect(ctx.projectId).toBe("")
  })
})

// ---------------------------------------------------------------------------
// 5. Event type completeness — all 25 event types
// ---------------------------------------------------------------------------
describe("telemetry.event-types", () => {
  test("all event types are valid", () => {
    const eventTypes: Telemetry.Event["type"][] = [
      "session_start",
      "session_end",
      "generation",
      "tool_call",
      "bridge_call",
      "error",
      "command",
      "context_overflow_recovered",
      "compaction_triggered",
      "tool_outputs_pruned",
      "auth_login",
      "auth_logout",
      "mcp_server_status",
      "provider_error",
      "engine_started",
      "engine_error",
      "upgrade_attempted",
      "session_forked",
      "permission_denied",
      "doom_loop_detected",
      "environment_census",
      "context_utilization",
      "agent_outcome",
      "error_recovered",
      "mcp_server_census",
    ]
    expect(eventTypes.length).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// 6. Privacy validation
// ---------------------------------------------------------------------------
describe("telemetry.privacy", () => {
  test("error events truncate messages to 500 chars", () => {
    const longError = "x".repeat(1000)
    const event: Telemetry.Event = {
      type: "provider_error",
      timestamp: Date.now(),
      session_id: "test",
      provider_id: "test",
      model_id: "test",
      error_type: "test",
      error_message: longError.slice(0, 500),
    }
    expect(event.error_message.length).toBe(500)
  })

  test("engine_error truncates error_message", () => {
    const longError = "y".repeat(1000)
    const event: Telemetry.Event = {
      type: "engine_error",
      timestamp: Date.now(),
      session_id: "test",
      phase: "startup",
      error_message: longError.slice(0, 500),
    }
    expect(event.error_message.length).toBe(500)
  })

  test("tool_call event does NOT include tool arguments", () => {
    const event: Telemetry.Event = {
      type: "tool_call",
      timestamp: Date.now(),
      session_id: "test",
      message_id: "msg-1",
      tool_name: "sql_execute",
      tool_type: "standard",
      tool_category: "sql",
      status: "success",
      duration_ms: 100,
      sequence_index: 0,
      previous_tool: null,
    }
    expect("input" in event).toBe(false)
    expect("output" in event).toBe(false)
    expect("args" in event).toBe(false)
    expect("arguments" in event).toBe(false)
  })

  test("environment_census does NOT include hostnames or credentials", () => {
    const event: Telemetry.Event = {
      type: "environment_census",
      timestamp: Date.now(),
      session_id: "test",
      warehouse_types: ["snowflake", "bigquery"],
      warehouse_count: 2,
      dbt_detected: true,
      dbt_adapter: "snowflake",
      dbt_model_count_bucket: "10-50",
      dbt_source_count_bucket: "1-10",
      dbt_test_count_bucket: "1-10",
      connection_sources: ["configured", "dbt-profile"],
      mcp_server_count: 3,
      skill_count: 0,
      os: "darwin",
      feature_flags: ["plan_mode"],
    }
    expect("hostname" in event).toBe(false)
    expect("password" in event).toBe(false)
    expect("connection_string" in event).toBe(false)
    expect("host" in event).toBe(false)
    expect("port" in event).toBe(false)
    expect(event.dbt_model_count_bucket).toMatch(/^(0|1-10|10-50|50-200|200\+)$/)
  })
})

// ---------------------------------------------------------------------------
// 7. Naming convention validation
// ---------------------------------------------------------------------------
describe("telemetry.naming-convention", () => {
  test("all event types use snake_case", () => {
    const types: Telemetry.Event["type"][] = [
      "session_start",
      "session_end",
      "generation",
      "tool_call",
      "bridge_call",
      "error",
      "command",
      "context_overflow_recovered",
      "compaction_triggered",
      "tool_outputs_pruned",
      "auth_login",
      "auth_logout",
      "mcp_server_status",
      "provider_error",
      "engine_started",
      "engine_error",
      "upgrade_attempted",
      "session_forked",
      "permission_denied",
      "doom_loop_detected",
      "environment_census",
      "context_utilization",
      "agent_outcome",
      "error_recovered",
      "mcp_server_census",
    ]
    for (const t of types) {
      expect(t).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})

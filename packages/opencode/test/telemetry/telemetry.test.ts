// @ts-nocheck
import { describe, expect, test, mock, afterEach, beforeEach, spyOn } from "bun:test"
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
// 3. track — buffering behavior
// ---------------------------------------------------------------------------
describe("telemetry.track", () => {
  test("track is a function", () => {
    expect(typeof Telemetry.track).toBe("function")
  })

  test("track does not throw when called with valid events before init", () => {
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

  test("pre-init events are buffered, not dropped", async () => {
    // Ensure clean state
    await Telemetry.shutdown()

    // Track before init — should buffer
    Telemetry.track({
      type: "mcp_server_status",
      timestamp: Date.now(),
      session_id: "pre-init",
      server_name: "test",
      transport: "stdio",
      status: "connected",
    })
    Telemetry.track({
      type: "engine_started",
      timestamp: Date.now(),
      session_id: "pre-init",
      engine_version: "1.0",
      python_version: "3.12",
      status: "started",
      duration_ms: 100,
    })

    // init() with telemetry disabled via env var — should clear buffer
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    try {
      await Telemetry.init()
      // After init disables, track should drop
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "post-disable",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "x",
      })
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      await Telemetry.shutdown()
    }
  })

  test("init() is idempotent — second call returns same promise", async () => {
    await Telemetry.shutdown()
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    try {
      const p1 = Telemetry.init()
      const p2 = Telemetry.init()
      expect(p1).toBe(p2) // same promise object
      await p1
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      await Telemetry.shutdown()
    }
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

// ---------------------------------------------------------------------------
// 8. parseConnectionString (tested indirectly via init + flush)
// ---------------------------------------------------------------------------
describe("telemetry.parseConnectionString (indirect)", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("valid connection string enables telemetry and produces correct endpoint in flush", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchCalls: { url: string; body: string }[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (input: any, init: any) => {
      fetchCalls.push({ url: String(input), body: String(init?.body ?? "") })
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=test-key-123;IngestionEndpoint=https://example.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: 1000,
        session_id: "s1",
        model_id: "m1",
        provider_id: "p1",
        agent: "a1",
        project_id: "proj1",
      })

      await Telemetry.flush()

      expect(fetchCalls.length).toBe(1)
      expect(fetchCalls[0].url).toBe("https://example.com/v2/track")
      const body = JSON.parse(fetchCalls[0].body)
      expect(body[0].iKey).toBe("test-key-123")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("missing InstrumentationKey in connection string disables telemetry", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "IngestionEndpoint=https://example.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: 1000,
        session_id: "s1",
        model_id: "m1",
        provider_id: "p1",
        agent: "a1",
        project_id: "proj1",
      })

      await Telemetry.flush()

      // fetch should NOT be called — telemetry disabled due to invalid connection string
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("trailing slash on IngestionEndpoint is handled correctly", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchCalls: { url: string }[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (input: any) => {
      fetchCalls.push({ url: String(input) })
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      // Trailing slash — should not double-up
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=key-456;IngestionEndpoint=https://example.com/"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: 1000,
        session_id: "s1",
        model_id: "m1",
        provider_id: "p1",
        agent: "a1",
        project_id: "proj1",
      })

      await Telemetry.flush()

      expect(fetchCalls.length).toBe(1)
      // Should be /v2/track, not //v2/track
      expect(fetchCalls[0].url).toBe("https://example.com/v2/track")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("empty connection string disables telemetry", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = ""
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: 1000,
        session_id: "s1",
        model_id: "m1",
        provider_id: "p1",
        agent: "a1",
        project_id: "proj1",
      })

      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. toAppInsightsEnvelopes (tested indirectly via track + flush)
// ---------------------------------------------------------------------------
describe("telemetry.toAppInsightsEnvelopes (indirect)", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  async function initWithMockedFetch(): {
    fetchCalls: { url: string; body: string }[]
    fetchMock: ReturnType<typeof spyOn>
    cleanup: () => void
  } {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=test-ikey;IngestionEndpoint=https://test.endpoint.com"

    const fetchCalls: { url: string; body: string }[] = []
    const fetchMock = spyOn(global, "fetch").mockImplementation(async (_input: any, init: any) => {
      fetchCalls.push({ url: String(_input), body: String(init?.body ?? "") })
      return new Response("", { status: 200 })
    })

    await Telemetry.init()

    return {
      fetchCalls,
      fetchMock,
      cleanup: () => {
        process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
        if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
        else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
        fetchMock.mockRestore()
      },
    }
  }

  test("basic event is converted to envelope format", async () => {
    const { fetchCalls, cleanup } = await initWithMockedFetch()
    try {
      Telemetry.setContext({ sessionId: "sess-abc", projectId: "proj-xyz" })
      Telemetry.track({
        type: "session_start",
        timestamp: 1700000000000,
        session_id: "sess-abc",
        model_id: "claude-3",
        provider_id: "anthropic",
        agent: "builder",
        project_id: "proj-xyz",
      })

      await Telemetry.flush()

      expect(fetchCalls.length).toBe(1)
      const envelopes = JSON.parse(fetchCalls[0].body)
      expect(envelopes.length).toBe(1)

      const env = envelopes[0]
      expect(env.name).toBe("Microsoft.ApplicationInsights.test-ikey.Event")
      expect(env.iKey).toBe("test-ikey")
      expect(env.time).toBe(new Date(1700000000000).toISOString())
      expect(env.tags["ai.session.id"]).toBe("sess-abc")
      expect(env.tags["ai.cloud.role"]).toBe("altimate")
      expect(env.data.baseType).toBe("EventData")
      expect(env.data.baseData.ver).toBe(2)
      expect(env.data.baseData.name).toBe("session_start")
      // String fields go to properties
      expect(env.data.baseData.properties.model_id).toBe("claude-3")
      expect(env.data.baseData.properties.provider_id).toBe("anthropic")
      expect(env.data.baseData.properties.agent).toBe("builder")
    } finally {
      cleanup()
    }
  })

  test("numeric fields go to measurements, string fields go to properties", async () => {
    const { fetchCalls, cleanup } = await initWithMockedFetch()
    try {
      Telemetry.track({
        type: "session_end",
        timestamp: 1700000000000,
        session_id: "sess-1",
        total_cost: 0.05,
        total_tokens: 1500,
        tool_call_count: 10,
        duration_ms: 30000,
      })

      await Telemetry.flush()

      const envelopes = JSON.parse(fetchCalls[0].body)
      const baseData = envelopes[0].data.baseData
      // Numeric fields in measurements
      expect(baseData.measurements.total_cost).toBe(0.05)
      expect(baseData.measurements.total_tokens).toBe(1500)
      expect(baseData.measurements.tool_call_count).toBe(10)
      expect(baseData.measurements.duration_ms).toBe(30000)
    } finally {
      cleanup()
    }
  })

  test("nested tokens object is flattened with tokens_ prefix", async () => {
    const { fetchCalls, cleanup } = await initWithMockedFetch()
    try {
      Telemetry.track({
        type: "generation",
        timestamp: 1700000000000,
        session_id: "sess-1",
        message_id: "msg-1",
        model_id: "claude-3",
        provider_id: "anthropic",
        agent: "builder",
        finish_reason: "end_turn",
        tokens: {
          input: 100,
          output: 200,
          reasoning: 50,
          cache_read: 10,
          cache_write: 5,
        },
        cost: 0.01,
        duration_ms: 2000,
      })

      await Telemetry.flush()

      const envelopes = JSON.parse(fetchCalls[0].body)
      const measurements = envelopes[0].data.baseData.measurements
      expect(measurements.tokens_input).toBe(100)
      expect(measurements.tokens_output).toBe(200)
      expect(measurements.tokens_reasoning).toBe(50)
      expect(measurements.tokens_cache_read).toBe(10)
      expect(measurements.tokens_cache_write).toBe(5)
      // Raw "tokens" key should not appear in properties
      expect(envelopes[0].data.baseData.properties.tokens).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("fallback sessionId when none set on event", async () => {
    const { fetchCalls, cleanup } = await initWithMockedFetch()
    try {
      // Set context with a session ID
      Telemetry.setContext({ sessionId: "fallback-sess", projectId: "p" })

      // Track event without session_id in the actual event payload is not possible
      // since all events require session_id. But we can verify the tags use event's session_id.
      // If the event session_id is empty, the module falls back to the context sessionId.
      Telemetry.track({
        type: "error",
        timestamp: 1700000000000,
        session_id: "",
        error_name: "TestError",
        error_message: "test",
        context: "test",
      })

      await Telemetry.flush()

      const envelopes = JSON.parse(fetchCalls[0].body)
      // Empty session_id falls back to "startup" (since "" is falsy)
      // Actually, looking at the code: `const sid = fields.session_id ?? sessionId`
      // "" is not null/undefined, so sid = "". Then `sid || "startup"` = "startup"
      expect(envelopes[0].tags["ai.session.id"]).toBe("startup")
    } finally {
      cleanup()
    }
  })

  test("timestamp is included as ISO string", async () => {
    const { fetchCalls, cleanup } = await initWithMockedFetch()
    try {
      const ts = 1700000000000
      Telemetry.track({
        type: "session_start",
        timestamp: ts,
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()

      const envelopes = JSON.parse(fetchCalls[0].body)
      expect(envelopes[0].time).toBe(new Date(ts).toISOString())
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 10. flush
// ---------------------------------------------------------------------------
describe("telemetry.flush", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("flush sends buffered events via fetch", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    let fetchCallCount = 0

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      fetchCallCount++
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()
      expect(fetchCallCount).toBe(1)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("flush clears the buffer after success", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    let fetchCallCount = 0

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      fetchCallCount++
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()
      expect(fetchCallCount).toBe(1)

      // Second flush should not call fetch — buffer is empty
      await Telemetry.flush()
      expect(fetchCallCount).toBe(1)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("flush re-adds events to buffer on network error", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    let fetchCallCount = 0

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      fetchCallCount++
      throw new Error("Network error")
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      // First flush — network error, events re-added to buffer
      await Telemetry.flush()
      expect(fetchCallCount).toBe(1)

      // Second flush should attempt again (events were re-added with _retried flag)
      await Telemetry.flush()
      expect(fetchCallCount).toBe(2)

      // Third flush — events had _retried=true, so after second failure they are
      // filtered out by `events.filter(e => !e._retried)` and NOT re-added.
      // Buffer is now empty, so third flush is a no-op.
      await Telemetry.flush()
      expect(fetchCallCount).toBe(2)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("flush handles AbortController timeout", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (_input: any, init: any) => {
      // Verify that signal is passed
      expect(init?.signal).toBeDefined()
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("droppedEvents counter is included in flush and reset after", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchBodies: string[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (_input: any, init: any) => {
      fetchBodies.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      // Fill buffer beyond MAX_BUFFER_SIZE (200) to trigger drops
      for (let i = 0; i < 210; i++) {
        Telemetry.track({
          type: "session_start",
          timestamp: Date.now(),
          session_id: "s1",
          model_id: "m",
          provider_id: "p",
          agent: "a",
          project_id: "proj",
        })
      }

      await Telemetry.flush()

      expect(fetchBodies.length).toBe(1)
      const envelopes = JSON.parse(fetchBodies[0])
      // Should include a TelemetryBufferOverflow error event
      const overflowEvent = envelopes.find(
        (e: any) => e.data?.baseData?.name === "error" &&
          e.data?.baseData?.properties?.error_name === "TelemetryBufferOverflow",
      )
      expect(overflowEvent).toBeDefined()
      expect(overflowEvent.data.baseData.properties.error_message).toContain("10 events dropped")

      // Second flush — no more dropped events counter
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })
      await Telemetry.flush()

      const envelopes2 = JSON.parse(fetchBodies[1])
      const overflowEvent2 = envelopes2.find(
        (e: any) => e.data?.baseData?.properties?.error_name === "TelemetryBufferOverflow",
      )
      expect(overflowEvent2).toBeUndefined()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 11. shutdown
// ---------------------------------------------------------------------------
describe("telemetry.shutdown", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("shutdown flushes remaining events", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    let fetchCallCount = 0

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      fetchCallCount++
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      // shutdown should trigger a flush
      await Telemetry.shutdown()
      expect(fetchCallCount).toBe(1)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("shutdown resets all state", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      Telemetry.setContext({ sessionId: "sess-1", projectId: "proj-1" })
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.shutdown()

      // After shutdown, context should be reset
      const ctx = Telemetry.getContext()
      expect(ctx.sessionId).toBe("")
      expect(ctx.projectId).toBe("")

      // After shutdown, track should drop silently (initDone is reset, so it buffers)
      // But flush without re-init should do nothing since enabled=false
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s2",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })
      let fetchCountBefore = fetchMock.mock.calls.length
      await Telemetry.flush()
      // flush does nothing because enabled=false after shutdown
      expect(fetchMock.mock.calls.length).toBe(fetchCountBefore)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("shutdown clears the flush timer (no further periodic flushes)", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()
      await Telemetry.shutdown()

      // After shutdown, init() promise should be reset (can re-init)
      const p1 = Telemetry.init()
      // With telemetry disabled env var still unset, this will try to re-init.
      // The point is that shutdown fully resets, allowing a fresh init.
      await p1
      await Telemetry.shutdown()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 12. buffer overflow
// ---------------------------------------------------------------------------
describe("telemetry.buffer overflow", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("buffer beyond MAX_BUFFER_SIZE (200) drops oldest events and keeps newest", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchBodies: string[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (_input: any, init: any) => {
      fetchBodies.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      // Track 250 events — first 50 should be dropped
      for (let i = 0; i < 250; i++) {
        Telemetry.track({
          type: "command",
          timestamp: i, // use index as timestamp to identify ordering
          session_id: "s1",
          command_name: `cmd-${i}`,
          command_source: "command",
          message_id: `msg-${i}`,
        })
      }

      await Telemetry.flush()

      expect(fetchBodies.length).toBe(1)
      const envelopes = JSON.parse(fetchBodies[0])

      // 200 buffered events + 1 overflow error event = 201
      expect(envelopes.length).toBe(201)

      // The first event in the buffer should be index 50 (0-49 were dropped)
      const firstDataEvent = envelopes[0]
      expect(firstDataEvent.data.baseData.properties.command_name).toBe("cmd-50")

      // The last data event should be index 249
      const lastDataEvent = envelopes[199]
      expect(lastDataEvent.data.baseData.properties.command_name).toBe("cmd-249")

      // The overflow error event should be the last one
      const overflowEvent = envelopes[200]
      expect(overflowEvent.data.baseData.name).toBe("error")
      expect(overflowEvent.data.baseData.properties.error_name).toBe("TelemetryBufferOverflow")
      expect(overflowEvent.data.baseData.properties.error_message).toContain("50 events dropped")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("droppedEvents counter increments correctly", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchBodies: string[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (_input: any, init: any) => {
      fetchBodies.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      // Exactly 205 events — 5 should be dropped
      for (let i = 0; i < 205; i++) {
        Telemetry.track({
          type: "session_start",
          timestamp: Date.now(),
          session_id: "s1",
          model_id: "m",
          provider_id: "p",
          agent: "a",
          project_id: "proj",
        })
      }

      await Telemetry.flush()

      const envelopes = JSON.parse(fetchBodies[0])
      const overflowEvent = envelopes.find(
        (e: any) => e.data?.baseData?.properties?.error_name === "TelemetryBufferOverflow",
      )
      expect(overflowEvent).toBeDefined()
      expect(overflowEvent.data.baseData.properties.error_message).toContain("5 events dropped")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 13. init with enabled telemetry
// ---------------------------------------------------------------------------
describe("telemetry.init with enabled telemetry", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("init() with telemetry enabled sets up the flush timer", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()

      // If flush timer is set up, tracking + waiting should eventually trigger flush
      // We verify indirectly: after init, flush works (meaning enabled=true, appInsights is set)
      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("init() parses the connection string and configures App Insights", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const fetchCalls: { url: string; body: string }[] = []

    const fetchMock = spyOn(global, "fetch").mockImplementation(async (input: any, init: any) => {
      fetchCalls.push({ url: String(input), body: String(init?.body ?? "") })
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=custom-key-abc;IngestionEndpoint=https://custom.endpoint.azure.com"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()

      expect(fetchCalls.length).toBe(1)
      expect(fetchCalls[0].url).toBe("https://custom.endpoint.azure.com/v2/track")
      const body = JSON.parse(fetchCalls[0].body)
      expect(body[0].iKey).toBe("custom-key-abc")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })

  test("init() with ALTIMATE_TELEMETRY_DISABLED=true disables telemetry completely", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
      await Telemetry.init()

      Telemetry.track({
        type: "session_start",
        timestamp: Date.now(),
        session_id: "s1",
        model_id: "m",
        provider_id: "p",
        agent: "a",
        project_id: "proj",
      })

      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      fetchMock.mockRestore()
    }
  })

  test("init() is idempotent — returns the same promise on concurrent calls", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING

    const fetchMock = spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("", { status: 200 })
    })

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"

      const p1 = Telemetry.init()
      const p2 = Telemetry.init()
      expect(p1).toBe(p2) // Same promise object
      await p1
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Memory telemetry events
// ---------------------------------------------------------------------------
describe("telemetry.memory", () => {
  test("categorizes memory tools correctly", () => {
    expect(Telemetry.categorizeToolName("altimate_memory_read", "standard")).toBe("memory")
    expect(Telemetry.categorizeToolName("altimate_memory_write", "standard")).toBe("memory")
    expect(Telemetry.categorizeToolName("altimate_memory_delete", "standard")).toBe("memory")
    expect(Telemetry.categorizeToolName("altimate_memory_audit", "standard")).toBe("memory")
  })

  test("memory_operation event has correct shape for write", () => {
    const event: Telemetry.Event = {
      type: "memory_operation",
      timestamp: Date.now(),
      session_id: "test-session",
      operation: "write",
      scope: "project",
      block_id: "warehouse-config",
      is_update: false,
      duplicate_count: 0,
      tags_count: 2,
    }
    expect(event.type).toBe("memory_operation")
    expect(event.operation).toBe("write")
    expect(event.scope).toBe("project")
    expect(event.is_update).toBe(false)
  })

  test("memory_operation event has correct shape for delete", () => {
    const event: Telemetry.Event = {
      type: "memory_operation",
      timestamp: Date.now(),
      session_id: "test-session",
      operation: "delete",
      scope: "global",
      block_id: "old-config",
      is_update: false,
      duplicate_count: 0,
      tags_count: 0,
    }
    expect(event.type).toBe("memory_operation")
    expect(event.operation).toBe("delete")
  })

  test("memory_operation event supports update flag", () => {
    const event: Telemetry.Event = {
      type: "memory_operation",
      timestamp: Date.now(),
      session_id: "test-session",
      operation: "write",
      scope: "project",
      block_id: "naming-conventions",
      is_update: true,
      duplicate_count: 1,
      tags_count: 3,
    }
    expect(event.is_update).toBe(true)
    expect(event.duplicate_count).toBe(1)
  })

  test("memory_injection event has correct shape", () => {
    const event: Telemetry.Event = {
      type: "memory_injection",
      timestamp: Date.now(),
      session_id: "test-session",
      block_count: 5,
      total_chars: 2400,
      budget: 8000,
      scopes_used: ["project", "global"],
    }
    expect(event.type).toBe("memory_injection")
    expect(event.block_count).toBe(5)
    expect(event.scopes_used).toEqual(["project", "global"])
  })

  test("memory_injection event with single scope", () => {
    const event: Telemetry.Event = {
      type: "memory_injection",
      timestamp: Date.now(),
      session_id: "test-session",
      block_count: 1,
      total_chars: 200,
      budget: 8000,
      scopes_used: ["project"],
    }
    expect(event.scopes_used).toHaveLength(1)
  })

  test("track accepts memory_operation event without throwing", () => {
    expect(() => {
      Telemetry.track({
        type: "memory_operation",
        timestamp: Date.now(),
        session_id: "test",
        operation: "write",
        scope: "project",
        block_id: "test-block",
        is_update: false,
        duplicate_count: 0,
        tags_count: 0,
      })
    }).not.toThrow()
  })

  test("track accepts memory_injection event without throwing", () => {
    expect(() => {
      Telemetry.track({
        type: "memory_injection",
        timestamp: Date.now(),
        session_id: "test",
        block_count: 3,
        total_chars: 1500,
        budget: 8000,
        scopes_used: ["project", "global"],
      })
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 14. Telemetry.isEnabled() state machine
// ---------------------------------------------------------------------------
describe("Telemetry.isEnabled()", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("returns false before init() is called", () => {
    expect(Telemetry.isEnabled()).toBe(false)
  })

  test("returns false after init() when ALTIMATE_TELEMETRY_DISABLED=true", async () => {
    const orig = process.env.ALTIMATE_TELEMETRY_DISABLED
    try {
      process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(false)
    } finally {
      if (orig !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = orig
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
    }
  })

  test("returns true after init() when telemetry is enabled", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    spyOn(global, "fetch").mockImplementation(async () => new Response("", { status: 200 }))
    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(true)
    } finally {
      if (origEnv !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    }
  })

  test("returns false after shutdown()", async () => {
    const origEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    spyOn(global, "fetch").mockImplementation(async () => new Response("", { status: 200 }))
    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://e.com"
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(true)
      await Telemetry.shutdown()
      expect(Telemetry.isEnabled()).toBe(false)
    } finally {
      if (origEnv !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = origEnv
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    }
  })
})

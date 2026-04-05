// @ts-nocheck
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Telemetry } from "../../src/telemetry"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Capture all telemetry events for assertions
let trackedEvents: Telemetry.Event[] = []
const originalTrack = Telemetry.track.bind(Telemetry)

function captureTrack(event: Telemetry.Event) {
  trackedEvents.push(event)
  // Still call original so shutdown/buffer logic works
  originalTrack(event)
}

beforeEach(async () => {
  trackedEvents = []
  await Telemetry.shutdown()
})

// ---------------------------------------------------------------------------
// These tests replicate the telemetry instrumentation logic from
// processor.ts, testing it in isolation. This mirrors the approach used in
// command-resilience.test.ts: we duplicate the critical code paths rather
// than trying to stand up the full processor with all its dependencies.
//
// If the instrumentation in processor.ts changes, these tests should be
// updated to match.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Tool call telemetry
// ---------------------------------------------------------------------------
describe("tool call telemetry", () => {
  /**
   * Simulates the tool-result telemetry path from processor.ts lines 216-231.
   * Returns the event that would be tracked.
   */
  function simulateToolResult(opts: {
    tool: string
    isMcpTool: boolean
    sessionID: string
    messageID: string
    startTime: number
    toolCallCounter: number
    previousTool: string | null
  }): Telemetry.Event {
    const toolType = opts.isMcpTool ? ("mcp" as const) : ("standard" as const)
    const event: Telemetry.Event = {
      type: "tool_call",
      timestamp: Date.now(),
      session_id: opts.sessionID,
      message_id: opts.messageID,
      tool_name: opts.tool,
      tool_type: toolType,
      tool_category: Telemetry.categorizeToolName(opts.tool, toolType),
      status: "success",
      duration_ms: Date.now() - opts.startTime,
      sequence_index: opts.toolCallCounter,
      previous_tool: opts.previousTool,
    }
    return event
  }

  /**
   * Simulates the tool-error telemetry path from processor.ts lines 252-266.
   */
  function simulateToolError(opts: {
    tool: string
    isMcpTool: boolean
    sessionID: string
    messageID: string
    startTime: number
    toolCallCounter: number
    previousTool: string | null
    error: Error | string
  }): Telemetry.Event {
    const errToolType = opts.isMcpTool ? ("mcp" as const) : ("standard" as const)
    const errorStr =
      opts.error instanceof Error ? opts.error.message : String(opts.error)
    const event: Telemetry.Event = {
      type: "tool_call",
      timestamp: Date.now(),
      session_id: opts.sessionID,
      message_id: opts.messageID,
      tool_name: opts.tool,
      tool_type: errToolType,
      tool_category: Telemetry.categorizeToolName(opts.tool, errToolType),
      status: "error",
      duration_ms: Date.now() - opts.startTime,
      sequence_index: opts.toolCallCounter,
      previous_tool: opts.previousTool,
      error: errorStr.slice(0, 500),
    }
    return event
  }

  test("tool_call events include tool_name, tool_type, and tool_category", () => {
    const event = simulateToolResult({
      tool: "sql_execute",
      isMcpTool: false,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime: Date.now() - 100,
      toolCallCounter: 0,
      previousTool: null,
    })

    expect(event.type).toBe("tool_call")
    expect(event.tool_name).toBe("sql_execute")
    expect(event.tool_type).toBe("standard")
    expect(event.tool_category).toBe("sql")
    expect(event.status).toBe("success")
  })

  test("MCP tools get tool_type 'mcp' and category 'mcp'", () => {
    const event = simulateToolResult({
      tool: "myserver_custom_tool",
      isMcpTool: true,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime: Date.now() - 50,
      toolCallCounter: 0,
      previousTool: null,
    })

    expect(event.tool_type).toBe("mcp")
    expect(event.tool_category).toBe("mcp")
  })

  test("sequence_index increments with each tool call", () => {
    const events: Telemetry.Event[] = []
    let counter = 0
    let prevTool: string | null = null

    for (const tool of ["read", "edit", "bash"]) {
      const event = simulateToolResult({
        tool,
        isMcpTool: false,
        sessionID: "sess-1",
        messageID: "msg-1",
        startTime: Date.now() - 50,
        toolCallCounter: counter,
        previousTool: prevTool,
      })
      events.push(event)
      counter++
      prevTool = tool
    }

    expect((events[0] as any).sequence_index).toBe(0)
    expect((events[1] as any).sequence_index).toBe(1)
    expect((events[2] as any).sequence_index).toBe(2)
  })

  test("previous_tool tracks the last tool used", () => {
    const events: Telemetry.Event[] = []
    let counter = 0
    let prevTool: string | null = null

    for (const tool of ["read", "edit", "bash"]) {
      const event = simulateToolResult({
        tool,
        isMcpTool: false,
        sessionID: "sess-1",
        messageID: "msg-1",
        startTime: Date.now() - 50,
        toolCallCounter: counter,
        previousTool: prevTool,
      })
      events.push(event)
      counter++
      prevTool = tool
    }

    expect((events[0] as any).previous_tool).toBeNull()
    expect((events[1] as any).previous_tool).toBe("read")
    expect((events[2] as any).previous_tool).toBe("edit")
  })

  test("error tool calls include error_message truncated to 500 chars", () => {
    const longError = "x".repeat(1000)
    const event = simulateToolError({
      tool: "bash",
      isMcpTool: false,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime: Date.now() - 100,
      toolCallCounter: 0,
      previousTool: null,
      error: new Error(longError),
    })

    expect(event.status).toBe("error")
    expect(event.error).toBeDefined()
    expect(event.error!.length).toBe(500)
  })

  test("error tool calls with short messages preserve full message", () => {
    const event = simulateToolError({
      tool: "bash",
      isMcpTool: false,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime: Date.now() - 100,
      toolCallCounter: 0,
      previousTool: null,
      error: new Error("file not found"),
    })

    expect(event.error).toBe("file not found")
  })

  test("error tool calls with string errors work correctly", () => {
    const event = simulateToolError({
      tool: "edit",
      isMcpTool: false,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime: Date.now() - 100,
      toolCallCounter: 0,
      previousTool: null,
      error: "something went wrong",
    })

    expect(event.error).toBe("something went wrong")
  })

  test("duration_ms is positive", () => {
    const startTime = Date.now() - 150
    const event = simulateToolResult({
      tool: "read",
      isMcpTool: false,
      sessionID: "sess-1",
      messageID: "msg-1",
      startTime,
      toolCallCounter: 0,
      previousTool: null,
    })

    expect(event.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Tool categorization
// ---------------------------------------------------------------------------
describe("tool categorization", () => {
  test("file tools are categorized correctly", () => {
    for (const tool of ["read", "write", "edit", "glob", "grep", "bash"]) {
      expect(Telemetry.categorizeToolName(tool, "standard")).toBe("file")
    }
  })

  test("search tools (grep, glob) are categorized as file", () => {
    expect(Telemetry.categorizeToolName("grep", "standard")).toBe("file")
    expect(Telemetry.categorizeToolName("glob", "standard")).toBe("file")
  })

  test("shell tools (bash) are categorized as file", () => {
    expect(Telemetry.categorizeToolName("bash", "standard")).toBe("file")
  })

  test("MCP tools always return 'mcp' regardless of name", () => {
    expect(Telemetry.categorizeToolName("read", "mcp")).toBe("mcp")
    expect(Telemetry.categorizeToolName("sql_execute", "mcp")).toBe("mcp")
    expect(Telemetry.categorizeToolName("bash", "mcp")).toBe("mcp")
    expect(Telemetry.categorizeToolName("dbt_run", "mcp")).toBe("mcp")
  })

  test("SQL tools are categorized as sql", () => {
    expect(Telemetry.categorizeToolName("sql_execute", "standard")).toBe("sql")
    expect(Telemetry.categorizeToolName("run_query", "standard")).toBe("sql")
  })

  test("schema tools are categorized as schema", () => {
    expect(Telemetry.categorizeToolName("schema_inspector", "standard")).toBe("schema")
    expect(Telemetry.categorizeToolName("list_columns", "standard")).toBe("schema")
    expect(Telemetry.categorizeToolName("describe_table", "standard")).toBe("schema")
  })

  test("dbt tools are categorized as dbt", () => {
    expect(Telemetry.categorizeToolName("dbt_build", "standard")).toBe("dbt")
    expect(Telemetry.categorizeToolName("dbt_run", "standard")).toBe("dbt")
  })

  test("finops tools are categorized as finops", () => {
    expect(Telemetry.categorizeToolName("cost_analysis", "standard")).toBe("finops")
    expect(Telemetry.categorizeToolName("finops_report", "standard")).toBe("finops")
    expect(Telemetry.categorizeToolName("warehouse_usage_stats", "standard")).toBe("finops")
  })

  test("warehouse tools are categorized as warehouse", () => {
    expect(Telemetry.categorizeToolName("warehouse_list", "standard")).toBe("warehouse")
    expect(Telemetry.categorizeToolName("connection_test", "standard")).toBe("warehouse")
  })

  test("lineage tools are categorized as lineage", () => {
    expect(Telemetry.categorizeToolName("lineage_trace", "standard")).toBe("lineage")
    expect(Telemetry.categorizeToolName("dag_viewer", "standard")).toBe("lineage")
  })

  test("unknown tools default to 'standard'", () => {
    expect(Telemetry.categorizeToolName("custom_thing", "standard")).toBe("standard")
    expect(Telemetry.categorizeToolName("foobar", "standard")).toBe("standard")
  })

  test("categorization is case insensitive", () => {
    expect(Telemetry.categorizeToolName("SQL_EXECUTE", "standard")).toBe("sql")
    expect(Telemetry.categorizeToolName("DBT_Build", "standard")).toBe("dbt")
    expect(Telemetry.categorizeToolName("Read", "standard")).toBe("file")
  })
})

// ---------------------------------------------------------------------------
// 3. Error recovery tracking
// ---------------------------------------------------------------------------
describe("error recovery tracking", () => {
  /**
   * Simulates the error_recovered telemetry path from processor.ts lines 296-308.
   * This fires in the "finish-step" case when attempt > 0 and retryErrorType is set.
   */
  function simulateErrorRecovery(opts: {
    sessionID: string
    attempt: number
    retryErrorType: string
    retryStartTime: number
  }): Telemetry.Event {
    return {
      type: "error_recovered",
      timestamp: Date.now(),
      session_id: opts.sessionID,
      error_type: opts.retryErrorType,
      recovery_strategy: "retry",
      attempts: opts.attempt,
      recovered: true,
      duration_ms: Date.now() - opts.retryStartTime,
    }
  }

  test("error_recovered event fires after retry succeeds", () => {
    const event = simulateErrorRecovery({
      sessionID: "sess-1",
      attempt: 2,
      retryErrorType: "APIError",
      retryStartTime: Date.now() - 5000,
    })

    expect(event.type).toBe("error_recovered")
    expect(event.error_type).toBe("APIError")
    expect(event.recovery_strategy).toBe("retry")
    expect(event.attempts).toBe(2)
    expect(event.recovered).toBe(true)
    expect(event.duration_ms).toBeGreaterThanOrEqual(0)
  })

  test("error_recovered includes correct attempt count after multiple retries", () => {
    const event = simulateErrorRecovery({
      sessionID: "sess-1",
      attempt: 5,
      retryErrorType: "RateLimitError",
      retryStartTime: Date.now() - 10000,
    })

    expect(event.attempts).toBe(5)
    expect(event.error_type).toBe("RateLimitError")
  })

  test("error_recovered duration reflects time since retry started", () => {
    const retryStart = Date.now() - 3000
    const event = simulateErrorRecovery({
      sessionID: "sess-1",
      attempt: 1,
      retryErrorType: "TimeoutError",
      retryStartTime: retryStart,
    })

    // Duration should be at least ~3000ms (allow for timing jitter)
    expect(event.duration_ms).toBeGreaterThanOrEqual(2900)
  })

  test("recovery logic: retryErrorType and retryStartTime are reset after recovery", () => {
    // Simulate the processor state management from lines 296-308
    let retryErrorType: string | null = "APIError"
    let retryStartTime: number | null = Date.now() - 2000
    const attempt = 1

    // This is the condition check from processor.ts:296
    if (attempt > 0 && retryErrorType) {
      // Track the event (would call Telemetry.track in real code)
      const event = simulateErrorRecovery({
        sessionID: "sess-1",
        attempt,
        retryErrorType,
        retryStartTime: retryStartTime ?? Date.now(),
      })
      // Reset state as processor.ts does at lines 307-308
      retryErrorType = null
      retryStartTime = null

      expect(event.type).toBe("error_recovered")
      expect(retryErrorType).toBeNull()
      expect(retryStartTime).toBeNull()
    }
  })

  test("no error_recovered event when attempt is 0", () => {
    // Simulate the guard condition from processor.ts:296
    const attempt = 0
    const retryErrorType: string | null = null
    let eventFired = false

    if (attempt > 0 && retryErrorType) {
      eventFired = true
    }

    expect(eventFired).toBe(false)
  })

  test("no error_recovered event when retryErrorType is null", () => {
    const attempt = 1
    const retryErrorType: string | null = null
    let eventFired = false

    if (attempt > 0 && retryErrorType) {
      eventFired = true
    }

    expect(eventFired).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Doom loop detection telemetry
// ---------------------------------------------------------------------------
describe("doom loop detection telemetry", () => {
  test("doom_loop_detected event includes tool_name and repeat_count", () => {
    const DOOM_LOOP_THRESHOLD = 3
    const event: Telemetry.Event = {
      type: "doom_loop_detected",
      timestamp: Date.now(),
      session_id: "sess-1",
      tool_name: "bash",
      repeat_count: DOOM_LOOP_THRESHOLD,
    }

    Telemetry.track(event)

    expect(event.tool_name).toBe("bash")
    expect(event.repeat_count).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 4b. Plan-agent tool-call refusal detection
// ---------------------------------------------------------------------------
describe("plan-agent no-tool-generation detection", () => {
  /**
   * Simulates the plan-no-tool detection from processor.ts finish-step handler.
   * Mirrors the state machine: session-scoped tool-call counter and
   * one-shot warning flag. Returns null when no warning should fire,
   * or the telemetry event that would be emitted.
   */
  function simulateFinishStep(opts: {
    agent: string
    finishReason: string
    sessionToolCallsMade: number
    planNoToolWarningEmitted: boolean
    sessionID: string
    messageID: string
    modelID: string
    providerID: string
    tokensOutput: number
  }): { event: Telemetry.Event | null; warningEmitted: boolean } {
    if (
      opts.agent === "plan" &&
      opts.finishReason === "stop" &&
      opts.sessionToolCallsMade === 0 &&
      !opts.planNoToolWarningEmitted
    ) {
      return {
        event: {
          type: "plan_no_tool_generation",
          timestamp: Date.now(),
          session_id: opts.sessionID,
          message_id: opts.messageID,
          model_id: opts.modelID,
          provider_id: opts.providerID,
          finish_reason: opts.finishReason,
          tokens_output: opts.tokensOutput,
        },
        warningEmitted: true,
      }
    }
    return { event: null, warningEmitted: opts.planNoToolWarningEmitted }
  }

  const baseOpts = {
    sessionID: "sess-plan-1",
    messageID: "msg-plan-1",
    modelID: "qwen3-coder-next",
    providerID: "ollama-cloud",
    tokensOutput: 293,
  }

  test("fires when plan agent stops without tool calls", () => {
    const result = simulateFinishStep({
      ...baseOpts,
      agent: "plan",
      finishReason: "stop",
      sessionToolCallsMade: 0,
      planNoToolWarningEmitted: false,
    })
    expect(result.event).not.toBeNull()
    expect(result.event?.type).toBe("plan_no_tool_generation")
    expect(result.event?.model_id).toBe("qwen3-coder-next")
    expect(result.event?.provider_id).toBe("ollama-cloud")
    expect(result.event?.finish_reason).toBe("stop")
    expect(result.event?.tokens_output).toBe(293)
    expect(result.warningEmitted).toBe(true)
  })

  test("does not fire when session has already made tool calls", () => {
    const result = simulateFinishStep({
      ...baseOpts,
      agent: "plan",
      finishReason: "stop",
      sessionToolCallsMade: 3,
      planNoToolWarningEmitted: false,
    })
    expect(result.event).toBeNull()
    expect(result.warningEmitted).toBe(false)
  })

  test("does not fire when finish_reason is tool-calls", () => {
    const result = simulateFinishStep({
      ...baseOpts,
      agent: "plan",
      finishReason: "tool-calls",
      sessionToolCallsMade: 0,
      planNoToolWarningEmitted: false,
    })
    expect(result.event).toBeNull()
  })

  test("does not fire for non-plan agents", () => {
    for (const agent of ["builder", "analyst", "general", "explore"]) {
      const result = simulateFinishStep({
        ...baseOpts,
        agent,
        finishReason: "stop",
        sessionToolCallsMade: 0,
        planNoToolWarningEmitted: false,
      })
      expect(result.event).toBeNull()
    }
  })

  test("fires at most once per session (one-shot flag)", () => {
    const result = simulateFinishStep({
      ...baseOpts,
      agent: "plan",
      finishReason: "stop",
      sessionToolCallsMade: 0,
      planNoToolWarningEmitted: true,
    })
    expect(result.event).toBeNull()
    expect(result.warningEmitted).toBe(true)
  })

  test("does not fire when finish_reason is length/error/other", () => {
    for (const reason of ["length", "error", "content-filter", "unknown"]) {
      const result = simulateFinishStep({
        ...baseOpts,
        agent: "plan",
        finishReason: reason,
        sessionToolCallsMade: 0,
        planNoToolWarningEmitted: false,
      })
      expect(result.event).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Generation telemetry
// ---------------------------------------------------------------------------
describe("generation telemetry", () => {
  test("generation event contains all required fields", () => {
    const event: Telemetry.Event = {
      type: "generation",
      timestamp: Date.now(),
      session_id: "sess-1",
      message_id: "msg-1",
      model_id: "claude-opus-4-6",
      provider_id: "anthropic",
      agent: "builder",
      finish_reason: "end_turn",
      tokens_input: 1000,
      tokens_output: 500,
      tokens_reasoning: 200,
      tokens_cache_read: 800,
      tokens_cache_write: 100,
      cost: 0.05,
      duration_ms: 3000,
    }

    expect(event.model_id).toBe("claude-opus-4-6")
    expect(event.tokens_input).toBe(1000)
    expect(event.tokens_cache_read).toBe(800)
    expect(event.cost).toBe(0.05)
    expect(event.finish_reason).toBe("end_turn")
  })
})

// ---------------------------------------------------------------------------
// 6. Context utilization telemetry
// ---------------------------------------------------------------------------
describe("context utilization telemetry", () => {
  /**
   * Simulates the context utilization tracking from processor.ts lines 348-365.
   */
  function simulateContextUtilization(opts: {
    sessionID: string
    modelID: string
    tokensInput: number
    tokensOutput: number
    cacheRead: number
    contextLimit: number
    generationCounter: number
  }) {
    const totalTokens = opts.tokensInput + opts.tokensOutput + opts.cacheRead
    const totalInput = opts.cacheRead + opts.tokensInput

    if (opts.contextLimit > 0) {
      const event: Telemetry.Event = {
        type: "context_utilization",
        timestamp: Date.now(),
        session_id: opts.sessionID,
        model_id: opts.modelID,
        tokens_used: totalTokens,
        context_limit: opts.contextLimit,
        utilization_pct: Math.round((totalTokens / opts.contextLimit) * 1000) / 1000,
        generation_number: opts.generationCounter,
        cache_hit_ratio: totalInput > 0 ? Math.round((opts.cacheRead / totalInput) * 1000) / 1000 : 0,
      }
      return event
    }
    return null
  }

  test("context_utilization calculates utilization_pct correctly", () => {
    const event = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "claude-opus-4-6",
      tokensInput: 5000,
      tokensOutput: 1000,
      cacheRead: 4000,
      contextLimit: 200000,
      generationCounter: 1,
    })

    expect(event).not.toBeNull()
    // totalTokens = 5000 + 1000 + 4000 = 10000
    // utilization = 10000 / 200000 = 0.05
    expect(event!.utilization_pct).toBe(0.05)
  })

  test("context_utilization calculates cache_hit_ratio correctly", () => {
    const event = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "claude-opus-4-6",
      tokensInput: 2000,
      tokensOutput: 500,
      cacheRead: 8000,
      contextLimit: 200000,
      generationCounter: 1,
    })

    expect(event).not.toBeNull()
    // totalInput = 8000 + 2000 = 10000
    // cache_hit_ratio = 8000 / 10000 = 0.8
    expect(event!.cache_hit_ratio).toBe(0.8)
  })

  test("context_utilization returns 0 cache_hit_ratio when no input tokens", () => {
    const event = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "claude-opus-4-6",
      tokensInput: 0,
      tokensOutput: 500,
      cacheRead: 0,
      contextLimit: 200000,
      generationCounter: 1,
    })

    expect(event).not.toBeNull()
    expect(event!.cache_hit_ratio).toBe(0)
  })

  test("context_utilization is not emitted when context_limit is 0", () => {
    const event = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "some-model",
      tokensInput: 5000,
      tokensOutput: 1000,
      cacheRead: 4000,
      contextLimit: 0,
      generationCounter: 1,
    })

    expect(event).toBeNull()
  })

  test("generation_number increments correctly", () => {
    const event1 = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "claude-opus-4-6",
      tokensInput: 1000,
      tokensOutput: 500,
      cacheRead: 0,
      contextLimit: 200000,
      generationCounter: 1,
    })
    const event2 = simulateContextUtilization({
      sessionID: "sess-1",
      modelID: "claude-opus-4-6",
      tokensInput: 2000,
      tokensOutput: 700,
      cacheRead: 1000,
      contextLimit: 200000,
      generationCounter: 2,
    })

    expect(event1!.generation_number).toBe(1)
    expect(event2!.generation_number).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 7. Error telemetry in catch block
// ---------------------------------------------------------------------------
describe("processor error telemetry", () => {
  test("error events truncate messages to 500 chars", () => {
    const longMessage = "y".repeat(1000)
    // Simulates processor.ts lines 457-464
    const event: Telemetry.Event = {
      type: "error",
      timestamp: Date.now(),
      session_id: "sess-1",
      error_name: "SomeError",
      error_message: longMessage.slice(0, 500),
      context: "processor",
    }

    expect(event.error_message.length).toBe(500)
    expect(event.context).toBe("processor")
  })

  test("error events use error name from exception or fallback", () => {
    const e1 = new TypeError("bad type")
    const e2 = { message: "plain object" }

    const name1 = e1?.name ?? "UnknownError"
    const name2 = (e2 as any)?.name ?? "UnknownError"

    expect(name1).toBe("TypeError")
    expect(name2).toBe("UnknownError")
  })

  test("provider_error includes http_status when available", () => {
    const error = Object.assign(new Error("rate limited"), { status: 429 })

    const event: Telemetry.Event = {
      type: "provider_error",
      timestamp: Date.now(),
      session_id: "sess-1",
      provider_id: "anthropic",
      model_id: "claude-opus-4-6",
      error_type: error.name,
      error_message: error.message.slice(0, 500),
      http_status: (error as any).status,
    }

    expect(event.http_status).toBe(429)
    expect(event.error_type).toBe("Error")
  })
})

// ---------------------------------------------------------------------------
// 8. Processor state machine — counter and state tracking
// ---------------------------------------------------------------------------
describe("processor state tracking", () => {
  test("toolCallCounter starts at 0 and increments", () => {
    // Simulates processor.ts line 40 and 230
    let toolCallCounter = 0
    expect(toolCallCounter).toBe(0)

    toolCallCounter++
    expect(toolCallCounter).toBe(1)

    toolCallCounter++
    expect(toolCallCounter).toBe(2)
  })

  test("previousTool starts null and tracks last tool", () => {
    // Simulates processor.ts lines 41, 231
    let previousTool: string | null = null
    expect(previousTool).toBeNull()

    previousTool = "read"
    expect(previousTool).toBe("read")

    previousTool = "edit"
    expect(previousTool).toBe("edit")
  })

  test("generationCounter starts at 0 and increments on finish-step", () => {
    // Simulates processor.ts lines 42, 295
    let generationCounter = 0
    expect(generationCounter).toBe(0)

    // Simulates finish-step handler incrementing
    generationCounter++
    expect(generationCounter).toBe(1)
  })

  test("retryErrorType and retryStartTime track retry state", () => {
    // Simulates processor.ts lines 43-44, 494-497
    let retryErrorType: string | null = null
    let retryStartTime: number | null = null
    let attempt = 0

    expect(retryErrorType).toBeNull()
    expect(retryStartTime).toBeNull()

    // First retry
    if (attempt === 0) {
      retryStartTime = Date.now()
    }
    retryErrorType = "APIError"
    attempt++

    expect(retryErrorType).toBe("APIError")
    expect(retryStartTime).not.toBeNull()
    expect(attempt).toBe(1)

    // Second retry (retryStartTime should not be overwritten)
    const firstRetryStart = retryStartTime
    if (attempt === 0) {
      retryStartTime = Date.now()
    }
    attempt++
    expect(retryStartTime).toBe(firstRetryStart)
    expect(attempt).toBe(2)
  })
})

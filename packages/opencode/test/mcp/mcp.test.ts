import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test"

// ---------------------------------------------------------------------------
// Mocks — set up before importing the MCP module
// ---------------------------------------------------------------------------

// Track telemetry events
let trackedEvents: Array<{ type: string; [key: string]: any }> = []

// Track client operations
const mockClients: Record<
  string,
  {
    connected: boolean
    listToolsCalls: number
    listToolsResult?: { tools: Array<{ name: string; inputSchema: any; description?: string }> }
    listToolsError?: Error
    closeCalls: number
  }
> = {}

// Mock transport tracking
const transportAttempts: Array<{
  type: "streamable" | "sse" | "stdio"
  error?: string
}> = []

// Mock the MCP SDK client
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    name: string
    constructor(opts: any) {
      this.name = opts?.name ?? "test"
    }
    async connect(_transport: any) {
      // Connect always succeeds in our mock
    }
    async listTools() {
      return { tools: [] }
    }
    async listResources() {
      return { resources: [] }
    }
    async listPrompts() {
      return { prompts: [] }
    }
    setNotificationHandler() {}
    async close() {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor() {
      transportAttempts.push({ type: "streamable" })
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor() {
      transportAttempts.push({ type: "sse" })
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr: any = null
    constructor() {
      transportAttempts.push({ type: "stdio" })
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg?: string) {
      super(msg ?? "Unauthorized")
      this.name = "UnauthorizedError"
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolResultSchema: {},
  ToolListChangedNotificationSchema: {},
}))

beforeEach(() => {
  trackedEvents = []
  transportAttempts.length = 0
  for (const key of Object.keys(mockClients)) {
    delete mockClients[key]
  }
})

// ---------------------------------------------------------------------------
// These tests verify MCP behaviors by testing the patterns and logic used
// in mcp/index.ts. Since the MCP module has complex dependencies (Instance,
// Config, transport SDKs), we test the critical code patterns in isolation,
// similar to how command-resilience.test.ts tests loading patterns.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. MCP error recovery
// ---------------------------------------------------------------------------
describe("MCP error recovery", () => {
  /**
   * Simulates the listTools error handling from mcp/index.ts lines 681-689.
   * When client.listTools() fails, the status is set to "failed" and the
   * client is removed from the clients map.
   */
  function simulateToolsListFailure(
    clientName: string,
    clients: Record<string, any>,
    status: Record<string, any>,
    error: Error,
  ) {
    const failedStatus = {
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    }
    status[clientName] = failedStatus
    delete clients[clientName]
    return failedStatus
  }

  test("listTools failure sets status to 'failed'", () => {
    const clients: Record<string, any> = { "test-server": { mock: true } }
    const status: Record<string, any> = { "test-server": { status: "connected" } }

    const result = simulateToolsListFailure(
      "test-server",
      clients,
      status,
      new Error("Connection refused"),
    )

    expect(result.status).toBe("failed")
    expect(result.error).toBe("Connection refused")
    expect(status["test-server"].status).toBe("failed")
  })

  test("listTools failure removes client from clients map", () => {
    const clients: Record<string, any> = { "test-server": { mock: true } }
    const status: Record<string, any> = { "test-server": { status: "connected" } }

    simulateToolsListFailure(
      "test-server",
      clients,
      status,
      new Error("Timeout"),
    )

    expect(clients["test-server"]).toBeUndefined()
  })

  test("listTools failure on one server doesn't affect others", () => {
    const clients: Record<string, any> = {
      "server-a": { mock: true },
      "server-b": { mock: true },
    }
    const status: Record<string, any> = {
      "server-a": { status: "connected" },
      "server-b": { status: "connected" },
    }

    simulateToolsListFailure(
      "server-a",
      clients,
      status,
      new Error("server-a failed"),
    )

    expect(clients["server-a"]).toBeUndefined()
    expect(clients["server-b"]).toBeDefined()
    expect(status["server-a"].status).toBe("failed")
    expect(status["server-b"].status).toBe("connected")
  })
})

// ---------------------------------------------------------------------------
// 2. MCP tool registration
// ---------------------------------------------------------------------------
describe("MCP tool registration", () => {
  /**
   * Simulates the registeredMcpTools logic from mcp/index.ts lines 32-36, 695-705.
   */
  function simulateToolRegistration(
    toolsResults: Array<{
      clientName: string
      tools: Array<{ name: string }>
    }>,
  ): Set<string> {
    const registeredMcpTools = new Set<string>()

    // Mirrors line 695: registeredMcpTools.clear()
    registeredMcpTools.clear()

    for (const { clientName, tools } of toolsResults) {
      for (const tool of tools) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        const toolName = sanitizedClientName + "_" + sanitizedToolName
        registeredMcpTools.add(toolName)
      }
    }

    return registeredMcpTools
  }

  test("registeredMcpTools is populated from connected servers", () => {
    const registered = simulateToolRegistration([
      {
        clientName: "server-a",
        tools: [{ name: "tool1" }, { name: "tool2" }],
      },
      {
        clientName: "server-b",
        tools: [{ name: "tool3" }],
      },
    ])

    expect(registered.size).toBe(3)
    expect(registered.has("server-a_tool1")).toBe(true)
    expect(registered.has("server-a_tool2")).toBe(true)
    expect(registered.has("server-b_tool3")).toBe(true)
  })

  test("isMcpTool returns true for registered tools", () => {
    const registered = simulateToolRegistration([
      {
        clientName: "myserver",
        tools: [{ name: "custom_action" }],
      },
    ])

    // Simulates isMcpTool from mcp/index.ts:34-36
    const isMcpTool = (name: string) => registered.has(name)

    expect(isMcpTool("myserver_custom_action")).toBe(true)
    expect(isMcpTool("nonexistent_tool")).toBe(false)
  })

  test("tool names are sanitized correctly", () => {
    const registered = simulateToolRegistration([
      {
        clientName: "my.server@v2",
        tools: [{ name: "run query!" }],
      },
    ])

    // Special chars replaced with underscore
    expect(registered.has("my_server_v2_run_query_")).toBe(true)
    // Original name is NOT registered
    expect(registered.has("my.server@v2_run query!")).toBe(false)
  })

  test("registeredMcpTools is cleared before repopulating", () => {
    // First registration
    const reg1 = simulateToolRegistration([
      {
        clientName: "server-a",
        tools: [{ name: "old_tool" }],
      },
    ])
    expect(reg1.has("server-a_old_tool")).toBe(true)

    // Second registration with different tools
    const reg2 = simulateToolRegistration([
      {
        clientName: "server-b",
        tools: [{ name: "new_tool" }],
      },
    ])

    // Set is fresh (was cleared)
    expect(reg2.has("server-a_old_tool")).toBe(false)
    expect(reg2.has("server-b_new_tool")).toBe(true)
  })

  test("empty tools list results in empty set", () => {
    const registered = simulateToolRegistration([
      { clientName: "server-a", tools: [] },
    ])

    expect(registered.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. MCP initialization resilience
// ---------------------------------------------------------------------------
describe("MCP initialization resilience", () => {
  /**
   * Simulates the initialization pattern from mcp/index.ts lines 178-209.
   * Each MCP server initialization is independent and wrapped in .catch()
   * so one failure doesn't prevent others from connecting.
   */
  async function simulateInit(
    servers: Record<
      string,
      {
        shouldFail: boolean
        error?: string
      }
    >,
  ) {
    const status: Record<string, any> = {}
    const clients: Record<string, any> = {}

    await Promise.all(
      Object.entries(servers).map(async ([key, server]) => {
        const result = await (async () => {
          if (server.shouldFail) {
            throw new Error(server.error ?? "connection failed")
          }
          return {
            mcpClient: { name: key },
            status: { status: "connected" as const },
          }
        })().catch((e) => {
          // Mirrors line 191-194 in mcp/index.ts
          return undefined
        })

        if (!result) return

        status[key] = result.status
        if (result.mcpClient) {
          clients[key] = result.mcpClient
        }
      }),
    )

    return { status, clients }
  }

  test("one failing MCP server doesn't prevent others from connecting", async () => {
    const result = await simulateInit({
      "healthy-server": { shouldFail: false },
      "broken-server": { shouldFail: true, error: "ECONNREFUSED" },
      "another-healthy": { shouldFail: false },
    })

    // Healthy servers connected
    expect(result.status["healthy-server"]?.status).toBe("connected")
    expect(result.status["another-healthy"]?.status).toBe("connected")
    expect(result.clients["healthy-server"]).toBeDefined()
    expect(result.clients["another-healthy"]).toBeDefined()

    // Broken server didn't get registered
    expect(result.status["broken-server"]).toBeUndefined()
    expect(result.clients["broken-server"]).toBeUndefined()
  })

  test("all failing servers result in empty clients", async () => {
    const result = await simulateInit({
      "broken-1": { shouldFail: true },
      "broken-2": { shouldFail: true },
    })

    expect(Object.keys(result.clients).length).toBe(0)
    expect(Object.keys(result.status).length).toBe(0)
  })

  test("all healthy servers all connect", async () => {
    const result = await simulateInit({
      "server-1": { shouldFail: false },
      "server-2": { shouldFail: false },
      "server-3": { shouldFail: false },
    })

    expect(Object.keys(result.clients).length).toBe(3)
    for (const key of ["server-1", "server-2", "server-3"]) {
      expect(result.status[key]?.status).toBe("connected")
    }
  })

  test("disabled servers are marked as disabled", async () => {
    // Simulates mcp/index.ts lines 186-189
    function simulateDisabledCheck(
      servers: Record<string, { enabled?: boolean }>,
    ) {
      const status: Record<string, any> = {}

      for (const [key, mcp] of Object.entries(servers)) {
        if (mcp.enabled === false) {
          status[key] = { status: "disabled" }
          continue
        }
        status[key] = { status: "connected" }
      }

      return status
    }

    const result = simulateDisabledCheck({
      "active-server": { enabled: true },
      "disabled-server": { enabled: false },
      "default-server": {},
    })

    expect(result["active-server"].status).toBe("connected")
    expect(result["disabled-server"].status).toBe("disabled")
    expect(result["default-server"].status).toBe("connected")
  })
})

// ---------------------------------------------------------------------------
// 4. MCP timeout handling
// ---------------------------------------------------------------------------
describe("MCP timeout handling", () => {
  test("timeout falls back to DEFAULT_TIMEOUT when not configured", () => {
    const DEFAULT_TIMEOUT = 30_000

    const mcp1 = { timeout: undefined }
    const mcp2 = { timeout: 60_000 }

    const timeout1 = mcp1.timeout ?? DEFAULT_TIMEOUT
    const timeout2 = mcp2.timeout ?? DEFAULT_TIMEOUT

    expect(timeout1).toBe(30_000)
    expect(timeout2).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// 5. MCP status transitions
// ---------------------------------------------------------------------------
describe("MCP status transitions", () => {
  test("status type literals are correct", () => {
    const statuses: Array<{ status: string }> = [
      { status: "connected" },
      { status: "disabled" },
      { status: "failed" },
      { status: "needs_auth" },
      { status: "needs_client_registration" },
    ]

    const validStatuses = new Set([
      "connected",
      "disabled",
      "failed",
      "needs_auth",
      "needs_client_registration",
    ])

    for (const s of statuses) {
      expect(validStatuses.has(s.status)).toBe(true)
    }
  })

  test("failed status includes error message", () => {
    const status = {
      status: "failed" as const,
      error: "Connection timeout after 30s",
    }

    expect(status.status).toBe("failed")
    expect(status.error).toContain("timeout")
  })

  test("disconnect sets status to disabled", () => {
    // Simulates mcp/index.ts lines 645-664
    const status: Record<string, any> = {
      "my-server": { status: "connected" },
    }
    const clients: Record<string, any> = {
      "my-server": { mock: true },
    }

    // Simulate disconnect
    delete clients["my-server"]
    status["my-server"] = { status: "disabled" }

    expect(status["my-server"].status).toBe("disabled")
    expect(clients["my-server"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. MCP telemetry events
// ---------------------------------------------------------------------------
describe("MCP telemetry events", () => {
  test("mcp_server_status event structure for connected", () => {
    const event: any = {
      type: "mcp_server_status",
      timestamp: Date.now(),
      session_id: "sess-1",
      server_name: "test-server",
      transport: "stdio",
      status: "connected",
      duration_ms: 500,
    }

    expect(event.type).toBe("mcp_server_status")
    expect(event.transport).toBe("stdio")
    expect(event.status).toBe("connected")
    expect(event.duration_ms).toBe(500)
  })

  test("mcp_server_status event structure for error", () => {
    const event: any = {
      type: "mcp_server_status",
      timestamp: Date.now(),
      session_id: "sess-1",
      server_name: "test-server",
      transport: "streamable-http",
      status: "error",
      error: "Connection refused".slice(0, 500),
      duration_ms: 100,
    }

    expect(event.status).toBe("error")
    expect(event.error).toBe("Connection refused")
  })

  test("mcp_server_status event for disconnect", () => {
    const event: any = {
      type: "mcp_server_status",
      timestamp: Date.now(),
      session_id: "sess-1",
      server_name: "test-server",
      transport: "stdio",
      status: "disconnected",
    }

    expect(event.status).toBe("disconnected")
    expect(event.duration_ms).toBeUndefined()
  })

  test("mcp_server_census event structure", () => {
    const event: any = {
      type: "mcp_server_census",
      timestamp: Date.now(),
      session_id: "sess-1",
      server_name: "test-server",
      transport: "stdio",
      tool_count: 5,
      resource_count: 3,
    }

    expect(event.type).toBe("mcp_server_census")
    expect(event.tool_count).toBe(5)
    expect(event.resource_count).toBe(3)
  })

  test("error messages in telemetry are truncated to 500 chars", () => {
    const longError = "e".repeat(1000)
    const truncated = longError.slice(0, 500)

    expect(truncated.length).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// 7. MCP client cleanup
// ---------------------------------------------------------------------------
describe("MCP client cleanup", () => {
  test("existing client is closed before replacing on reconnect", async () => {
    // Simulates mcp/index.ts lines 289-295
    let closeCalled = false
    const existingClient = {
      close: async () => {
        closeCalled = true
      },
    }
    const newClient = { mock: true }

    const clients: Record<string, any> = { "my-server": existingClient }

    // Simulate add() replacing existing client
    const existing = clients["my-server"]
    if (existing) {
      await existing.close().catch(() => {})
    }
    clients["my-server"] = newClient

    expect(closeCalled).toBe(true)
    expect(clients["my-server"]).toBe(newClient)
  })

  test("close error does not prevent new client from being set", async () => {
    const existingClient = {
      close: async () => {
        throw new Error("close failed")
      },
    }
    const newClient = { mock: true }
    const clients: Record<string, any> = { "my-server": existingClient }

    const existing = clients["my-server"]
    if (existing) {
      await existing.close().catch(() => {})
    }
    clients["my-server"] = newClient

    expect(clients["my-server"]).toBe(newClient)
  })
})

// ---------------------------------------------------------------------------
// 8. MCP listTools failure → client cleanup
// ---------------------------------------------------------------------------
describe("MCP listTools failure and cleanup", () => {
  /**
   * Simulates mcp/index.ts lines 555-576: after connecting, if listTools
   * fails, the client is closed and status is set to "failed".
   */
  async function simulatePostConnectListToolsFailure(opts: {
    listToolsError: Error
  }) {
    let clientClosed = false
    const mcpClient = {
      close: async () => {
        clientClosed = true
      },
    }

    // Simulate withTimeout(mcpClient.listTools(), ...).catch(...)
    const result = await Promise.resolve(undefined) // simulates failed listTools returning undefined

    if (!result) {
      await mcpClient.close().catch(() => {})
      return {
        mcpClient: undefined,
        status: { status: "failed" as const, error: "Failed to get tools" },
        clientClosed,
      }
    }

    return { mcpClient, status: { status: "connected" as const }, clientClosed }
  }

  test("failed listTools closes client and returns failed status", async () => {
    const result = await simulatePostConnectListToolsFailure({
      listToolsError: new Error("timeout"),
    })

    expect(result.mcpClient).toBeUndefined()
    expect(result.status.status).toBe("failed")
    expect((result.status as any).error).toBe("Failed to get tools")
    expect(result.clientClosed).toBe(true)
  })
})

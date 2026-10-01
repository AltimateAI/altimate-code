import { expect, mock, beforeEach } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { testEffect } from "../lib/effect"

// Mock UnauthorizedError to match the SDK's class
class MockUnauthorizedError extends Error {
  constructor(message?: string) {
    super(message ?? "Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown }
}> = []

// Controls whether the mock transport simulates a 401 that triggers the SDK
// auth flow (which calls provider.state()) or a simple UnauthorizedError.
let simulateAuthFlow = true
let connectSucceedsImmediately = false
let serverCapabilities: { tools?: object; resources?: object } = { tools: {} }
let listToolsCalls = 0
// altimate_change start — hold the tool listing open so a lifecycle call can land mid-authenticate
let listToolsGate: { taken: () => void; release: Promise<void> } | undefined
let closedClients = 0
let listToolsFails = false
let tokenExchanges = 0
// altimate_change end

// Mock the transport constructors to simulate OAuth auto-auth on 401
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    authProvider:
      | {
          state?: () => Promise<string>
          redirectToAuthorization?: (url: URL) => Promise<void>
          saveCodeVerifier?: (v: string) => Promise<void>
        }
      | undefined
    constructor(url: URL, options?: { authProvider?: unknown }) {
      this.authProvider = options?.authProvider as typeof this.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      if (connectSucceedsImmediately) return

      // Simulate what the real SDK transport does on 401:
      // It calls auth() which eventually calls provider.state(), then
      // provider.redirectToAuthorization(), then throws UnauthorizedError.
      if (simulateAuthFlow && this.authProvider) {
        // The SDK calls provider.state() to get the OAuth state parameter
        if (this.authProvider.state) {
          await this.authProvider.state()
        }
        // The SDK calls saveCodeVerifier before redirecting
        if (this.authProvider.saveCodeVerifier) {
          await this.authProvider.saveCodeVerifier("test-verifier")
        }
        // The SDK calls redirectToAuthorization to redirect the user
        if (this.authProvider.redirectToAuthorization) {
          await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=test"))
        }
        throw new MockUnauthorizedError()
      }
      throw new MockUnauthorizedError()
    }
    // altimate_change start — count token exchanges
    async finishAuth(_code: string) {
      tokenExchanges++
    }
    // altimate_change end
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock the MCP SDK Client
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    setRequestHandler() {}

    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }

    setNotificationHandler() {}

    getServerCapabilities() {
      return serverCapabilities
    }

    async listTools() {
      listToolsCalls++
      // altimate_change start — see listToolsGate
      const gate = listToolsGate
      listToolsGate = undefined
      if (gate) {
        gate.taken()
        await gate.release
      }
      if (listToolsFails) throw new Error("listing failed")
      // altimate_change end
      return { tools: [{ name: "test_tool", inputSchema: { type: "object", properties: {} } }] }
    }

    async listResources() {
      return { resources: [{ name: "docs", uri: "docs://readme" }] }
    }

    // altimate_change start — see listToolsGate
    async close() {
      closedClients++
    }
    // altimate_change end
  },
}))

// Mock UnauthorizedError in the auth module so instanceof checks work
void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

beforeEach(() => {
  transportCalls.length = 0
  simulateAuthFlow = true
  connectSucceedsImmediately = false
  serverCapabilities = { tools: {} }
  listToolsCalls = 0
  // altimate_change start — see listToolsGate
  listToolsGate = undefined
  closedClients = 0
  listToolsFails = false
  tokenExchanges = 0
  // altimate_change end
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { Config } = await import("../../src/config/config")
const { McpAuth } = await import("../../src/mcp/auth")
const { McpOAuthProvider } = await import("../../src/mcp/oauth-provider")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")

const mcpTest = testEffect(
  Layer.mergeAll(
    MCP.layer.pipe(
      Layer.provide(McpAuth.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
    ),
    McpAuth.defaultLayer,
  ),
)

const config = (name: string) => ({
  mcp: {
    [name]: {
      type: "remote" as const,
      url: "https://example.com/mcp",
    },
  },
})

mcpTest.instance(
  "first connect to OAuth server shows needs_auth instead of failed",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        const result = yield* mcp.add("test-oauth", {
          type: "remote",
          url: "https://example.com/mcp",
        })

        const serverStatus = result.status as Record<string, { status: string; error?: string }>

        // The server should be detected as needing auth, NOT as failed.
        // Before the fix, provider.state() would throw a plain Error
        // ("No OAuth state saved for MCP server: test-oauth") which was
        // not caught as UnauthorizedError, causing status to be "failed".
        expect(serverStatus["test-oauth"]).toBeDefined()
        expect(serverStatus["test-oauth"].status).toBe("needs_auth")
      }),
    ),
  { config: config("test-oauth") },
)

mcpTest.instance("state() generates a new state when none is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-gen",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    const entryBefore = yield* McpAuth.use.get("test-state-gen")
    expect(entryBefore?.oauthState).toBeUndefined()

    // state() should generate and return a new state, not throw
    const state = yield* Effect.promise(() => provider.state())
    expect(typeof state).toBe("string")
    expect(state.length).toBe(64) // 32 bytes as hex

    // The generated state should be persisted
    const entryAfter = yield* McpAuth.use.get("test-state-gen")
    expect(entryAfter?.oauthState).toBe(state)
  }),
)

mcpTest.instance("state() returns existing state when one is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-existing",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    // Pre-save a state
    const existingState = "pre-saved-state-value"
    yield* McpAuth.use.updateOAuthState("test-state-existing", existingState)

    // state() should return the existing state
    const state = yield* Effect.promise(() => provider.state())
    expect(state).toBe(existingState)
  }),
)

mcpTest.instance(
  "authenticate() stores a connected client when auth completes without redirect",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        const added = yield* mcp.add("test-oauth-connect", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        const before = added.status as Record<string, { status: string; error?: string }>
        expect(before["test-oauth-connect"]?.status).toBe("needs_auth")

        simulateAuthFlow = false
        connectSucceedsImmediately = true

        const result = yield* mcp.authenticate("test-oauth-connect")
        expect(result.status).toBe("connected")

        const after = yield* mcp.status()
        expect(after["test-oauth-connect"]?.status).toBe("connected")
      }),
    ),
  { config: config("test-oauth-connect") },
)

mcpTest.instance(
  "authenticate() connects a resource-only server without listing tools",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        const added = yield* mcp.add("test-oauth-resources", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        const before = added.status as Record<string, { status: string }>
        expect(before["test-oauth-resources"]?.status).toBe("needs_auth")

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        serverCapabilities = { resources: {} }

        const result = yield* mcp.authenticate("test-oauth-resources")
        expect(result.status).toBe("connected")
        expect(listToolsCalls).toBe(0)
        expect(Object.keys(yield* mcp.resources())).toEqual(["test-oauth-resources:docs"])
      }),
    ),
  { config: config("test-oauth-resources") },
)

// altimate_change start — the already-authorized path of authenticate() commits a client after
// its own async listing; a remove that lands during the listing is the later call, and wins. (review)
mcpTest.instance(
  "a server removed while authenticate() lists its tools stays removed, and the late client is closed",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.add("test-oauth-removed", { type: "remote", url: "https://example.com/mcp" })

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        let taken!: () => void
        const wasTaken = new Promise<void>((resolve) => (taken = resolve))
        let release!: () => void
        listToolsGate = { taken, release: new Promise<void>((resolve) => (release = resolve)) }
        const closedBefore = closedClients

        const authenticating = yield* Effect.forkChild(mcp.authenticate("test-oauth-removed"))
        yield* Effect.promise(() => wasTaken)
        yield* mcp.remove("test-oauth-removed")
        release()
        const result = yield* Fiber.join(authenticating)

        expect(result.status).toBe("disabled")
        expect((yield* mcp.status())["test-oauth-removed"]?.status).not.toBe("connected")
        expect((yield* mcp.clients())["test-oauth-removed"]).toBeUndefined()
        expect(closedClients).toBe(closedBefore + 1)
      }),
    ),
  { config: config("test-oauth-removed") },
)
// altimate_change end

// altimate_change start — a superseded call reports the newer call's status, whatever its own
// attempt came to: a failed listing, or a completed OAuth connect. (codex)
function gateListTools() {
  let taken!: () => void
  const wasTaken = new Promise<void>((resolve) => (taken = resolve))
  let release!: () => void
  listToolsGate = { taken, release: new Promise<void>((resolve) => (release = resolve)) }
  return { wasTaken, release: () => release() }
}

mcpTest.instance(
  "a superseded authenticate() whose listing fails reports the removal, not the failure",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.add("test-oauth-removed-fail", { type: "remote", url: "https://example.com/mcp" })

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        listToolsFails = true
        const gate = gateListTools()
        const closedBefore = closedClients

        const authenticating = yield* Effect.forkChild(mcp.authenticate("test-oauth-removed-fail"))
        yield* Effect.promise(() => gate.wasTaken)
        yield* mcp.remove("test-oauth-removed-fail")
        gate.release()
        const result = yield* Fiber.join(authenticating)

        expect(result.status).toBe("disabled")
        expect((yield* mcp.clients())["test-oauth-removed-fail"]).toBeUndefined()
        expect(closedClients).toBe(closedBefore + 1)
      }),
    ),
  { config: config("test-oauth-removed-fail") },
)

mcpTest.instance(
  "a superseded finishAuth() reports the removal, and its late client is closed",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.add("test-oauth-finish-removed", { type: "remote", url: "https://example.com/mcp" })
        const started = yield* mcp.startAuth("test-oauth-finish-removed")
        expect(started.authorizationUrl).toBeTruthy()

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        const gate = gateListTools()
        const closedBefore = closedClients

        const finishing = yield* Effect.forkChild(mcp.finishAuth("test-oauth-finish-removed", "code"))
        yield* Effect.promise(() => gate.wasTaken)
        yield* mcp.remove("test-oauth-finish-removed")
        gate.release()
        const result = yield* Fiber.join(finishing)

        expect(result.status).toBe("disabled")
        expect((yield* mcp.status())["test-oauth-finish-removed"]?.status).not.toBe("connected")
        expect((yield* mcp.clients())["test-oauth-finish-removed"]).toBeUndefined()
        expect(closedClients).toBe(closedBefore + 1)
      }),
    ),
  { config: config("test-oauth-finish-removed") },
)
// altimate_change end

// altimate_change start — finishing an OAuth flow continues the call that began it: a disconnect
// or remove issued after startAuth is the later call, so finishAuth must not connect. (review)
mcpTest.instance(
  "a connect issued after startAuth wins: the late finishAuth exchanges nothing",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.add("test-oauth-late-finish", { type: "remote", url: "https://example.com/mcp" })
        const started = yield* mcp.startAuth("test-oauth-late-finish")
        expect(started.authorizationUrl).toBeTruthy()

        // A newer call that leaves the pending flow alone: the server connects without auth.
        simulateAuthFlow = false
        connectSucceedsImmediately = true
        yield* mcp.connect("test-oauth-late-finish")
        expect((yield* mcp.status())["test-oauth-late-finish"]?.status).toBe("connected")

        const result = yield* mcp.finishAuth("test-oauth-late-finish", "code")
        expect(result.status).toBe("connected")
        expect(tokenExchanges).toBe(0)
      }),
    ),
  { config: config("test-oauth-late-finish") },
)

mcpTest.instance(
  "a disconnect drops a pending transport a connect left behind, so finishAuth has nothing to finish",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        // The connect finds the server needs auth and keeps its transport, with no flow recorded.
        const added = yield* mcp.add("test-oauth-connect-left", { type: "remote", url: "https://example.com/mcp" })
        expect((added.status as Record<string, { status: string }>)["test-oauth-connect-left"]?.status).toBe("needs_auth")
        yield* mcp.disconnect("test-oauth-connect-left")

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        const error = yield* mcp.finishAuth("test-oauth-connect-left", "code").pipe(
          Effect.flip,
          Effect.catchDefect((defect) => Effect.succeed(defect)),
        )
        expect(String(error)).toContain("No pending OAuth flow")
        expect(tokenExchanges).toBe(0)
        expect((yield* mcp.clients())["test-oauth-connect-left"]).toBeUndefined()
      }),
    ),
  { config: config("test-oauth-connect-left") },
)

mcpTest.instance(
  "a remove after startAuth drops the pending flow, so finishAuth has nothing to finish",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.add("test-oauth-removed-flow", { type: "remote", url: "https://example.com/mcp" })
        yield* mcp.startAuth("test-oauth-removed-flow")
        yield* mcp.remove("test-oauth-removed-flow")

        simulateAuthFlow = false
        connectSucceedsImmediately = true
        const error = yield* mcp.finishAuth("test-oauth-removed-flow", "code").pipe(
          Effect.flip,
          Effect.catchDefect((defect) => Effect.succeed(defect)),
        )
        expect(String(error)).toContain("No pending OAuth flow")
        expect(tokenExchanges).toBe(0)
        expect((yield* mcp.clients())["test-oauth-removed-flow"]).toBeUndefined()
      }),
    ),
  { config: config("test-oauth-removed-flow") },
)
// altimate_change end

import { test, expect, mock, beforeEach } from "bun:test"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock the transport constructors to capture their arguments
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

beforeEach(() => {
  transportCalls.length = 0
})

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

test("headers are passed to transports when oauth is enabled (default, no Authorization header)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://altimate.ai/config.json",
          mcp: {
            "test-server": {
              type: "remote",
              url: "https://example.com/mcp",
              headers: {
                "X-Custom-Header": "custom-value",
                "X-Trace-Id": "trace-1",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Trigger MCP initialization - it will fail to connect but we can check the transport options
      await MCP.add("test-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          "X-Custom-Header": "custom-value",
          "X-Trace-Id": "trace-1",
        },
      }).catch(() => {})

      // Both transports should have been created with headers
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          "X-Custom-Header": "custom-value",
          "X-Trace-Id": "trace-1",
        })
        // OAuth should be enabled by default when no Authorization header is provided.
        expect(call.options.authProvider).toBeDefined()
      }
    },
  })
})

// altimate_change start — covers the OAuth auto-disable behavior added for
// https://github.com/AltimateAI/altimate-code/issues/792. When the user
// supplies an explicit Authorization header (statically or via headersCommand),
// the OAuth provider is not attached, so a failing OAuth flow (e.g. Microsoft
// Entra ID rejecting RFC 7591 dynamic client registration) cannot pre-empt the
// bearer token.
test("OAuth is auto-disabled when an explicit Authorization header is present", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0
      await MCP.add("auto-disable-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer static-token",
          "X-Custom-Header": "x",
        },
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        expect(call.options.requestInit?.headers).toMatchObject({
          Authorization: "Bearer static-token",
        })
        // No authProvider — OAuth was auto-disabled because user provided bearer.
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

test("OAuth is auto-disabled when Authorization is supplied via headersCommand", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0
      await MCP.add("auto-disable-cmd-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: {
          Authorization: ["printf", "Bearer dynamic-token"],
        },
      } as any).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        expect(call.options.requestInit?.headers).toMatchObject({
          Authorization: "Bearer dynamic-token",
        })
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

test("OAuth still attaches when Authorization header is present but oauth is explicitly configured", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0
      await MCP.add("explicit-oauth-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fallback" },
        oauth: { clientId: "client-xyz" },
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        // User explicitly opted in to OAuth, so provider is attached even
        // though a static Authorization header is also present.
        expect(call.options.authProvider).toBeDefined()
      }
    },
  })
})
// altimate_change end

test("headers are passed to transports when oauth is explicitly disabled", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0

      await MCP.add("test-server-no-oauth", {
        type: "remote",
        url: "https://example.com/mcp",
        oauth: false,
        headers: {
          Authorization: "Bearer test-token",
        },
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

test("no requestInit when headers are not provided", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0

      await MCP.add("test-server-no-headers", {
        type: "remote",
        url: "https://example.com/mcp",
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    },
  })
})

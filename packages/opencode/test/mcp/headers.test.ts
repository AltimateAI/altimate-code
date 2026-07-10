import { describe, expect, mock, beforeEach } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock the transport constructors to capture their arguments
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
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

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
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
const it = testEffect(MCP.defaultLayer)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default, no Authorization header)", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            "X-Custom-Header": "custom-value",
            "X-Trace-Id": "trace-1",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

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
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-oauth", {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: false,
          headers: {
            Authorization: "Bearer test-token",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-headers", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    }),
  )

  // altimate_change start — covers the OAuth auto-disable behavior added for
  // https://github.com/AltimateAI/altimate-code/issues/792. When the user
  // supplies an explicit Authorization header (statically or via headersCommand),
  // the OAuth provider is not attached, so a failing OAuth flow (e.g. Microsoft
  // Entra ID rejecting RFC 7591 dynamic client registration) cannot pre-empt the
  // bearer token.
  it.instance("OAuth is auto-disabled when an explicit Authorization header is present", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("auto-disable-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer static-token",
            "X-Custom-Header": "x",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        expect(call.options.requestInit?.headers).toMatchObject({
          Authorization: "Bearer static-token",
        })
        // No authProvider — OAuth was auto-disabled because user provided bearer.
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.instance("OAuth is auto-disabled when Authorization is supplied via headersCommand", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("auto-disable-cmd-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headersCommand: {
            Authorization: ["printf", "Bearer dynamic-token"],
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        expect(call.options.requestInit?.headers).toMatchObject({
          Authorization: "Bearer dynamic-token",
        })
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.instance("OAuth still attaches when Authorization header is present but oauth is explicitly configured", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("explicit-oauth-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer fallback" },
          oauth: { clientId: "client-xyz" },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        // User explicitly opted in to OAuth, so provider is attached even
        // though a static Authorization header is also present.
        expect(call.options.authProvider).toBeDefined()
      }
    }),
  )

  it.instance("headersCommand overrides a static header that differs only in casing", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("case-merge-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { authorization: "Bearer stale-static", "X-Other": "keep" },
          headersCommand: {
            Authorization: ["printf", "Bearer fresh-dynamic"],
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of transportCalls) {
        // HTTP header names are case-insensitive: only the dynamic value may
        // survive, or two Authorization headers would be sent on the wire.
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer fresh-dynamic",
          "X-Other": "keep",
        })
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.effect(
    "mergeHeaders: dynamic value wins over static key differing only in casing",
    Effect.sync(() => {
      expect(
        MCP._testing.mergeHeaders(
          { authorization: "Bearer stale", "X-Other": "keep" },
          { Authorization: "Bearer fresh" },
        ),
      ).toEqual({
        Authorization: "Bearer fresh",
        "X-Other": "keep",
      })
    }),
  )

  // Covers the auth API surface: `supportsOAuth()` must agree with `create()`'s
  // auto-disable, or `POST /:name/auth` would start an OAuth flow whose tokens
  // the bearer connection never uses.
  it.instance(
    "supportsOAuth mirrors the OAuth auto-disable for bearer-auth servers",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        // Bearer present (statically or via headersCommand), oauth unspecified —
        // connect-time auto-disables OAuth, so the API must not advertise it.
        expect(yield* mcp.supportsOAuth("bearer-static")).toBe(false)
        expect(yield* mcp.supportsOAuth("bearer-cmd")).toBe(false)
        // Explicit opt-in wins even with a bearer header present.
        expect(yield* mcp.supportsOAuth("explicit-oauth")).toBe(true)
        // Defaults unchanged.
        expect(yield* mcp.supportsOAuth("plain-remote")).toBe(true)
        expect(yield* mcp.supportsOAuth("oauth-off")).toBe(false)
      }),
    {
      config: {
        mcp: {
          "bearer-static": {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer static-token" },
          },
          "bearer-cmd": {
            type: "remote",
            url: "https://example.com/mcp",
            headersCommand: { authorization: ["printf", "Bearer dynamic-token"] },
          },
          "explicit-oauth": {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer fallback" },
            oauth: { clientId: "client-xyz" },
          },
          "plain-remote": {
            type: "remote",
            url: "https://example.com/mcp",
          },
          "oauth-off": {
            type: "remote",
            url: "https://example.com/mcp",
            oauth: false,
          },
        },
      },
    },
  )
  // altimate_change end
})

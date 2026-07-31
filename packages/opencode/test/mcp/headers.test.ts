import { describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(LayerNode.compile(MCP.node))

const serve = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Headers[] = []
    const protocol = new Server({ name: "headers", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new Headers(request.headers))
        return transport.handleRequest(request)
      },
    })
    return {
      requests,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default, no Authorization header)", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server", {
        type: "remote",
        url: server.url,
        headers: {
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        },
      })

      expect(result.status).toMatchObject({ "test-server": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
        expect(headers.get("x-custom-header")).toBe("custom-value")
      }
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server-no-oauth", {
        type: "remote",
        url: server.url,
        oauth: false,
        headers: {
          Authorization: "Bearer test-token",
        },
      })

      expect(result.status).toMatchObject({ "test-server-no-oauth": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server-no-headers", {
        type: "remote",
        url: server.url,
      })

      expect(result.status).toMatchObject({ "test-server-no-headers": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.has("authorization")).toBe(false)
        expect(headers.has("x-custom-header")).toBe(false)
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
      const server = yield* serve
      const mcp = yield* MCP.Service
      yield* mcp.add("auto-disable-server", {
        type: "remote",
        url: server.url,
        headers: {
          Authorization: "Bearer static-token",
          "X-Custom-Header": "x",
        },
      })

      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer static-token")
      }
      // No authProvider — OAuth was auto-disabled because user provided bearer.
      expect(yield* mcp.supportsOAuth("auto-disable-server")).toBe(false)
    }),
  )

  it.instance("OAuth is auto-disabled when Authorization is supplied via headersCommand", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      yield* mcp.add("auto-disable-cmd-server", {
        type: "remote",
        url: server.url,
        headersCommand: {
          Authorization: ["printf", "Bearer dynamic-token"],
        },
      })

      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer dynamic-token")
      }
      expect(yield* mcp.supportsOAuth("auto-disable-cmd-server")).toBe(false)
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

      // User explicitly opted in to OAuth, so provider is attached even
      // though a static Authorization header is also present.
      expect(yield* mcp.supportsOAuth("explicit-oauth-server")).toBe(true)
    }),
  )

  it.instance("headersCommand overrides a static header that differs only in casing", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      yield* mcp.add("case-merge-server", {
        type: "remote",
        url: server.url,
        headers: { authorization: "Bearer stale-static", "X-Other": "keep" },
        headersCommand: {
          Authorization: ["printf", "Bearer fresh-dynamic"],
        },
      })

      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        // HTTP header names are case-insensitive: only the dynamic value may
        // survive, or two Authorization headers would be sent on the wire.
        expect(headers.get("authorization")).toBe("Bearer fresh-dynamic")
        expect(headers.get("x-other")).toBe("keep")
      }
      expect(yield* mcp.supportsOAuth("case-merge-server")).toBe(false)
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

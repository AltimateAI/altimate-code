import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

// Assert against the *production* lenient schema directly (exported via
// MCP._testing) so this test can never pass against a stale duplicate. The MCP
// module is already imported dynamically by the resolveHeadersCommand tests
// below, so pulling it in here adds no new import surface.
const { MCP } = await import("../../src/mcp")
const { LenientListToolsResultSchema } = MCP._testing

// ---------------------------------------------------------------------------
// 1. Lenient tools/list schema accepts what real-world servers emit.
// ---------------------------------------------------------------------------
describe("lenient tools/list schema", () => {
  test("accepts null annotation hints (Microsoft Fabric Core MCP behavior)", () => {
    // Real payload shape we observed from https://api.fabric.microsoft.com/v1/mcp/core
    const fabricStyleResponse = {
      tools: [
        {
          name: "list_workspaces",
          description: "Lists all Microsoft fabric workspaces user has access to.",
          inputSchema: { type: "object", properties: {} },
          annotations: {
            title: "List Workspaces",
            readOnlyHint: true,
            destructiveHint: null,
            idempotentHint: null,
            openWorldHint: null,
          },
        },
      ],
    }
    const result = LenientListToolsResultSchema.safeParse(fabricStyleResponse)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toHaveLength(1)
      expect(result.data.tools[0].name).toBe("list_workspaces")
    }
  })

  test("accepts proper boolean annotation hints (compliant servers)", () => {
    const compliantResponse = {
      tools: [
        {
          name: "delete_workspace",
          inputSchema: { type: "object" },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    }
    const result = LenientListToolsResultSchema.safeParse(compliantResponse)
    expect(result.success).toBe(true)
  })

  test("accepts tools without annotations at all", () => {
    const result = LenientListToolsResultSchema.safeParse({
      tools: [{ name: "minimal", inputSchema: {} }],
    })
    expect(result.success).toBe(true)
  })

  test("rejects malformed top-level (missing tools array)", () => {
    expect(LenientListToolsResultSchema.safeParse({ tools: "not-an-array" }).success).toBe(false)
    expect(LenientListToolsResultSchema.safeParse({}).success).toBe(false)
  })

  test("preserves unknown fields via .loose() (forward compatibility)", () => {
    const future = {
      tools: [{ name: "x", inputSchema: {}, futureField: { nested: 1 } }],
      futureTopLevel: "ok",
    }
    const result = LenientListToolsResultSchema.safeParse(future)
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 1b. End-to-end listToolsLenient retry (#792). Locks in the load-bearing
// contract: when the SDK's strict listTools() rejects a Fabric-style payload,
// the rejected error is named `$ZodError` (zod v4-mini), isSchemaError catches
// it, and the lenient client.request() retry returns the tools. A future
// re-narrowing of isSchemaError would break this without tripping the
// schema-only tests above.
// ---------------------------------------------------------------------------
describe("listToolsLenient retry against SDK $ZodError (#792)", () => {
  test("retries with lenient schema when strict listTools() rejects Fabric-style nulls", async () => {
    // Deliberately NOT imported from @modelcontextprotocol/sdk: mcp.test.ts
    // replaces sdk/types.js via mock.module (process-global in bun), so a
    // full-suite run would hand this test a mock without ListToolsResultSchema.
    // Instead, replicate the SDK's strict annotation typing (boolean, null
    // rejected — SDK 1.26.0/1.29.0 ToolAnnotationsSchema) with zod/v4-mini,
    // the same zod build the SDK validates with, so safeParse produces the
    // identical `$ZodError` the real listTools() rejects with.
    const zm = await import("zod/v4-mini")
    const strictAnnotations = zm.object({
      readOnlyHint: zm.optional(zm.boolean()),
      destructiveHint: zm.optional(zm.boolean()),
      idempotentHint: zm.optional(zm.boolean()),
      openWorldHint: zm.optional(zm.boolean()),
    })
    const strictListToolsResult = zm.object({
      tools: zm.array(
        zm.object({
          name: zm.string(),
          inputSchema: zm.any(),
          annotations: zm.optional(strictAnnotations),
        }),
      ),
    })
    // Real payload shape from Microsoft Fabric Core MCP: null annotation hints.
    const fabricPayload = {
      tools: [
        {
          name: "list_workspaces",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: null, idempotentHint: null, openWorldHint: null },
        },
      ],
    }
    // Produce the exact error the SDK would reject with (a `$ZodError`).
    const strict: any = strictListToolsResult.safeParse(fabricPayload)
    expect(strict.success).toBe(false)
    expect(strict.error?.name).toBe("$ZodError")

    let requestCalled = false
    const fakeClient = {
      listTools: async () => {
        throw strict.error
      },
      request: async () => {
        requestCalled = true
        return fabricPayload
      },
    }

    const result = await MCP._testing.listToolsLenient(fakeClient)
    expect(requestCalled).toBe(true)
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe("list_workspaces")
  })

  test("does NOT retry (rethrows) when the error is not a schema error", async () => {
    const transportError = new Error("ECONNREFUSED")
    let requestCalled = false
    const fakeClient = {
      listTools: async () => {
        throw transportError
      },
      request: async () => {
        requestCalled = true
        return { tools: [] }
      },
    }
    await expect(MCP._testing.listToolsLenient(fakeClient)).rejects.toThrow(/ECONNREFUSED/)
    expect(requestCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. McpRemote schema accepts new headersCommand field (issue #791).
// ---------------------------------------------------------------------------
describe("McpRemote.headersCommand schema (#791)", () => {
  test("accepts headersCommand as record of header → argv", () => {
    const argv = ["az", "account", "get-access-token", "--query", "accessToken", "-o", "tsv"]
    const result = Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
      type: "remote",
      url: "https://example.com/mcp",
      headersCommand: { Authorization: argv },
    })
    expect(result.headersCommand).toEqual({ Authorization: argv })
  })

  test("rejects headersCommand with empty argv (would silently no-op at runtime)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: { Authorization: [] },
      }),
    ).toThrow()
  })

  test("rejects array-shaped headers/headersCommand with an actionable invalid_type error", () => {
    // normalizeMcpConfig passes these malformed shapes through unchanged so the
    // schema rejects them loudly instead of the normalizer silently dropping
    // them (which would connect a header-less server with no feedback).
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({ type: "remote", url: "https://x/mcp", headers: ["a", "b"] }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({ type: "remote", url: "https://x/mcp", headersCommand: [["x"]] }),
    ).toThrow()
  })

  test("allows static headers and headersCommand to coexist", () => {
    const result = Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { "X-Trace-Id": "abc" },
      headersCommand: { Authorization: ["echo", "Bearer xyz"] },
    })
    expect(result.headers).toEqual({ "X-Trace-Id": "abc" })
    expect(result.headersCommand).toEqual({ Authorization: ["echo", "Bearer xyz"] })
  })

  test("headersCommand is optional (existing configs still validate)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer static" },
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. headersCommand resolution behavior (#791).
// Tests the actual helper from the MCP module.
// ---------------------------------------------------------------------------
describe("resolveHeadersCommand helper", () => {
  test("returns empty object when spec is undefined", async () => {
    const { MCP } = await import("../../src/mcp")
    const result = await MCP._testing.resolveHeadersCommand(undefined)
    expect(result).toEqual({})
  })

  test("runs argv via execFile and uses trimmed stdout as header value", async () => {
    const { MCP } = await import("../../src/mcp")
    const result = await MCP._testing.resolveHeadersCommand({
      Authorization: ["printf", "Bearer hello-world"],
      "X-Trace": ["printf", "trace-123\n"],
    })
    expect(result.Authorization).toBe("Bearer hello-world")
    expect(result["X-Trace"]).toBe("trace-123")
  })

  test("throws when command emits empty output", async () => {
    const { MCP } = await import("../../src/mcp")
    await expect(MCP._testing.resolveHeadersCommand({ Authorization: ["true"] })).rejects.toThrow(
      /produced empty output/,
    )
  })

  test("throws when command does not exist, naming the failing header", async () => {
    const { MCP } = await import("../../src/mcp")
    // The error must name the specific header so `mcp list` points to the
    // exact failing command rather than a bare ENOENT.
    await expect(
      MCP._testing.resolveHeadersCommand({ Authorization: ["this-binary-does-not-exist-xyz"] }),
    ).rejects.toThrow(/headersCommand\[Authorization\] failed:/)
  })

  test("does not invoke a shell (argv is passed directly to execFile)", async () => {
    // If a shell were used, the metacharacters below would be interpreted.
    // execFile passes argv directly, so the literal string is echoed back.
    const { MCP } = await import("../../src/mcp")
    const result = await MCP._testing.resolveHeadersCommand({
      X: ["printf", "%s", "$(whoami); rm -rf /"],
    })
    expect(result.X).toBe("$(whoami); rm -rf /")
  })

  test("masks bearer tokens leaked to stderr in the failure message", async () => {
    // An auth CLI run with --verbose/--debug can print the token to stderr,
    // and the failure message reaches logs and the status API. The composed
    // message must redact token-shaped values (via Telemetry.maskString).
    const { MCP } = await import("../../src/mcp")
    const token = "sTLeakedTokenValue0123456789abcdef"
    let message = ""
    try {
      await MCP._testing.resolveHeadersCommand({
        Authorization: ["sh", "-c", `echo DEBUG: authorization: Bearer ${token} >&2; exit 1`],
      })
      throw new Error("expected resolveHeadersCommand to reject")
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/headersCommand\[Authorization\] failed:/)
    expect(message).toContain("Bearer ***")
    expect(message).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// 4. Authorization-header detection used to auto-disable OAuth (#792).
// ---------------------------------------------------------------------------
describe("hasAuthorizationHeader helper (#792)", () => {
  test("matches case-insensitively", async () => {
    const { MCP } = await import("../../src/mcp")
    expect(MCP._testing.hasAuthorizationHeader({ Authorization: "Bearer x" })).toBe(true)
    expect(MCP._testing.hasAuthorizationHeader({ authorization: "Bearer x" })).toBe(true)
    expect(MCP._testing.hasAuthorizationHeader({ AUTHORIZATION: "Bearer x" })).toBe(true)
  })

  test("returns false when no auth header is present", async () => {
    const { MCP } = await import("../../src/mcp")
    expect(MCP._testing.hasAuthorizationHeader({})).toBe(false)
    expect(MCP._testing.hasAuthorizationHeader({ "X-Trace": "abc" })).toBe(false)
  })

  test("does not match prefixes that merely contain 'authorization'", async () => {
    const { MCP } = await import("../../src/mcp")
    expect(MCP._testing.hasAuthorizationHeader({ "X-Authorization-Type": "Bearer" })).toBe(false)
    expect(MCP._testing.hasAuthorizationHeader({ "Pre-Authorization": "x" })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. normalizeMcpConfig preserves headersCommand and oauth (round-trip).
//
// Without this, the field-stripping normalizer drops user-supplied values
// silently, leaving the runtime to behave as if the user hadn't configured
// them. See #791 / #792.
// ---------------------------------------------------------------------------
describe("config normalize round-trip", () => {
  test("McpRemote with headersCommand survives Mcp parse", () => {
    // Simulates the post-normalize entry: with our fix, the load path
    // forwards `headersCommand` through into the typed shape.
    const entry = {
      type: "remote" as const,
      url: "https://example.com/mcp",
      headersCommand: { Authorization: ["echo", "Bearer x"] },
    }
    const result = Schema.decodeUnknownSync(ConfigMCPV1.Info)(entry)
    if (result.type === "remote") {
      expect(result.headersCommand).toEqual({ Authorization: ["echo", "Bearer x"] })
    } else {
      throw new Error("expected type: remote")
    }
  })

  test("McpRemote with oauth=false survives Mcp parse", () => {
    const entry = {
      type: "remote" as const,
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: false as const,
    }
    const result = Schema.decodeUnknownSync(ConfigMCPV1.Info)(entry)
    if (result.type === "remote") {
      expect(result.oauth).toBe(false)
    } else {
      throw new Error("expected type: remote")
    }
  })
})

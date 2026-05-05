import { describe, test, expect } from "bun:test"
import z from "zod/v4"
import { Config } from "../../src/config/config"

// We replicate the lenient ListTools schema used in mcp/index.ts here so the
// test does not depend on the MCP module's heavy import surface (Instance,
// Telemetry, Bus, Plugin, etc.). The schema is byte-for-byte identical to
// the one in mcp/index.ts; if it drifts, the integration test in mcp.test.ts
// will catch it.
const LenientToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().nullable().optional(),
    destructiveHint: z.boolean().nullable().optional(),
    idempotentHint: z.boolean().nullable().optional(),
    openWorldHint: z.boolean().nullable().optional(),
  })
  .loose()

const LenientToolSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.any(),
    outputSchema: z.any().optional(),
    annotations: LenientToolAnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

const LenientListToolsResultSchema = z
  .object({
    tools: z.array(LenientToolSchema),
    nextCursor: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

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
// 2. McpRemote schema accepts new headersCommand field (issue #791).
// ---------------------------------------------------------------------------
describe("McpRemote.headersCommand schema (#791)", () => {
  test("accepts headersCommand as record of header → argv", () => {
    const config = {
      type: "remote" as const,
      url: "https://example.com/mcp",
      headersCommand: {
        Authorization: ["az", "account", "get-access-token", "--query", "accessToken", "-o", "tsv"],
      },
    }
    const result = Config.McpRemote.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("rejects headersCommand with empty argv (would silently no-op at runtime)", () => {
    const result = Config.McpRemote.safeParse({
      type: "remote",
      url: "https://example.com/mcp",
      headersCommand: { Authorization: [] },
    })
    expect(result.success).toBe(false)
  })

  test("allows static headers and headersCommand to coexist", () => {
    const config = {
      type: "remote" as const,
      url: "https://example.com/mcp",
      headers: { "X-Trace-Id": "abc" },
      headersCommand: { Authorization: ["echo", "Bearer xyz"] },
    }
    const result = Config.McpRemote.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("headersCommand is optional (existing configs still validate)", () => {
    const result = Config.McpRemote.safeParse({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer static" },
    })
    expect(result.success).toBe(true)
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

  test("throws when command does not exist", async () => {
    const { MCP } = await import("../../src/mcp")
    await expect(
      MCP._testing.resolveHeadersCommand({ Authorization: ["this-binary-does-not-exist-xyz"] }),
    ).rejects.toThrow()
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
      type: "remote",
      url: "https://example.com/mcp",
      headersCommand: { Authorization: ["echo", "Bearer x"] },
    }
    const result = Config.Mcp.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "remote") {
      expect(result.data.headersCommand).toEqual({ Authorization: ["echo", "Bearer x"] })
    }
  })

  test("McpRemote with oauth=false survives Mcp parse", () => {
    const entry = {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: false,
    }
    const result = Config.Mcp.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "remote") {
      expect(result.data.oauth).toBe(false)
    }
  })
})

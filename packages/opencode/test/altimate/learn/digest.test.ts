// altimate_change - new file
import { describe, expect, test } from "bun:test"
import {
  buildDigest,
  DIGEST_CAP,
  hasHighEntropyToken,
  redactSecrets,
  sourceFromMessages,
  sourceFromTrajectory,
} from "../../../src/altimate/learn/digest"

describe("redactSecrets", () => {
  const secrets = [
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdef1234567890XYZ",
    "ghp_abcdefghijklmnop1234",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk",
    "9fK2xQ7LmZ4pW8vB3nR6tY1uC5dH",
  ]
  for (const s of secrets)
    test(`redacts ${s.slice(0, 8)}…`, () => {
      const out = redactSecrets(`before ${s} after`)
      expect(out).not.toContain(s)
      expect(out).toContain("[REDACTED]")
    })

  test("redacts assignments, bearer tokens, URL credentials and private keys", () => {
    expect(redactSecrets("password=hunter2 ok")).toBe("password=[REDACTED] ok")
    expect(redactSecrets('{"api_key": "abc123"}')).not.toContain("abc123")
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop12345")).not.toContain("abcdefghijklmnop12345")
    expect(redactSecrets("postgres://user:pa55w0rd@host/db")).toBe("postgres://user:[REDACTED]@host/db")
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]")
  })

  test("leaves ordinary text and long identifiers alone", () => {
    const t = "Run dbt build for stg_stripe__payments_amount_cents in models/staging, task-queue ok."
    expect(redactSecrets(t)).toBe(t)
    expect(hasHighEntropyToken(t)).toBe(false)
  })
})

describe("buildDigest", () => {
  test("includes prompts, calls, files and final text, truncating call input/output", () => {
    const d = buildDigest({
      prompts: ["Add a staging model for orders"],
      calls: [
        { name: "bash", input: { command: "x".repeat(1000) }, output: "y".repeat(1000) },
        { name: "write", input: { filePath: "models/stg_orders.sql", content: "select 1" }, output: "ok" },
        { name: "bash", input: { command: "dbt build" }, error: "Compilation Error" },
      ],
      finalText: "Done.",
    })
    expect(d).toContain("Add a staging model for orders")
    expect(d).toContain("1. bash(")
    expect(d).toContain("→ ERROR: Compilation Error")
    expect(d).toContain("- models/stg_orders.sql")
    expect(d).toContain("Done.")
    expect(d).not.toContain("x".repeat(400))
    expect(d).not.toContain("y".repeat(401))
    expect(d).toContain("[+")
  })

  test("extracts files from apply_patch text", () => {
    const d = buildDigest({
      prompts: ["p"],
      calls: [{ name: "apply_patch", input: { patchText: "*** Begin Patch\n*** Add File: a/b.sql\n+x\n*** Update File: c.yml\n" } }],
    })
    expect(d).toContain("- a/b.sql")
    expect(d).toContain("- c.yml")
  })

  test("is capped at 24k chars and keeps prompt and final answer", () => {
    const calls = Array.from({ length: 400 }, (_, i) => ({ name: "bash", input: { command: `cmd ${i} ${"a".repeat(250)}` }, output: "o".repeat(500) }))
    const d = buildDigest({ prompts: ["THE TASK"], calls, finalText: "THE END" })
    expect(DIGEST_CAP).toBe(24_000)
    expect(d.length).toBeLessThanOrEqual(DIGEST_CAP)
    expect(d).toContain("THE TASK")
    expect(d).toContain("THE END")
    expect(d).toContain("tool calls omitted")
    expect(d).toContain("1. bash(")
    expect(d).toContain("400. bash(")
  })

  test("redacts secrets everywhere", () => {
    const d = buildDigest({
      prompts: ["use key sk-abcdef1234567890XYZ"],
      calls: [{ name: "bash", input: { command: "export TOKEN=ghp_abcdefghijklmnop1234" }, output: "password=hunter2" }],
      finalText: "AKIAIOSFODNN7EXAMPLE",
    })
    for (const s of ["sk-abcdef1234567890XYZ", "ghp_abcdefghijklmnop1234", "hunter2", "AKIAIOSFODNN7EXAMPLE"]) expect(d).not.toContain(s)
  })
})

describe("sources", () => {
  test("sourceFromTrajectory reads steps, tool calls and prompts", () => {
    const src = sourceFromTrajectory({
      user_prompts: ["do it"],
      steps: [
        { text: "thinking", tool_calls: [{ name: "bash", input: { command: "ls" }, output: "a", status: "completed" }] },
        { text: "final", tool_calls: [{ name: "bash", input: {}, error: "boom", status: "error" }] },
      ],
    })
    expect(src.prompts).toEqual(["do it"])
    expect(src.calls).toHaveLength(2)
    expect(src.calls[1].error).toBe("boom")
    expect(src.finalText).toBe("final")
  })

  test("sourceFromTrajectory rejects other shapes", () => {
    expect(() => sourceFromTrajectory({ nope: 1 })).toThrow("Not a trajectory export")
  })

  test("sourceFromMessages skips synthetic user text and maps tool states", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "real" }, { type: "text", text: "synthetic", synthetic: true }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed", input: { c: 1 }, output: "ok" } },
          { type: "tool", tool: "bash", state: { status: "error", input: { c: 2 }, error: "bad" } },
          { type: "text", text: "all done" },
        ],
      },
    ] as never
    const src = sourceFromMessages(msgs)
    expect(src.prompts).toEqual(["real"])
    expect(src.calls.map((c) => [c.output, c.error])).toEqual([["ok", undefined], [undefined, "bad"]])
    expect(src.finalText).toBe("all done")
  })
})

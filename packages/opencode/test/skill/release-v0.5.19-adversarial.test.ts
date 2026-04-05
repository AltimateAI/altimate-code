/**
 * Adversarial tests for v0.5.19 release features:
 *
 * 1. ${VAR} env-var interpolation (paths.ts) — injection, escaping, ReDoS
 * 2. FileExporter atomic writes + stale tmp sweep (tracing.ts) — race / leaks
 * 3. sql_pre_validation telemetry identifier-leak guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"
import { FileExporter } from "../../src/altimate/observability/tracing"
import fs from "fs/promises"
import os from "os"
import path from "path"

// ─────────────────────────────────────────────────────────────
// 1. ${VAR} env-var interpolation — injection & edge cases
// ─────────────────────────────────────────────────────────────

describe("v0.5.19 release: ${VAR} interpolation adversarial", () => {
  const TEST_VAR = "ALTIMATE_V0519_ADVERSARIAL_VAR"
  const TEST_VAR_2 = "ALTIMATE_V0519_ADVERSARIAL_VAR_2"

  afterEach(() => {
    delete process.env[TEST_VAR]
    delete process.env[TEST_VAR_2]
  })

  test("${VAR} value containing double-quote is JSON-escaped safely", async () => {
    process.env[TEST_VAR] = 'pa"ss'
    const text = `{"password": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    // JSON stays parseable, value round-trips
    expect(result.password).toBe('pa"ss')
  })

  test("${VAR} value containing backslash is JSON-escaped safely", async () => {
    process.env[TEST_VAR] = "C:\\secret\\path"
    const text = `{"p": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("C:\\secret\\path")
  })

  test("${VAR} value containing newline/control char does not break JSON", async () => {
    process.env[TEST_VAR] = "line1\nline2\tend"
    const text = `{"p": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("line1\nline2\tend")
  })

  test("${VAR} value containing JSON-structure chars cannot escape the string", async () => {
    process.env[TEST_VAR] = '","injected":"yes'
    const text = `{"p": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe('","injected":"yes')
    expect(result.injected).toBeUndefined() // cannot inject a new key
  })

  test("substitution is single-pass: ${VAR} expanding to ${OTHER} does NOT re-expand", async () => {
    process.env[TEST_VAR] = "${" + TEST_VAR_2 + "}"
    process.env[TEST_VAR_2] = "SECRET_B"
    const text = `{"p": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    // The literal string "${VAR_2}" comes through — does NOT cascade to SECRET_B
    expect(result.p).toBe("${" + TEST_VAR_2 + "}")
    expect(result.p).not.toBe("SECRET_B")
  })

  test("$${VAR} escape produces literal ${VAR} unchanged", async () => {
    process.env[TEST_VAR] = "should-not-appear"
    const text = `{"p": "$\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("${" + TEST_VAR + "}")
    expect(result.p).not.toContain("should-not-appear")
  })

  test("$${VAR:-default} escape preserves the default clause", async () => {
    const text = '{"p": "$${FOO:-bar}"}'
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("${FOO:-bar}")
  })

  test("${VAR:-default} uses default when VAR unset", async () => {
    delete process.env[TEST_VAR]
    const text = `{"p": "\${${TEST_VAR}:-fallback}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("fallback")
  })

  test("${VAR:-default} uses default when VAR is empty string", async () => {
    process.env[TEST_VAR] = ""
    const text = `{"p": "\${${TEST_VAR}:-fallback}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("fallback")
  })

  test("unresolved ${VAR} without default becomes empty string (documented behavior)", async () => {
    delete process.env[TEST_VAR]
    const text = `{"p": "\${${TEST_VAR}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("")
  })

  test("bare $VAR (no braces) is NOT interpolated", async () => {
    process.env[TEST_VAR] = "SHOULD_NOT_APPEAR"
    const text = `{"p": "$${TEST_VAR}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    // $VAR without braces should be literal (may round-trip via $$ escape → `$VAR`)
    expect(result.p).not.toBe("SHOULD_NOT_APPEAR")
  })

  test("invalid var name with leading digit is not interpolated", async () => {
    // ${1BADNAME} does not match the identifier regex — passes through
    const text = '{"p": "${1BADNAME:-fallback}"}'
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("${1BADNAME:-fallback}")
  })

  test("ReDoS probe: long nested braces do not hang parser", async () => {
    // Craft a pathological input — many nested-looking `${` without valid closes
    const text = '{"p": "' + "${".repeat(200) + '"}'
    const start = Date.now()
    await ConfigPaths.parseText(text, "/fake/config.json").catch(() => {})
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000) // linear regex, must be <1s
  })

  test("many unresolved ${VAR} refs do not crash or leak state", async () => {
    let text = "{"
    for (let i = 0; i < 50; i++) text += `"k${i}": "\${NOT_SET_${i}}",`
    text = text.slice(0, -1) + "}"
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(Object.keys(result)).toHaveLength(50)
    expect(result.k0).toBe("")
    expect(result.k49).toBe("")
  })

  test("${VAR} with default containing escaped characters", async () => {
    const text = '{"p": "${UNSET_VAR:-hello world}"}'
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.p).toBe("hello world")
  })

  test("{env:VAR} legacy syntax still works alongside ${VAR}", async () => {
    process.env[TEST_VAR] = "new-style"
    process.env[TEST_VAR_2] = "legacy"
    const text = `{"a": "\${${TEST_VAR}}", "b": "{env:${TEST_VAR_2}}"}`
    const result = (await ConfigPaths.parseText(text, "/fake/config.json")) as any
    expect(result.a).toBe("new-style")
    expect(result.b).toBe("legacy")
  })
})

// ─────────────────────────────────────────────────────────────
// 2. FileExporter atomic write + stale tmp sweep
// ─────────────────────────────────────────────────────────────

describe("v0.5.19 release: FileExporter tmp file hygiene", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-v0519-tracing-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("successful export leaves no .tmp.* files behind", async () => {
    const exporter = new FileExporter(tmpDir, 100)
    const result = await exporter.export({ sessionId: "ok-session", events: [], meta: {} } as any)
    expect(result).toBeDefined()

    const entries = await fs.readdir(tmpDir)
    const tmpLeft = entries.filter((n) => /\.tmp\./.test(n))
    expect(tmpLeft).toHaveLength(0)
    expect(entries.some((n) => n.includes("ok-session"))).toBe(true)
  })

  test("stale .tmp.* file older than 1 hour is swept on next prune", async () => {
    const exporter = new FileExporter(tmpDir, 5)
    // Seed a "stale" tmp file and backdate mtime by 2 hours
    const stalePath = path.join(tmpDir, "abandoned.json.tmp.1234.abcdef")
    await fs.writeFile(stalePath, "leftover")
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stalePath, twoHoursAgo, twoHoursAgo)

    // Seed enough real json files to trigger pruneOldTraces path (>maxFiles)
    for (let i = 0; i < 7; i++) {
      await exporter.export({ sessionId: `s${i.toString().padStart(3, "0")}`, events: [], meta: {} } as any)
    }
    // pruneOldTraces runs fire-and-forget — give it a tick
    await new Promise((r) => setTimeout(r, 100))

    const exists = await fs
      .stat(stalePath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("fresh .tmp.* file (<1h old) is NOT swept (concurrent writer protection)", async () => {
    const exporter = new FileExporter(tmpDir, 5)
    // Seed a fresh tmp file
    const freshPath = path.join(tmpDir, "inflight.json.tmp.9999.fedcba")
    await fs.writeFile(freshPath, "in-flight")
    // mtime = now, not backdated

    for (let i = 0; i < 7; i++) {
      await exporter.export({ sessionId: `t${i.toString().padStart(3, "0")}`, events: [], meta: {} } as any)
    }
    await new Promise((r) => setTimeout(r, 100))

    const exists = await fs
      .stat(freshPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  test("sessionId with path-traversal chars is sanitized", async () => {
    const exporter = new FileExporter(tmpDir, 10)
    await exporter.export({ sessionId: "../../etc/passwd", events: [], meta: {} } as any)

    // Should NOT have escaped tmpDir
    const entries = await fs.readdir(tmpDir)
    expect(entries.length).toBeGreaterThan(0)
    // Sanitized: slashes, dots, backslashes, colons all replaced
    for (const e of entries) {
      expect(e).not.toContain("/")
      expect(e).not.toContain("\\")
      expect(e.startsWith("..")).toBe(false)
    }
  })

  test("empty sessionId falls back to 'unknown'", async () => {
    const exporter = new FileExporter(tmpDir, 10)
    const result = await exporter.export({ sessionId: "", events: [], meta: {} } as any)
    expect(result).toBeDefined()
    const entries = await fs.readdir(tmpDir)
    expect(entries.some((n) => n.startsWith("unknown"))).toBe(true)
  })

  test("sessionId of only dots/slashes is sanitized (no traversal escape)", async () => {
    const exporter = new FileExporter(tmpDir, 10)
    const result = await exporter.export({ sessionId: "././/..", events: [], meta: {} } as any)
    expect(result).toBeDefined()
    const entries = await fs.readdir(tmpDir)
    // Every char in "/\\.:" is replaced with "_" — no traversal sequence remains
    for (const e of entries) {
      expect(e).not.toContain("..")
      expect(e).not.toContain("/")
      expect(e).not.toContain("\\")
    }
  })

  test("concurrent exports of same sessionId do not leak tmp files", async () => {
    const exporter = new FileExporter(tmpDir, 100)
    await Promise.all([
      exporter.export({ sessionId: "race-session", events: [{ a: 1 } as any], meta: {} } as any),
      exporter.export({ sessionId: "race-session", events: [{ a: 2 } as any], meta: {} } as any),
      exporter.export({ sessionId: "race-session", events: [{ a: 3 } as any], meta: {} } as any),
    ])

    const entries = await fs.readdir(tmpDir)
    const tmpLeft = entries.filter((n) => /\.tmp\./.test(n))
    expect(tmpLeft).toHaveLength(0)
    // Final json file exists, last write wins
    expect(entries.filter((n) => n === "race-session.json")).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────
// 3. sql_pre_validation telemetry — identifier leak guard
// ─────────────────────────────────────────────────────────────

describe("v0.5.19 release: sql_pre_validation telemetry does not leak identifiers", () => {
  test("Telemetry.Event 'sql_pre_validation' shape has no error_message field", async () => {
    // The event schema should have been pruned to prevent identifier leakage.
    // We verify by inspecting source — this test acts as a guard against
    // re-introducing the field without a fresh review.
    const src = await fs.readFile(
      path.join(__dirname, "..", "..", "src", "altimate", "telemetry", "index.ts"),
      "utf-8",
    )
    // Find the sql_pre_validation event block
    const match = src.match(/type:\s*"sql_pre_validation"[\s\S]*?^\s*\}/m)
    expect(match).not.toBeNull()
    expect(match![0]).not.toContain("error_message")
  })

  test("trackPreValidation payload (via source) never includes error_message", async () => {
    const src = await fs.readFile(
      path.join(__dirname, "..", "..", "src", "altimate", "tools", "sql-execute.ts"),
      "utf-8",
    )
    // Extract the trackPreValidation function body
    const fnMatch = src.match(/function trackPreValidation[\s\S]*?\n\}/m)
    expect(fnMatch).not.toBeNull()
    // The telemetry payload should not spread error_message into the track() call
    expect(fnMatch![0]).not.toMatch(/error_message\s*:/m)
    expect(fnMatch![0]).not.toMatch(/\.\.\.\(masked/m)
  })
})

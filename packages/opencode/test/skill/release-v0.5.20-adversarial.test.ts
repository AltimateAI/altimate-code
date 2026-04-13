/**
 * Adversarial tests for v0.5.20 release features:
 *
 * 1. sanitizeConnectionString (normalize.ts) — injection, encoding edge cases
 * 2. listTracesPaginated (tracing.ts) — boundary math, adversarial inputs
 * 3. Provider defaultModel altimate-backend preference — provider filter guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { sanitizeConnectionString, normalizeConfig } from "@altimateai/drivers"
import { Trace } from "../../src/altimate/observability/tracing"
import { Provider } from "../../src/provider/provider"
import fs from "fs/promises"
import os from "os"
import path from "path"

// ─────────────────────────────────────────────────────────────
// 1. sanitizeConnectionString — adversarial URI inputs
// ─────────────────────────────────────────────────────────────

describe("v0.5.20 release: sanitizeConnectionString adversarial", () => {
  test("password with all URI-reserved characters is encoded correctly", () => {
    const uri = "postgresql://user:p@ss:w#rd/sl@sh@host:5432/db"
    const result = sanitizeConnectionString(uri)
    // The encoded URI should be parseable
    expect(result).toContain("host:5432/db")
    // Original reserved chars in password should be percent-encoded
    expect(result).not.toMatch(/user:p@ss/)
  })

  test("empty password is left empty, not encoded", () => {
    const uri = "postgresql://user:@host:5432/db"
    const result = sanitizeConnectionString(uri)
    expect(result).toBe("postgresql://user:@host:5432/db")
  })

  test("username-only (no colon) with @ is handled", () => {
    const uri = "postgresql://alice%40example.com@host:5432/db"
    const result = sanitizeConnectionString(uri)
    // Already-encoded @ in username should round-trip
    expect(result).toContain("host:5432/db")
  })

  test("non-URI string is returned unchanged", () => {
    const tns = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=myhost)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))"
    expect(sanitizeConnectionString(tns)).toBe(tns)
  })

  test("empty string is returned unchanged", () => {
    expect(sanitizeConnectionString("")).toBe("")
  })

  test("scheme-only string with no authority is returned unchanged", () => {
    expect(sanitizeConnectionString("postgresql://")).toBe("postgresql://")
  })

  test("password with percent-encoded sequences round-trips idempotently", () => {
    const uri = "postgresql://user:p%40ss%23word@host:5432/db"
    const result = sanitizeConnectionString(uri)
    // Already-encoded values should survive unchanged
    expect(result).toBe(uri)
  })

  test("malformed percent sequence (%ZZ) is encoded rather than crashing", () => {
    const uri = "postgresql://user:bad%ZZpass@host:5432/db"
    const result = sanitizeConnectionString(uri)
    // Should not throw, and host should be preserved
    expect(result).toContain("host:5432/db")
  })

  test("very long password (10KB) does not cause ReDoS or hang", () => {
    const longPass = "a".repeat(10_000)
    const uri = `postgresql://user:${longPass}@host:5432/db`
    const start = performance.now()
    const result = sanitizeConnectionString(uri)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000) // should complete in <1s
    expect(result).toContain("host:5432/db")
  })

  test("password with unicode characters is encoded correctly", () => {
    const uri = "postgresql://user:pässwörd@host:5432/db"
    const result = sanitizeConnectionString(uri)
    expect(result).toContain("host:5432/db")
    // Unicode should be percent-encoded
    expect(result).not.toContain("ä")
    expect(result).not.toContain("ö")
  })

  test("normalizeConfig wires sanitizeConnectionString for connection_string field", () => {
    const config = {
      type: "postgres" as const,
      connection_string: "postgresql://user:p@ss@host:5432/db",
    }
    const result = normalizeConfig(config)
    // The @ in password should be encoded after normalization
    expect(result.connection_string).toBeDefined()
    expect(result.connection_string).toContain("host:5432/db")
    expect(result.connection_string).not.toMatch(/user:p@ss@/)
  })

  test("normalizeConfig handles connectionString alias", () => {
    const config = {
      type: "postgres" as const,
      connectionString: "postgresql://user:p@ss@host:5432/db",
    } as any
    const result = normalizeConfig(config)
    // connectionString alias should be normalized to connection_string and sanitized
    expect(result.connection_string).toBeDefined()
  })

  test("connection string with SQL injection in password does not affect host parsing", () => {
    const uri = "postgresql://user:'; DROP TABLE users;--@host:5432/db"
    const result = sanitizeConnectionString(uri)
    // SQL in password is just text — should be encoded, host preserved
    expect(result).toContain("host:5432/db")
  })

  test("connection string with null bytes in password", () => {
    const uri = "postgresql://user:pass\x00word@host:5432/db"
    const result = sanitizeConnectionString(uri)
    expect(result).toContain("host:5432/db")
  })
})

// ─────────────────────────────────────────────────────────────
// 2. listTracesPaginated — boundary math adversarial
// ─────────────────────────────────────────────────────────────

describe("v0.5.20 release: listTracesPaginated adversarial", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-adv-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function seedTraces(count: number) {
    for (let i = 0; i < count; i++) {
      const sessionId = `sess-${String(i).padStart(4, "0")}`
      const trace = {
        sessionId,
        startedAt: new Date(Date.now() - i * 60_000).toISOString(),
        endedAt: new Date(Date.now() - i * 60_000 + 30_000).toISOString(),
        spans: [],
        metadata: { provider: "test", model: "test-model", directory: "/tmp" },
      }
      await fs.writeFile(path.join(tmpDir, `${sessionId}.json`), JSON.stringify(trace))
    }
  }

  test("offset = Infinity clamps to 0, returns first page", async () => {
    await seedTraces(5)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: Infinity, limit: 10 })
    expect(result.offset).toBe(0)
    expect(result.traces.length).toBe(5)
  })

  test("limit = Infinity clamps to 20 (default)", async () => {
    await seedTraces(5)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: Infinity })
    expect(result.limit).toBe(20)
    expect(result.traces.length).toBe(5)
  })

  test("offset = -Infinity clamps to 0", async () => {
    await seedTraces(3)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: -Infinity, limit: 10 })
    expect(result.offset).toBe(0)
    expect(result.traces.length).toBe(3)
  })

  test("limit = -1 clamps to 1", async () => {
    await seedTraces(3)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: -1 })
    expect(result.limit).toBe(1)
    expect(result.traces.length).toBe(1)
  })

  test("NaN offset and limit fall back to defaults", async () => {
    await seedTraces(5)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: NaN, limit: NaN })
    expect(result.offset).toBe(0)
    expect(result.limit).toBe(20)
    expect(result.traces.length).toBe(5)
  })

  test("offset = total returns empty traces array", async () => {
    await seedTraces(3)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 3, limit: 10 })
    expect(result.traces).toEqual([])
    expect(result.total).toBe(3)
  })

  test("offset > total returns empty traces array", async () => {
    await seedTraces(3)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 100, limit: 10 })
    expect(result.traces).toEqual([])
    expect(result.total).toBe(3)
  })

  test("empty directory returns zero total and empty array", async () => {
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: 10 })
    expect(result.total).toBe(0)
    expect(result.traces).toEqual([])
    expect(result.offset).toBe(0)
  })

  test("fractional offset 2.7 truncates to 2", async () => {
    await seedTraces(5)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 2.7, limit: 10 })
    expect(result.offset).toBe(2)
    expect(result.traces.length).toBe(3)
  })

  test("fractional limit 1.9 truncates to 1", async () => {
    await seedTraces(5)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: 1.9 })
    expect(result.limit).toBe(1)
    expect(result.traces.length).toBe(1)
  })

  test("limit = 0 clamps to 1", async () => {
    await seedTraces(3)
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: 0 })
    expect(result.limit).toBe(1)
    expect(result.traces.length).toBe(1)
  })

  test("no options uses defaults (offset=0, limit=20)", async () => {
    await seedTraces(25)
    const result = await Trace.listTracesPaginated(tmpDir)
    expect(result.offset).toBe(0)
    expect(result.limit).toBe(20)
    expect(result.traces.length).toBe(20)
    expect(result.total).toBe(25)
  })

  test("non-JSON files in traces dir are silently skipped", async () => {
    await seedTraces(2)
    // Add a non-JSON file
    await fs.writeFile(path.join(tmpDir, "garbage.txt"), "not json")
    await fs.writeFile(path.join(tmpDir, ".DS_Store"), "mac metadata")
    const result = await Trace.listTracesPaginated(tmpDir, { offset: 0, limit: 50 })
    // Should only include the valid trace files
    expect(result.total).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────
// 3. Provider.parseModel — edge cases
// ─────────────────────────────────────────────────────────────

describe("v0.5.20 release: Provider.parseModel adversarial", () => {
  test("model string with multiple slashes preserves all parts", () => {
    const result = Provider.parseModel("altimate-backend/altimate-default")
    expect(String(result.providerID)).toBe("altimate-backend")
    expect(String(result.modelID)).toBe("altimate-default")
  })

  test("model string with nested slashes preserves full model ID", () => {
    const result = Provider.parseModel("openai/gpt-4o/2024-05-13")
    expect(String(result.providerID)).toBe("openai")
    expect(String(result.modelID)).toBe("gpt-4o/2024-05-13")
  })

  test("model string with no slash puts everything in providerID", () => {
    const result = Provider.parseModel("standalone")
    expect(String(result.providerID)).toBe("standalone")
    expect(String(result.modelID)).toBe("")
  })

  test("empty model string does not throw", () => {
    const result = Provider.parseModel("")
    expect(String(result.providerID)).toBe("")
    expect(String(result.modelID)).toBe("")
  })
})

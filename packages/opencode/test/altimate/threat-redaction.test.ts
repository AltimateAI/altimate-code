import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { EngineCoerce } from "../../src/altimate/native/engine-coerce"

let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}
const describeIf = coreAvailable ? describe : describe.skip

describe("redactThreatText", () => {
  test("keeps SQL-statement-keyword types", () => {
    expect(EngineCoerce.redactThreatText("Disallowed statement type: DROP")).toBe("Disallowed statement type: DROP")
    expect(EngineCoerce.redactThreatText("Statement type 'ALTER TABLE' is not in the allowed list")).toBe(
      "Statement type 'ALTER TABLE' is not in the allowed list",
    )
  })

  test("redacts non-SQL content (e.g. /etc/passwd lines)", () => {
    const msg = "Disallowed statement type: ROOT:X:0:0:ROOT:/ROOT:/BIN/BASH"
    expect(EngineCoerce.redactThreatText(msg)).toBe("Disallowed statement type: <non-SQL content redacted>")
    const detail = "Statement type 'ROOT:X:0:0:ROOT:/ROOT:/BIN/BASH' is not in the allowed list: [\"SELECT\"]"
    expect(EngineCoerce.redactThreatText(detail)).toContain("'<non-SQL content redacted>'")
    expect(EngineCoerce.redactThreatText(detail)).not.toContain("ROOT:X:0")
  })

  test("redacts keyword-shaped but non-SQL content (allowlist, not shape)", () => {
    // Shape alone would pass these — the first word must be a SQL statement keyword.
    expect(EngineCoerce.redactThreatText("Disallowed statement type: TOP SECRET PASSWORD")).toBe(
      "Disallowed statement type: <non-SQL content redacted>",
    )
    expect(EngineCoerce.redactThreatText("Disallowed statement type: AKIAIOSFODNN7EXAMPLE")).toBe(
      "Disallowed statement type: <non-SQL content redacted>",
    )
    expect(EngineCoerce.redactThreatText("Statement type 'PRIVATE NOTE' is not in the allowed list")).toBe(
      "Statement type '<non-SQL content redacted>' is not in the allowed list",
    )
  })

  test("embedded apostrophes cannot close the quoted match early", () => {
    // Greedy capture spans to the LAST quote; the embedded quote fails the
    // shape check and everything inside is redacted.
    const attack = "Statement type 'DROP'ROOT:X:0:0' is not in the allowed list"
    const out = EngineCoerce.redactThreatText(attack)
    expect(out).not.toContain("ROOT:X:0")
    expect(out).toContain("<non-SQL content redacted>")
  })

  test("leaves unrelated messages untouched", () => {
    expect(EngineCoerce.redactThreatText("Tautology attack detected (numeric constant comparison)")).toBe(
      "Tautology attack detected (numeric constant comparison)",
    )
  })
})

// Sanity security test [6/15] regression: `altimate check /etc/passwd` must not
// reflect file contents in threat messages (found by the main-only Verdaccio
// sanity job after PR #1090 surfaced real threat messages).
describeIf("safety consumers redact raw-input echoes (real engine)", () => {
  let D: typeof import("../../src/altimate/native/dispatcher")
  let priorTelemetry: string | undefined

  beforeAll(async () => {
    priorTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    const { registerAll } = await import("../../src/altimate/native/altimate-core")
    const { registerAllSql } = await import("../../src/altimate/native/sql/register")
    registerAll()
    registerAllSql()
    D = await import("../../src/altimate/native/dispatcher")
  })

  afterAll(async () => {
    if (priorTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = priorTelemetry
    // registerAll mutates shared Dispatcher state — reset for test isolation.
    ;(await import("../../src/altimate/native/dispatcher")).reset()
  })

  const PASSWD = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"

  test("altimate_core.safety does not echo non-SQL file content", async () => {
    const r = await D.call("altimate_core.safety", { sql: PASSWD })
    expect(r.success).toBe(true)
    const threats = ((r.data as any).threats ?? []) as any[]
    expect(threats.length).toBeGreaterThan(0)
    const text = JSON.stringify(threats)
    expect(text.toLowerCase()).not.toContain("root:x:0")
    expect(text).toContain("redacted")
  })

  test("composite check does not echo non-SQL file content in threats", async () => {
    const r = await D.call("altimate_core.check", { sql: PASSWD })
    expect(r.success).toBe(true)
    // The sanitizer must actually be exercised — an empty threat list would
    // make the not-contains assertion vacuous.
    const threats = (((r.data as any).safety?.threats ?? []) as any[])
    expect(threats.length).toBeGreaterThan(0)
    const text = JSON.stringify(threats)
    expect(text.toLowerCase()).not.toContain("root:x:0")
    expect(text).toContain("redacted")
  })

  test("sql.analyze does not echo non-SQL file content in issues", async () => {
    const r = await D.call("sql.analyze", { sql: PASSWD })
    const text = JSON.stringify((r as any).issues ?? [])
    expect(text.toLowerCase()).not.toContain("root:x:0")
  })

  test("altimate_core.grade nested safety threats are redacted", async () => {
    const r = await D.call("altimate_core.grade", { sql: PASSWD })
    expect(r.success).toBe(true)
    const text = JSON.stringify(((r.data as any).safety?.threats ?? []))
    expect(text.toLowerCase()).not.toContain("root:x:0")
  })

  test("diff-scoping still filters pre-existing multi_statement threats despite redaction", async () => {
    // Regression (cursor review on #1111): redacting BEFORE base subtraction
    // rewrote head matched_patterns to "<redacted>" so base keys never matched
    // and pre-existing threats resurfaced as introduced. Redaction now runs
    // after subtraction: identical base/head must yield zero threats.
    const r = await D.call("altimate_core.check", { sql: PASSWD, base_sql: PASSWD })
    expect((((r.data as any).safety?.threats ?? []) as any[]).length).toBe(0)
    expect((r.data as any).safety.safe).toBe(true)
  })

  test("real SQL statement types are preserved in messages", async () => {
    const r = await D.call("altimate_core.safety", { sql: "SELECT 1; DROP TABLE users;" })
    const threats = ((r.data as any).threats ?? []) as any[]
    const messages = threats.map((t) => `${t.message} ${t.detail}`).join(" ")
    // SQL-keyword statement types stay useful in messages/details
    // (matched_pattern is always redacted for multi_statement by design).
    expect(messages).toContain("DROP")
    expect(messages).not.toContain("redacted")
  })
})

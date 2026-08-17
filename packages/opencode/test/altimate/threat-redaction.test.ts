import { describe, expect, test, beforeAll } from "bun:test"
import { EngineCoerce } from "../../src/altimate/native/engine-coerce"

let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}
const describeIf = coreAvailable ? describe : describe.skip

describe("redactThreatText", () => {
  test("keeps SQL-keyword-like statement types", () => {
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

  test("leaves unrelated messages untouched", () => {
    expect(EngineCoerce.redactThreatText("Tautology attack detected (numeric constant comparison)")).toBe(
      "Tautology attack detected (numeric constant comparison)",
    )
  })
})

// Sanity security test [6/15] regression: `altimate check /etc/passwd` must not
// reflect file contents in threat messages (found by the main-only Verdaccio
// sanity job after PR #1090 surfaced real threat messages).
describeIf("safety handlers redact raw-input echoes (real engine)", () => {
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    const { registerAll } = await import("../../src/altimate/native/altimate-core")
    registerAll()
  })

  const PASSWD = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"

  test("altimate_core.safety does not echo non-SQL file content", async () => {
    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("altimate_core.safety", { sql: PASSWD })
    const text = JSON.stringify((r.data as any).threats ?? [])
    expect(text.toLowerCase()).not.toContain("root:x:0")
    expect(text).toContain("redacted")
  })

  test("composite check does not echo non-SQL file content in threats", async () => {
    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("altimate_core.check", { sql: PASSWD })
    const threats = JSON.stringify(((r.data as any).safety?.threats ?? []))
    expect(threats.toLowerCase()).not.toContain("root:x:0")
  })

  test("real SQL statement types are preserved in messages", async () => {
    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("altimate_core.safety", { sql: "SELECT 1; DROP TABLE users;" })
    const threats = ((r.data as any).threats ?? []) as any[]
    const messages = threats.map((t) => `${t.message} ${t.detail}`).join(" ")
    // SQL-keyword statement types stay useful in messages/details
    // (matched_pattern is always redacted for multi_statement by design).
    expect(messages).toContain("DROP")
    expect(messages).not.toContain("redacted")
  })
})

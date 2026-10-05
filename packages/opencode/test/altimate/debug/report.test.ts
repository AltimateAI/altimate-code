// altimate_change start — debug report analysis
import { describe, expect, test } from "bun:test"
import { analyzeLog, detectProblems, parseLog, redact, renderReport, type Facts } from "../../../src/altimate/debug/report"

const L = (ts: string, level: string, run: string, rest: string) => `timestamp=${ts} level=${level} run=${run} ${rest}`

const SAMPLE = [
  L("2026-10-02T11:07:43.000Z", "INFO", "aaaa1111", 'message="creating instance" directory="C:\\\\Users\\\\jdoe\\\\proj"'),
  L("2026-10-02T11:07:45.000Z", "WARN", "aaaa1111", 'message="server unavailable" key=dbt type=local status=failed error="MCP error -32000: Connection closed"'),
  L("2026-10-02T11:08:00.000Z", "INFO", "bbbb2222", 'service=debug message="tool start" tool=warehouse_test call=call_1'),
  L("2026-10-02T11:08:00.100Z", "INFO", "bbbb2222", 'service=warehouse-sign-in message="browser sign-in" phase=waiting url=https://idp.example.com/sso'),
  L("2026-10-02T11:08:15.000Z", "INFO", "bbbb2222", 'service=debug message="still running" calls=warehouse_test#call_1:15s'),
  L("2026-10-02T11:11:45.000Z", "INFO", "cccc3333", 'message="creating instance" directory="C:\\\\Users\\\\jdoe\\\\proj"'),
  L("2026-10-02T11:11:46.000Z", "WARN", "cccc3333", 'message="server unavailable" key=dbt type=local status=failed error="MCP error -32000: Connection closed"'),
  L("2026-10-02T11:12:00.000Z", "INFO", "dddd4444", 'service=debug message="tool start" tool=sql_execute call=call_2'),
  L("2026-10-02T11:12:01.000Z", "INFO", "dddd4444", 'service=debug message="tool end" tool=sql_execute call=call_2 status=success duration_ms=900'),
  L("2026-10-02T11:12:02.000Z", "WARN", "dddd4444", 'service=warehouse-connect message="connect failed" name=sf category=sso_not_completed'),
  L("2026-10-02T11:12:03.000Z", "WARN", "dddd4444", 'service=telemetry message="event loop stall" thread=worker blocked_ms=42000'),
  L("2026-10-02T11:12:04.000Z", "WARN", "dddd4444", 'message="failed to add snapshot files" exitCode=128 stderr="x"'),
  "not a log line",
].join("\n")

function facts(over: Partial<Facts> = {}): Facts {
  return {
    generatedAt: "2026-10-05T00:00:00.000Z",
    version: "0.12.5",
    os: "Windows_NT 10.0",
    arch: "x64",
    runtime: "Bun 1.3.14",
    terminal: { TERM_PROGRAM: "vscode" },
    proxy: {},
    envFlags: [],
    debugMode: true,
    telemetry: { enabled: true },
    account: { configured: true, instance: "acme", apiHost: "api.myaltimate.com" },
    connections: [],
    mcpServers: [{ name: "dbt", type: "local", enabled: true }],
    network: [],
    logTail: [],
    log: analyzeLog(parseLog(SAMPLE)),
    ...over,
  }
}

describe("redact", () => {
  const ctx = { home: "C:\\Users\\jdoe", username: "jdoe" }
  test("removes secrets, keys, tokens, emails and URL queries", () => {
    // Fake secrets, assembled at run time so secret scanners do not flag this file.
    const pw = ["hun", "ter2"].join("")
    const token = ["abc", "123"].join("")
    const bearer = ["abcdefghij", "0123"].join("")
    const pem = ["-----BEGIN ", "PRIVATE KEY-----\nMIIE\n-----END ", "PRIVATE KEY-----"].join("")
    const out = redact(
      `${"pass" + "word"}=${pw} "${"tok" + "en"}": "${token}" Authorization: Bearer ${bearer} user a.b@corp.example.com ` +
        `https://idp.example.com/sso?SAMLRequest=xyz ${pem}`,
      ctx,
    )
    expect(out).not.toContain(pw)
    expect(out).not.toContain(token)
    expect(out).not.toContain(bearer)
    expect(out).not.toContain("a.b@corp.example.com")
    expect(out).not.toContain("SAMLRequest")
    expect(out).not.toContain("MIIE")
    expect(out).toContain("https://idp.example.com/sso?<query removed>")
  })

  test("replaces the home folder and the user name in every path spelling", () => {
    const out = redact('C:\\Users\\jdoe\\proj "C:\\\\Users\\\\jdoe\\\\x" /c/Users/jdoe/y D:\\work\\jdoe\\z /tmp/-Users-jdoe-proj/x', ctx)
    expect(out).not.toMatch(/jdoe/i)
    // a longer word that merely contains the name is left alone
    expect(redact("jdoes jdoe2 ajdoe", ctx)).toBe("jdoes jdoe2 ajdoe")
    expect(out).toContain("~\\proj")
  })
})

describe("analyzeLog", () => {
  const log = analyzeLog(parseLog(SAMPLE))

  test("counts starts per day, MCP failures, sign-ins, stalls and snapshot errors", () => {
    expect(log.lines).toBe(12)
    expect(log.starts).toBe(2)
    expect(log.startsByDay).toEqual([{ day: "2026-10-02", starts: 2 }])
    expect(log.mcpFailures).toEqual([{ server: "dbt", count: 2, lastError: "MCP error -32000: Connection closed" }])
    expect(log.signIns).toEqual({ waiting: 1, completed: 0, failed: 0 })
    expect(log.stalls).toEqual([{ at: "2026-10-02T11:12:03.000Z", thread: "worker", blockedMs: 42000 }])
    expect(log.snapshotFailures).toBe(1)
    expect(log.connectFailures).toEqual([{ category: "sso_not_completed", count: 1, lastAt: "2026-10-02T11:12:02.000Z" }])
  })

  test("a run whose last trace shows a tool still running is reported as ended mid-tool; a finished one is not", () => {
    expect(log.endedMidTool).toEqual([{ run: "bbbb2222", at: "2026-10-02T11:08:15.000Z", tools: "warehouse_test" }])
    expect(log.debugTracing).toBe(true)
  })

  test("repeats of one warning collapse into one row", () => {
    const mcp = log.problems.find((p) => p.template.startsWith("server unavailable"))
    expect(mcp?.count).toBe(2)
  })
})

describe("detectProblems", () => {
  test("the mid-tool exit and the unfinished sign-in come first, as problems", () => {
    const f = detectProblems(facts())
    expect(f[0].severity).toBe("problem")
    const titles = f.map((x) => x.title)
    expect(titles.some((t) => t.startsWith("Altimate Code ended while a tool was still running (1 time)"))).toBe(true)
    expect(titles).toContain("Browser sign-ins to the warehouse were not completed")
    expect(titles.some((t) => t.startsWith("The app was unresponsive for 30 s or more"))).toBe(true)
  })

  test("a password connection with no password available is a problem", () => {
    const f = detectProblems(facts({ connections: [{ name: "sf", type: "snowflake", auth: "password", fields: ["account", "user"], passwordAvailable: false }] }))
    expect(f.map((x) => x.title)).toContain("Connection 'sf' has no password or other sign-in details")
  })

  test("a connection with no sign-in method at all is a problem, unless it is a local file engine", () => {
    const f = detectProblems(
      facts({
        connections: [
          { name: "bare", type: "snowflake", auth: "unknown", fields: ["account", "user"], passwordAvailable: false },
          { name: "local", type: "duckdb", auth: "unknown", fields: ["path"], passwordAvailable: false },
        ],
      }),
    )
    const titles = f.map((x) => x.title)
    expect(titles).toContain("Connection 'bare' has no password or other sign-in details")
    expect(titles.some((t) => t.includes("'local'"))).toBe(false)
  })

  test("an unreachable host and telemetry being off are reported", () => {
    const f = detectProblems(
      facts({ network: [{ target: "Snowflake (sf)", host: "acme.snowflakecomputing.com", ok: false, detail: "no response within 8 s" }], telemetry: { enabled: false, reason: "ALTIMATE_TELEMETRY_DISABLED is set" } }),
    )
    const titles = f.map((x) => x.title)
    expect(titles).toContain("Cannot reach Snowflake (sf)")
    expect(titles).toContain("Telemetry is off")
  })

  test("without debug traces the report asks for a rerun with debug mode on", () => {
    const f = detectProblems(facts({ debugMode: false, log: analyzeLog(parseLog(SAMPLE.replace(/tool (start|end)/g, "x"))) }))
    expect(f.map((x) => x.title)).toContain("Debug mode was not on")
  })
})

describe("renderReport", () => {
  test("findings lead, and table cells cannot break the table", () => {
    const md = renderReport(facts({ connections: [{ name: "a|b", type: "snowflake", auth: "sso", fields: [] }] }), detectProblems(facts()))
    expect(md.indexOf("## Findings")).toBeLessThan(md.indexOf("## Environment"))
    expect(md).toContain("a\\|b")
  })
})
// altimate_change end

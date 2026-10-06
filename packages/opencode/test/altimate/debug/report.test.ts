// altimate_change start — debug report analysis
import { describe, expect, test } from "bun:test"
import { analyzeLog, detectProblems, parseLog, redact, renderReport, withLiveness, type Facts } from "../../../src/altimate/debug/report"

const L = (ts: string, level: string, run: string, rest: string) => `timestamp=${ts} level=${level} run=${run} ${rest}`

const SAMPLE = [
  L("2026-10-02T11:07:43.000Z", "INFO", "aaaa1111", 'message="creating instance" directory="C:\\\\Users\\\\jdoe\\\\proj"'),
  L("2026-10-02T11:07:45.000Z", "WARN", "aaaa1111", 'message="server unavailable" key=dbt type=local status=failed error="MCP error -32000: Connection closed"'),
  L("2026-10-02T11:07:59.000Z", "INFO", "bbbb2222", 'service=debug message="altimate-code started" version=0.12.5 pid=4242'),
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
    // pid 4242's process is gone: the run really ended mid-tool.
    log: withLiveness(analyzeLog(parseLog(SAMPLE)), () => false),
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

  test("secret keys are matched as suffixes, in any case, quoted or not, and in non-HTTP URLs", () => {
    // Fake values, assembled at run time so secret scanners do not flag this file.
    const v = (n: number) => ["val", "ue", String(n)].join("")
    const k = (...parts: string[]) => parts.join("")
    const input = [
      `${k("client_", "sec", "ret")}=${v(1)}`,
      `${k("access_", "tok", "en")}=${v(2)}`,
      `${k("refresh_", "tok", "en")}: ${v(3)}`,
      `${k("aws_sec", "ret_access_key")}=${v(4)}`,
      `${k("db_pass", "word")}=${v(5)}`,
      `${k("PGPASS", "WORD")}=${v(6)}`,
      `{"${k("access", "Token")}":"${v(7)}"}`,
      `{"${k("client", "Secret")}": "${v(8)}"}`,
      `${k("pass", "word")}="${v(9)} horse ${v(10)}"`,
      `snowflake://acct/db?${k("pass", "word")}=${v(11)}`,
      `jdbc:postgresql://h:5432/db?${k("pass", "word")}=${v(12)}`,
      `snowflake://u:${v(13)}@acct/db`,
    ].join("\n")
    const out = redact(input)
    for (let i = 1; i <= 13; i++) expect(out).not.toContain(v(i))
    // Any scheme's query goes, not only http's: it can carry settings that identify the account.
    expect(redact("snowflake://acct/db?warehouse=W&role=R")).toBe("snowflake://acct/db?<query removed>")
    // Ordinary fields that merely contain a secret word keep their values.
    expect(redact("input_tokens=100 tokens=5 password_available=true")).toBe("input_tokens=100 tokens=5 password_available=true")
  })

  test("a user name that is an ordinary word is replaced only where it is used as a name", () => {
    const c = { username: "code" }
    expect(redact("Altimate code debug report", c)).toBe("Altimate code debug report")
    expect(redact("/Users/code/proj -Users-code-x user=code", c)).toBe("/Users/<user>/proj -Users-<user>-x user=<user>")
  })

  test("the machine's host name is removed, with or without its domain", () => {
    const out = redact("on Janes-MacBook-Pro.local and pid.tty.Janes-MacBook-Pro", { hostname: "Janes-MacBook-Pro.local" })
    expect(out).not.toContain("Janes")
    expect(out).toContain("<host>")
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
    expect(log.lines).toBe(13)
    // Three processes: two older runs known only by their project loads, one with a start line.
    expect(log.starts).toBe(3)
    expect(log.startsByDay).toEqual([{ day: "2026-10-02", starts: 3 }])
    expect(log.mcpFailures).toEqual([{ server: "dbt", count: 2, lastError: "MCP error -32000: Connection closed" }])
    expect(log.signIns).toEqual({ waiting: 1, completed: 0, failed: 0 })
    expect(log.stalls).toEqual([{ at: "2026-10-02T11:12:03.000Z", thread: "worker", blockedMs: 42000 }])
    expect(log.snapshotFailures).toBe(1)
    expect(log.connectFailures).toEqual([{ category: "sso_not_completed", count: 1, lastAt: "2026-10-02T11:12:02.000Z" }])
  })

  test("a run whose last trace shows a tool still running is reported as ended mid-tool; a finished one is not", () => {
    expect(log.endedMidTool).toEqual([{ run: "bbbb2222", at: "2026-10-02T11:08:15.000Z", tools: "warehouse_test", pid: 4242 }])
    expect(log.debugTracing).toBe(true)
  })

  test("a process counts once however many projects it loads; the TUI worker is not a second process", () => {
    const l = analyzeLog(
      parseLog(
        [
          L("2026-10-03T09:00:00.000Z", "INFO", "m1", 'service=debug message="altimate-code started" thread=main pid=1'),
          L("2026-10-03T09:00:01.000Z", "INFO", "w1", 'service=debug message="altimate-code started" thread=worker pid=1'),
          L("2026-10-03T09:00:02.000Z", "INFO", "w1", 'message="creating instance" directory=/a'),
          L("2026-10-03T09:00:03.000Z", "INFO", "w1", 'message="creating instance" directory=/b'),
        ].join("\n"),
      ),
    )
    expect(l.starts).toBe(1)
  })

  test("project loads with no run id are reported on their own, not counted as app starts", () => {
    const l = analyzeLog(
      parseLog(
        [
          'timestamp=2026-10-04T09:00:00.000Z level=INFO message="creating instance" directory=/a',
          'timestamp=2026-10-04T09:00:01.000Z level=INFO message="creating instance" directory=/b',
        ].join("\n"),
      ),
    )
    expect(l.starts).toBe(0)
    expect(l.unattributedLoads).toBe(2)
    expect(renderReport(facts({ log: l }), [])).toContain("plus 2 project loads in older lines that cannot be tied to a process")
  })

  test("debug mode on with no tool calls is not reported as debug mode off", () => {
    const l = analyzeLog(parseLog(L("2026-10-03T09:00:00.000Z", "INFO", "m1", 'service=debug message="altimate-code started" thread=main debug=true pid=1')))
    const titles = detectProblems(facts({ log: l })).map((x) => x.title)
    expect(titles).toContain("Debug mode was on, but no tool calls were traced")
    expect(titles).not.toContain("Debug mode was not on")
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

  test("a run that left a tool unfinished is a problem only if its process has ended", () => {
    const raw = analyzeLog(parseLog(SAMPLE))
    const titles = (alive: (pid: number) => boolean) => detectProblems(facts({ log: withLiveness(raw, alive) })).map((x) => x.title)
    // Still running in another window: the tool may simply still be working.
    expect(titles(() => true).some((t) => t.includes("tool"))).toBe(false)
    expect(titles(() => false).some((t) => t.startsWith("Altimate Code ended while a tool was still running"))).toBe(true)
    // No pid in the log: reported, but as unconfirmed rather than as a crash.
    const noPid = detectProblems(facts({ log: analyzeLog(parseLog(SAMPLE.replace(" pid=4242", ""))) }))
    expect(noPid.some((x) => x.title.startsWith("Altimate Code ended"))).toBe(false)
    const w = noPid.find((x) => x.title.includes("unconfirmed"))
    expect(w?.severity).toBe("warning")
  })

  test("a BigQuery connection with no key file uses default credentials and is not a problem", () => {
    const f = detectProblems(facts({ connections: [{ name: "bq", type: "bigquery", auth: "unknown", fields: ["project"], passwordAvailable: false }] }))
    expect(f.some((x) => x.title.includes("'bq'"))).toBe(false)
  })

  test("telemetry that was not checked is not reported as off", () => {
    const f = detectProblems(facts({ telemetry: { enabled: false, checked: false, reason: "not started with --no-network" } }))
    expect(f.some((x) => x.title === "Telemetry is off")).toBe(false)
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

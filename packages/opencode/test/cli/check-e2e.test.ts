// altimate_change start — E2E + adversarial tests for check CLI command
//
// IMPORTANT: This file uses Dispatcher.register() / Dispatcher.reset() instead
// of mock.module("@/altimate/native") to avoid Bun's mock.module leaking across
// test files and breaking Glob/Dispatcher for all subsequent tests in CI.
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import os from "os"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import type { BridgeMethod } from "../../src/altimate/native/types"
import {
  normalizeSeverity,
  filterBySeverity,
  toCategoryResult,
  formatText,
  buildCheckOutput,
  VALID_CHECKS,
  type Finding,
  type CheckCategoryResult,
} from "../../src/cli/cmd/check-helpers"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "test.sql",
    severity: "warning",
    message: "test finding",
    ...overrides,
  }
}

async function mktmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = path.join(os.tmpdir(), "check-e2e-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return {
    dir: await fs.realpath(dir),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
  }
}

async function writeSql(dir: string, name: string, content: string): Promise<string> {
  const filepath = path.join(dir, name)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(filepath, content, "utf-8")
  return filepath
}

// ---------------------------------------------------------------------------
// Dispatcher test handler registration (no mock.module — no leak)
// ---------------------------------------------------------------------------

const mockDispatcherResults: Map<string, (params: any) => any> = new Map()

function setDispatcherResponse(method: string, handler: (params: any) => any) {
  mockDispatcherResults.set(method, handler)
}

function resetDispatcherMocks() {
  mockDispatcherResults.clear()
  for (const m of [
    "altimate_core.lint",
    "altimate_core.validate",
    "altimate_core.safety",
    "altimate_core.policy",
    "altimate_core.query_pii",
    "altimate_core.semantics",
    "altimate_core.grade",
  ]) {
    mockDispatcherResults.set(m, () => ({
      success: true,
      data: { violations: [], errors: [], issues: [], pii_columns: [], findings: [], recommendations: [] },
    }))
  }
}

/** Register mock handlers with the real Dispatcher (no module replacement). */
function installDispatcherMocks() {
  Dispatcher.reset()
  // Disable the lazy registration hook so it doesn't load real altimate-core handlers
  Dispatcher.setRegistrationHook(async () => {})
  for (const [method, handler] of mockDispatcherResults) {
    Dispatcher.register(method as BridgeMethod, handler)
  }
}

// ---------------------------------------------------------------------------
// Import command (uses real Dispatcher — we register mock handlers via API)
// ---------------------------------------------------------------------------

const { CheckCommand } = await import("../../src/cli/cmd/check")

type HandlerArgs = Parameters<NonNullable<typeof CheckCommand.handler>>[0]

function baseArgs(overrides: Partial<HandlerArgs> = {}): HandlerArgs {
  return {
    _: [],
    $0: "altimate-code",
    files: [],
    format: "json",
    checks: "lint,safety",
    severity: "info",
    "fail-on": "none",
    failOn: "none",
    ...overrides,
  } as HandlerArgs
}

// ---------------------------------------------------------------------------
// Process exit/output capture
// ---------------------------------------------------------------------------

let exitCode: number | undefined
let stdoutData = ""
let stderrData = ""
let tmpDir: { dir: string; cleanup: () => Promise<void> }
const origExit = process.exit
let savedHandlers: Map<string, any> | undefined

beforeEach(async () => {
  // Save existing Dispatcher handlers so we can restore them after
  savedHandlers = new Map()
  resetDispatcherMocks()
  installDispatcherMocks()
  exitCode = undefined
  process.exitCode = 0
  stdoutData = ""
  stderrData = ""
  tmpDir = await mktmp()

  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`__EXIT_${code ?? 0}__`)
  }) as any

  spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString()
    return true
  })
  spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString()
    return true
  })
  spyOn(console, "error").mockImplementation((...args: any[]) => {
    stderrData += args.join(" ") + "\n"
  })
})

afterEach(async () => {
  process.exit = origExit
  process.exitCode = 0
  // Restore Dispatcher: clear our mocks and re-enable lazy registration
  Dispatcher.reset()
  // Re-install the registration hook so subsequent tests get real handlers
  Dispatcher.setRegistrationHook(async () => {
    await import("../../src/altimate/native/altimate-core")
    await import("../../src/altimate/native/sql/register")
    await import("../../src/altimate/native/schema/register")
    await import("../../src/altimate/native/connections/register")
    await import("../../src/altimate/native/dbt/register")
    await import("../../src/altimate/native/finops/register")
    await import("../../src/altimate/native/local/register")
  })
  await tmpDir.cleanup()
})

async function runHandler(
  args: HandlerArgs,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  exitCode = undefined
  process.exitCode = 0
  // Re-install mocks before each handler call (afterEach may have restored real handlers)
  installDispatcherMocks()
  try {
    const savedCwd = process.cwd
    ;(process as any).cwd = () => tmpDir.dir
    try {
      await CheckCommand.handler!(args)
    } finally {
      ;(process as any).cwd = savedCwd
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("__EXIT_")) {
      // expected
    } else {
      throw e
    }
  }
  const code = exitCode ?? (process.exitCode === 0 ? undefined : (process.exitCode as number))
  process.exitCode = 0
  return { exitCode: code, stdout: stdoutData, stderr: stderrData }
}

function parseJson(stdout: string): any {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  return JSON.parse(trimmed)
}

// ===========================================================================
// E2E TESTS
// ===========================================================================

describe("check command E2E", () => {
  test("runs lint on a single SQL file — JSON output", async () => {
    const file = await writeSql(tmpDir.dir, "model.sql", "SELECT * FROM users;")

    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [{ rule: "L001", severity: "warning", message: "SELECT * detected", line: 1, column: 1 }],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", format: "json" }))
    const j = parseJson(r.stdout)
    expect(j.version).toBe(1)
    expect(j.files_checked).toBe(1)
    expect(j.checks_run).toEqual(["lint"])
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.lint.findings[0].rule).toBe("L001")
    expect(j.summary.warnings).toBe(1)
    expect(j.summary.pass).toBe(true)
  })

  test("runs multiple checks on one file", async () => {
    const file = await writeSql(tmpDir.dir, "query.sql", "SELECT id FROM orders;")

    setDispatcherResponse("altimate_core.validate", () => ({
      success: true,
      data: { errors: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint,safety,validate", format: "json" }))
    const j = parseJson(r.stdout)
    expect(j.checks_run).toEqual(["lint", "safety", "validate"])
    expect(j.summary.total_findings).toBe(0)
    expect(j.summary.pass).toBe(true)
  })

  test("runs on multiple files", async () => {
    const files = await Promise.all([
      writeSql(tmpDir.dir, "a.sql", "SELECT 1;"),
      writeSql(tmpDir.dir, "b.sql", "SELECT 2;"),
      writeSql(tmpDir.dir, "c.sql", "SELECT 3;"),
    ])

    const r = await runHandler(baseArgs({ files, checks: "lint", format: "json" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(3)
  })

  test("text format goes to stderr", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L005", severity: "warning", message: "Missing alias" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", format: "text" }))
    expect(r.stderr).toContain("Checked 1 file(s)")
    expect(r.stderr).toContain("Missing alias")
  })

  // --- --fail-on behavior ---

  test("exits 1 when --fail-on=error and errors exist", async () => {
    const file = await writeSql(tmpDir.dir, "bad.sql", "DROP TABLE users;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L020", severity: "error", message: "DROP TABLE" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "error", failOn: "error" }))
    expect(r.exitCode).toBe(1)
  })

  test("does NOT exit 1 when --fail-on=error and only warnings", async () => {
    const file = await writeSql(tmpDir.dir, "ok.sql", "SELECT * FROM t;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "warning", message: "SELECT *" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "error", failOn: "error" }))
    expect(r.exitCode).toBeUndefined()
  })

  test("exits 1 when --fail-on=warning and warnings exist", async () => {
    const file = await writeSql(tmpDir.dir, "warn.sql", "SELECT *;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "warning", message: "star" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "warning", failOn: "warning" }))
    expect(r.exitCode).toBe(1)
  })

  test("--fail-on=none never exits 1 even with errors", async () => {
    const file = await writeSql(tmpDir.dir, "err.sql", "bad sql")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          { rule: "L001", severity: "error", message: "bad" },
          { rule: "L002", severity: "error", message: "bad2" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    expect(r.exitCode).toBeUndefined()
  })

  // --- --severity filtering ---

  test("--severity=warning filters out info", async () => {
    const file = await writeSql(tmpDir.dir, "info.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          { rule: "L001", severity: "info", message: "Info" },
          { rule: "L002", severity: "warning", message: "Warn" },
          { rule: "L003", severity: "error", message: "Err" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", severity: "warning" }))
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(2)
    const rules = j.results.lint.findings.map((f: any) => f.rule)
    expect(rules).not.toContain("L001")
  })

  test("--severity=error filters out info and warning", async () => {
    const file = await writeSql(tmpDir.dir, "err-only.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          { rule: "L001", severity: "info", message: "i" },
          { rule: "L002", severity: "warning", message: "w" },
          { rule: "L003", severity: "error", message: "e" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", severity: "error" }))
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(1)
    expect(j.results.lint.findings[0].rule).toBe("L003")
  })

  // --- --severity + --fail-on interaction ---

  test("--severity=error --fail-on=warning still fails when warnings exist (unfiltered)", async () => {
    const file = await writeSql(tmpDir.dir, "sev-fail.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          { rule: "L001", severity: "warning", message: "A warning" },
          { rule: "L002", severity: "error", message: "An error" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(
      baseArgs({ files: [file], checks: "lint", severity: "error", "fail-on": "warning", failOn: "warning" }),
    )
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(1)
    expect(r.exitCode).toBe(1)
    expect(j.summary.pass).toBe(false)
  })

  test("--severity=error --fail-on=error passes when only warnings exist", async () => {
    const file = await writeSql(tmpDir.dir, "sev-pass.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [{ rule: "L001", severity: "warning", message: "A warning" }],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(
      baseArgs({ files: [file], checks: "lint", severity: "error", "fail-on": "error", failOn: "error" }),
    )
    expect(r.exitCode).toBeUndefined()
  })

  // --- runPii with success=false ---

  test("pii check with dispatcher failure emits error finding", async () => {
    const file = await writeSql(tmpDir.dir, "pii-fail.sql", "SELECT email FROM users;")
    setDispatcherResponse("altimate_core.query_pii", () => ({
      success: false,
      error: "PII engine unavailable",
      data: {},
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "pii" }))
    const j = parseJson(r.stdout)
    expect(j.results.pii.findings).toHaveLength(1)
    expect(j.results.pii.findings[0].severity).toBe("error")
    expect(j.results.pii.findings[0].message).toContain("PII engine unavailable")
  })

  // --- Dispatcher failure triggers --fail-on exit code ---

  test("Dispatcher failure exits 1 with --fail-on=error", async () => {
    const file = await writeSql(tmpDir.dir, "fail-exit.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => {
      throw new Error("native binding missing")
    })
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "error", failOn: "error" }))
    expect(r.exitCode).toBe(1)
  })

  // --- Policy check ---

  test("policy check requires --policy flag", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "policy" }))
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("--policy is required")
  })

  test("policy check rejects nonexistent --policy file", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: "/no/such/file.json" }))
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("policy file not found")
  })

  test("policy check runs with valid --policy", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT id FROM t;")
    const policyFile = path.join(tmpDir.dir, "policy.json")
    await fs.writeFile(policyFile, JSON.stringify({ rules: [] }))

    setDispatcherResponse("altimate_core.policy", () => ({
      success: true,
      data: { allowed: true, violations: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    const j = parseJson(r.stdout)
    expect(j.checks_run).toEqual(["policy"])
    expect(j.summary.total_findings).toBe(0)
  })

  // --- Unknown checks ---

  test("warns on unknown check names", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint,bogus,nope" }))
    expect(r.stderr).toContain('unknown check "bogus"')
    expect(r.stderr).toContain('unknown check "nope"')
    const j = parseJson(r.stdout)
    expect(j.checks_run).toEqual(["lint"])
  })

  test("exits 1 when ALL check names are unknown", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "bogus,fake" }))
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("no valid checks")
  })

  // --- File handling ---

  test("skips nonexistent files with warning", async () => {
    const file = await writeSql(tmpDir.dir, "exists.sql", "SELECT 1;")
    const missing = path.join(tmpDir.dir, "gone.sql")
    const r = await runHandler(baseArgs({ files: [file, missing], checks: "lint" }))
    expect(r.stderr).toContain("file not found, skipping")
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("returns cleanly when no SQL files found (exit 0)", async () => {
    const r = await runHandler(baseArgs({ files: ["/nonexistent.sql"], checks: "lint" }))
    expect(r.exitCode).toBeUndefined()
    expect(r.stderr).toContain("No SQL files found")
  })

  test("skips empty SQL files", async () => {
    const empty = await writeSql(tmpDir.dir, "empty.sql", "")
    const real = await writeSql(tmpDir.dir, "real.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "info", message: "found" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [empty, real], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(2)
    expect(j.results.lint.findings).toHaveLength(1)
  })

  test("skips whitespace-only SQL files", async () => {
    const ws = await writeSql(tmpDir.dir, "ws.sql", "   \n\t\n  ")
    const r = await runHandler(baseArgs({ files: [ws], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(0)
  })

  // --- Dispatcher error handling ---

  test("Dispatcher.call() throwing emits error finding (no false pass)", async () => {
    const file = await writeSql(tmpDir.dir, "crash.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => {
      throw new Error("napi-rs binding crashed")
    })
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    expect(r.stderr).toContain("napi-rs binding crashed")
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.lint.findings[0].severity).toBe("error")
    expect(j.results.lint.findings[0].message).toContain("napi-rs binding crashed")
    expect(j.summary.errors).toBe(1)
  })

  test("validate: success=false with error message emits finding", async () => {
    const file = await writeSql(tmpDir.dir, "bad.sql", "SELEC 1;")
    setDispatcherResponse("altimate_core.validate", () => ({
      success: false,
      error: "Parse error at line 1",
      data: { errors: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "validate" }))
    const j = parseJson(r.stdout)
    expect(j.results.validate.findings).toHaveLength(1)
    expect(j.results.validate.findings[0].message).toContain("Parse error")
    expect(j.results.validate.findings[0].severity).toBe("error")
  })

  test("handles unexpected Dispatcher data shape (empty object)", async () => {
    const file = await writeSql(tmpDir.dir, "weird.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {},
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(0)
  })

  // --- All 7 check types ---

  test("safety check detects unsafe SQL", async () => {
    const file = await writeSql(tmpDir.dir, "unsafe.sql", "SELECT '1' OR '1'='1';")
    setDispatcherResponse("altimate_core.safety", () => ({
      success: false,
      data: {
        safe: false,
        issues: [{ rule: "sql-injection", severity: "error", message: "Possible SQL injection" }],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "safety" }))
    const j = parseJson(r.stdout)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].rule).toBe("sql-injection")
  })

  test("safety check surfaces engine ThreatFinding shape (threats/rule/message/detail)", async () => {
    // Real core@0.7.0 scanSql shape: threats[], each { rule, severity, message, detail }.
    // Regression guard: the consumer previously only read issues/findings, so
    // real threats (e.g. the 0.6.0 unbalanced_quote rule) rendered as a generic warning.
    const file = await writeSql(tmpDir.dir, "breakout.sql", "SELECT * FROM users WHERE name = 'x' OR 1=1 --';")
    setDispatcherResponse("altimate_core.safety", () => ({
      success: true,
      data: {
        safe: false,
        risk_score: 0.9,
        statement_count: 1,
        statement_types: ["SELECT"],
        threats: [
          {
            rule: "unbalanced_quote",
            severity: "high",
            message: "Unbalanced quote suggests injection breakout",
            detail: "Quote count is odd within a single statement",
            // Real engine semantics: [byteOffset, byteLength] — "OR 1=1 " at 37.
            location: [37, 7],
            matched_pattern: "' OR 1=1 --",
          },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "safety" }))
    const j = parseJson(r.stdout)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].rule).toBe("unbalanced_quote")
    // ThreatFinding.location is [byteOffset, byteLength] — rendered as a byte range.
    expect(j.results.safety.findings[0].message).toBe("Unbalanced quote suggests injection breakout (bytes 37-44)")
    expect(j.results.safety.findings[0].suggestion).toBe("Quote count is odd within a single statement")
    // Engine severity "high" must normalize to error, not degrade to info —
    // otherwise --fail-on/--severity filters silently pass high-risk injections.
    expect(j.results.safety.findings[0].severity).toBe("error")
  })

  test("pii check surfaces engine PiiColumnAccess shape (classification/query_targets/masking)", async () => {
    // Real core@0.7.0 query_pii shape: pii_columns[], each
    // { table, column, classification, query_targets, suggested_masking }.
    const file = await writeSql(tmpDir.dir, "pii-real.sql", "SELECT email AS contact FROM customers;")
    setDispatcherResponse("altimate_core.query_pii", () => ({
      success: true,
      data: {
        accesses_pii: true,
        risk_level: "Medium",
        pii_columns: [
          {
            table: "customers",
            column: "email",
            classification: "Email",
            query_targets: ["contact"],
            suggested_masking: "'***MASKED***'",
          },
          {
            table: "customers",
            column: "employee_ref",
            // PiiClassification can be { Custom: string }, not just a string.
            classification: { Custom: "EmployeeId" },
            query_targets: [],
            suggested_masking: null,
          },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "pii" }))
    const j = parseJson(r.stdout)
    expect(j.results.pii.findings).toHaveLength(2)
    expect(j.results.pii.findings[0].rule).toBe("Email")
    expect(j.results.pii.findings[0].message).toContain("customers.email")
    expect(j.results.pii.findings[0].message).toContain("exposed via: contact")
    expect(j.results.pii.findings[0].suggestion).toBe("'***MASKED***'")
    expect(j.results.pii.findings[1].rule).toBe("EmployeeId")
    // suggested_masking: null must not leak into suggestion as null.
    expect(j.results.pii.findings[1].suggestion).toBeUndefined()
  })

  test("pii check fails when the engine abstains via parse_error", async () => {
    // Unparseable SQL: engine returns success + parse_error + empty pii_columns.
    // No findings would let --fail-on PASS a file whose PII analysis never ran.
    const file = await writeSql(tmpDir.dir, "pii-abstain.sql", "SELECT FROM;")
    setDispatcherResponse("altimate_core.query_pii", () => ({
      success: true,
      data: { accesses_pii: false, parse_error: "Syntax error: Expected: identifier", pii_columns: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "pii" }))
    const j = parseJson(r.stdout)
    expect(j.results.pii.findings).toHaveLength(1)
    expect(j.results.pii.findings[0].severity).toBe("error")
    expect(j.results.pii.findings[0].message).toContain("PII analysis skipped")
  })

  test("grade check keeps per-file grades on multi-file runs", async () => {
    const fileA = await writeSql(tmpDir.dir, "grade-a.sql", "SELECT 1;")
    const fileB = await writeSql(tmpDir.dir, "grade-b.sql", "SELECT * FROM t;")
    let call = 0
    setDispatcherResponse("altimate_core.grade", () => {
      call++
      return {
        success: true,
        data: {
          overall_grade: call === 1 ? "A" : "C",
          scores: { overall: call === 1 ? 0.95 : 0.7 },
          lint: { clean: true, findings: [] },
        },
      }
    })
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [fileA, fileB], checks: "grade" }))
    const j = parseJson(r.stdout)
    const grades = j.results.grade.grades as Record<string, { grade: string; score: number }>
    expect(Object.keys(grades)).toHaveLength(2)
    expect(new Set(Object.values(grades).map((g) => g.grade))).toEqual(new Set(["A", "C"]))
    // Flat grade/score only meaningful for single-file runs — must not pick a
    // racy winner across files.
    expect(j.results.grade.grade).toBeUndefined()
  })

  test("pii check reports PII columns", async () => {
    const file = await writeSql(tmpDir.dir, "pii.sql", "SELECT email, ssn FROM customers;")
    setDispatcherResponse("altimate_core.query_pii", () => ({
      success: true,
      data: {
        pii_columns: [
          { column_name: "email", pii_type: "email", message: "Email detected" },
          { column_name: "ssn", pii_type: "ssn", message: "SSN detected" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "pii" }))
    const j = parseJson(r.stdout)
    expect(j.results.pii.findings).toHaveLength(2)
    expect(j.results.pii.findings[0].severity).toBe("warning")
  })

  test("semantic check detects issues", async () => {
    const file = await writeSql(tmpDir.dir, "cart.sql", "SELECT * FROM a, b;")
    setDispatcherResponse("altimate_core.semantics", () => ({
      success: false,
      data: {
        valid: false,
        issues: [{ rule: "cartesian-join", severity: "warning", message: "Cartesian join" }],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "semantic" }))
    const j = parseJson(r.stdout)
    expect(j.results.semantic.findings).toHaveLength(1)
    expect(j.results.semantic.findings[0].rule).toBe("cartesian-join")
  })

  test("grade check maps the real EvalResult shape (overall_grade/scores.overall/lint.findings)", async () => {
    // Real core@0.7.0 evaluate() shape — the previous mock used grade/recommendations,
    // fields the engine never returns, which enshrined a dead consumer.
    const file = await writeSql(tmpDir.dir, "grade.sql", "SELECT * FROM big_table;")
    setDispatcherResponse("altimate_core.grade", () => ({
      success: true,
      data: {
        overall_grade: "C",
        scores: { overall: 0.72, complexity: 0.9, safety: 1, style: 0.6, syntax: 1 },
        lint: {
          clean: false,
          findings: [{ rule: "select-star", severity: "info", message: "Add WHERE clause or explicit columns" }],
        },
        explain: {},
        safety: { safe: true },
        validation: { valid: true },
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "grade" }))
    const j = parseJson(r.stdout)
    expect(j.results.grade.findings).toHaveLength(1)
    expect(j.results.grade.findings[0].message).toContain("WHERE clause")
    expect(j.results.grade.grade).toBe("C")
    expect(j.results.grade.score).toBe(0.72)
  })

  test("grade check fails closed on engine failure envelope", async () => {
    // Native handlers report failures via {success:false}, not by throwing —
    // a failed grade run must not pass silently with zero findings.
    const file = await writeSql(tmpDir.dir, "grade-fail.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.grade", () => ({
      success: false,
      data: {},
      error: "Failed to parse JSON schema",
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "grade" }))
    const j = parseJson(r.stdout)
    expect(j.results.grade.findings).toHaveLength(1)
    expect(j.results.grade.findings[0].severity).toBe("error")
    expect(j.results.grade.findings[0].message).toContain("Failed to parse JSON schema")
  })

  test("validate check fails invalid SQL despite handler success (dead-gate regression)", async () => {
    // The native handler returns success=true even for invalid SQL — the
    // verdict is data.valid. Gating on success alone made validate a no-op.
    const file = await writeSql(tmpDir.dir, "invalid.sql", "SELECT zzz FROM t;")
    setDispatcherResponse("altimate_core.validate", () => ({
      success: true,
      data: {
        valid: false,
        errors: [
          {
            code: "E002",
            kind: { type: "ColumnNotFound", column: "zzz", table: null },
            message: "Column 'zzz' not found",
            location: { line: 1, column: 8 },
            suggestions: [],
          },
        ],
        warnings: [],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "validate" }))
    const j = parseJson(r.stdout)
    expect(j.results.validate.findings).toHaveLength(1)
    expect(j.results.validate.findings[0].severity).toBe("error")
    expect(j.results.validate.findings[0].message).toBe("Column 'zzz' not found")
    expect(j.results.validate.findings[0].line).toBe(1)
  })

  test("validate check passes valid SQL", async () => {
    const file = await writeSql(tmpDir.dir, "valid.sql", "SELECT id FROM t;")
    setDispatcherResponse("altimate_core.validate", () => ({
      success: true,
      data: { valid: true, errors: [], warnings: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "validate" }))
    const j = parseJson(r.stdout)
    expect(j.results.validate.findings).toHaveLength(0)
  })

  test("semantic check surfaces findings when valid:true (valid means plannable, not clean)", async () => {
    const file = await writeSql(tmpDir.dir, "cartesian.sql", "SELECT * FROM a, b;")
    setDispatcherResponse("altimate_core.semantics", () => ({
      success: true,
      data: {
        valid: true,
        semantic_score: 0.5,
        findings: [
          {
            rule: "missing_join_condition",
            severity: "error",
            message: "Cartesian product detected between 'a' and 'b'",
            explanation: "…",
            confidence: 0.95,
          },
        ],
        passed_checks: [],
        validation_errors: [],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "semantic" }))
    const j = parseJson(r.stdout)
    expect(j.results.semantic.findings).toHaveLength(1)
    expect(j.results.semantic.findings[0].rule).toBe("missing_join_condition")
    expect(j.results.semantic.findings[0].severity).toBe("error")
  })

  // --- Schema resolution ---

  test("schema_resolved=true when valid --schema provided", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT id FROM t;")
    const schema = path.join(tmpDir.dir, "schema.json")
    await fs.writeFile(schema, JSON.stringify({ tables: [] }))

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", schema }))
    const j = parseJson(r.stdout)
    expect(j.schema_resolved).toBe(true)
  })

  test("schema_resolved=false when --schema not provided", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.schema_resolved).toBe(false)
  })

  test("schema_resolved=false when --schema is nonexistent", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint", schema: "/no/schema.json" }))
    const j = parseJson(r.stdout)
    expect(j.schema_resolved).toBe(false)
  })

  // --- Batching (>10 files) ---

  test("handles >10 files via batching", async () => {
    const files: string[] = []
    for (let i = 0; i < 15; i++) {
      files.push(await writeSql(tmpDir.dir, `m_${i}.sql`, `SELECT ${i};`))
    }
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "info", message: "found" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files, checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(15)
    expect(j.results.lint.findings).toHaveLength(15)
  })

  // --- Timing ---

  test("reports completion time", async () => {
    const file = await writeSql(tmpDir.dir, "t.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    expect(r.stderr).toMatch(/Completed in \d+ms/)
  })

  // --- Fallback paths ---

  test("safety: generic finding when safe=false with no issues", async () => {
    const file = await writeSql(tmpDir.dir, "unsafe2.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.safety", () => ({
      success: false,
      data: { safe: false, issues: [] },
      error: "Injection vector detected",
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "safety" }))
    const j = parseJson(r.stdout)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].message).toContain("Injection vector")
  })

  test("semantic: generic finding when valid=false with no issues", async () => {
    const file = await writeSql(tmpDir.dir, "sem.sql", "SELECT * FROM a, b;")
    setDispatcherResponse("altimate_core.semantics", () => ({
      success: false,
      data: { valid: false, issues: [] },
      error: "Cartesian product",
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "semantic" }))
    const j = parseJson(r.stdout)
    expect(j.results.semantic.findings).toHaveLength(1)
    expect(j.results.semantic.findings[0].message).toContain("Cartesian product")
  })

  test("policy: generic finding when allowed=false with no violations", async () => {
    const file = await writeSql(tmpDir.dir, "pol.sql", "SELECT 1;")
    const policyFile = path.join(tmpDir.dir, "p.json")
    await fs.writeFile(policyFile, JSON.stringify({ rules: [] }))

    setDispatcherResponse("altimate_core.policy", () => ({
      success: false,
      data: { allowed: false, violations: [] },
      error: "Policy violation: SELECT * not allowed",
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    const j = parseJson(r.stdout)
    expect(j.results.policy.findings).toHaveLength(1)
    expect(j.results.policy.findings[0].severity).toBe("error")
  })

  // --- Mixed ---

  test("handles some checks passing and some failing", async () => {
    const file = await writeSql(tmpDir.dir, "mixed.sql", "SELECT * FROM users;")

    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "warning", message: "SELECT *" }] },
    }))
    setDispatcherResponse("altimate_core.safety", () => {
      throw new Error("Safety engine unavailable")
    })
    setDispatcherResponse("altimate_core.validate", () => ({
      success: true,
      data: { errors: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint,safety,validate" }))
    expect(r.stderr).toContain("Safety engine unavailable")
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].severity).toBe("error")
    expect(j.results.validate.findings).toHaveLength(0)
  })
})

// ===========================================================================
// ADVERSARIAL TESTS
// ===========================================================================

describe("check command adversarial", () => {
  test("handles SQL with embedded null bytes", async () => {
    const file = await writeSql(tmpDir.dir, "null.sql", "SELECT 1;\0DROP TABLE users;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles SQL with shell metacharacters", async () => {
    const file = await writeSql(tmpDir.dir, "shell.sql", "SELECT '$(rm -rf /)'; SELECT `whoami`;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles SQL with extremely long lines (100K chars)", async () => {
    const longLine = "SELECT " + "a, ".repeat(30000) + "b FROM t;"
    const file = await writeSql(tmpDir.dir, "long.sql", longLine)
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles SQL with unicode and emoji", async () => {
    const file = await writeSql(tmpDir.dir, "uni.sql", "SELECT '日本語 🎉' AS emoji, 'Ñoño' AS sp;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles SQL with CRLF line endings", async () => {
    const file = await writeSql(tmpDir.dir, "crlf.sql", "SELECT 1;\r\nSELECT 2;\r\n")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles filenames with spaces", async () => {
    const file = await writeSql(tmpDir.dir, "my model file.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles filenames with special characters", async () => {
    const file = await writeSql(tmpDir.dir, "model-v2.0_(final).sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles deeply nested paths", async () => {
    const file = await writeSql(tmpDir.dir, "a/b/c/d/e/f/g/h/model.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles malformed policy JSON gracefully", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const policyFile = path.join(tmpDir.dir, "bad.json")
    await fs.writeFile(policyFile, "{{not valid json}}")
    setDispatcherResponse("altimate_core.policy", () => {
      throw new Error("Invalid policy JSON")
    })
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    expect(r.stderr).toContain("Invalid policy JSON")
    const j = parseJson(r.stdout)
    expect(j.results.policy.findings).toHaveLength(1)
    expect(j.results.policy.findings[0].severity).toBe("error")
  })

  test("handles very large policy file (1MB)", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const policyFile = path.join(tmpDir.dir, "huge.json")
    const rules = Array.from({ length: 1000 }, (_, i) => ({ id: `r_${i}`, pattern: "x".repeat(1000) }))
    await fs.writeFile(policyFile, JSON.stringify({ rules }))
    setDispatcherResponse("altimate_core.policy", () => ({
      success: true,
      data: { allowed: true, violations: [] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(0)
  })

  test("handles findings with undefined/null fields", async () => {
    const file = await writeSql(tmpDir.dir, "nulls.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          {
            rule: undefined,
            severity: undefined,
            message: undefined,
            line: null,
            column: null,
            code: null,
            suggestion: null,
          },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.lint.findings[0].severity).toBe("warning")
    expect(j.results.lint.findings[0].message).toBe("")
  })

  test("handles 5000 findings without crashing", async () => {
    const file = await writeSql(tmpDir.dir, "many.sql", "SELECT 1;")
    const violations = Array.from({ length: 5000 }, (_, i) => ({
      rule: `L${String(i).padStart(4, "0")}`,
      severity: ["error", "warning", "info"][i % 3],
      message: `Finding ${i}`,
      line: i + 1,
    }))
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(5000)
    expect(j.summary.total_findings).toBe(5000)
  })

  test("handles XSS-like content in messages without escaping", async () => {
    const file = await writeSql(tmpDir.dir, "xss.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          {
            rule: "xss",
            severity: "warning",
            message: '<script>alert("xss")</script>',
            suggestion: '"><img src=x onerror=alert(1)>',
          },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings[0].message).toBe('<script>alert("xss")</script>')
    expect(j.results.lint.findings[0].suggestion).toBe('"><img src=x onerror=alert(1)>')
  })

  test("handles non-string severity values gracefully", async () => {
    const file = await writeSql(tmpDir.dir, "sev.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          { rule: "L001", severity: 42, message: "numeric" },
          { rule: "L002", severity: true, message: "boolean" },
          { rule: "L003", severity: { level: "error" }, message: "object" },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(3)
    expect(j.results.lint.findings[0].severity).toBe("warning")
    expect(j.results.lint.findings[1].severity).toBe("warning")
    expect(j.results.lint.findings[2].severity).toBe("warning")
  })

  test("handles directory with .sql extension", async () => {
    const good = await writeSql(tmpDir.dir, "good.sql", "SELECT 1;")
    const dir = path.join(tmpDir.dir, "dir.sql")
    await fs.mkdir(dir)

    const r = await runHandler(baseArgs({ files: [good, dir], checks: "lint" }))
    expect(r.stderr).toContain("Error reading")
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(2)
  })

  test("processes duplicate file args (each checked separately)", async () => {
    const file = await writeSql(tmpDir.dir, "dup.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "info", message: "found" }] },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file, file, file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(3)
    expect(j.results.lint.findings).toHaveLength(3)
  })

  test("JSON output is always valid", async () => {
    const file = await writeSql(tmpDir.dir, "j.sql", "SELECT 'It\\'s a \"test\"';")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [{ rule: "L001", severity: "warning", message: "quotes and \nnewlines" }],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = JSON.parse(r.stdout.trim())
    expect(j.version).toBe(1)
  })

  test("handles __proto__ in Dispatcher response without pollution", async () => {
    const file = await writeSql(tmpDir.dir, "proto.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [
          {
            rule: "__proto__",
            severity: "warning",
            message: "constructor",
            __proto__: { isAdmin: true },
            constructor: { prototype: { isAdmin: true } },
          },
        ],
      },
    }))
    installDispatcherMocks()

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(({} as any).isAdmin).toBeUndefined()
  })

  test("handles empty string for --checks", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "" }))
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("no valid checks")
  })

  test("handles checks with extra whitespace", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: " lint , safety " }))
    const j = parseJson(r.stdout)
    expect(j.checks_run).toEqual(["lint", "safety"])
  })

  test("handles symlinked SQL files", async () => {
    const real = await writeSql(tmpDir.dir, "real.sql", "SELECT 1;")
    const link = path.join(tmpDir.dir, "link.sql")
    await fs.symlink(real, link)

    const r = await runHandler(baseArgs({ files: [link], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles binary content in .sql file without crashing", async () => {
    const file = path.join(tmpDir.dir, "binary.sql")
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47])
    await fs.writeFile(file, buf)

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  test("handles 50 files concurrently across batches", async () => {
    const files: string[] = []
    for (let i = 0; i < 50; i++) {
      files.push(await writeSql(tmpDir.dir, `f_${i}.sql`, `SELECT ${i};`))
    }

    const r = await runHandler(baseArgs({ files, checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(50)
  })
})
// altimate_change end

// altimate_change start — E2E + adversarial tests for check CLI command
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import os from "os"
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
// Mock infrastructure
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

// Mock all transitive dependencies that check.ts pulls in via Dispatcher
mock.module("@/altimate/native", () => ({
  Dispatcher: {
    call: async (method: string, params: any) => {
      const handler = mockDispatcherResults.get(method)
      if (!handler) throw new Error(`Unmocked Dispatcher method: ${method}`)
      return handler(params)
    },
  },
}))

mock.module("@/util/glob", () => ({
  Glob: {
    scan: async (pattern: string, opts: any) => {
      const glob = new Bun.Glob(pattern)
      const results: string[] = []
      for await (const entry of glob.scan({ cwd: opts?.cwd ?? process.cwd(), absolute: opts?.absolute ?? false })) {
        results.push(entry)
      }
      return results
    },
  },
}))

// ---------------------------------------------------------------------------
// Import command AFTER mocks
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

beforeEach(async () => {
  resetDispatcherMocks()
  exitCode = undefined
  process.exitCode = 0
  stdoutData = ""
  stderrData = ""
  tmpDir = await mktmp()

  // Keep process.exit mock as safety net
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
  mock.restore()
  await tmpDir.cleanup()
})

async function runHandler(
  args: HandlerArgs,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  exitCode = undefined
  process.exitCode = 0
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
      // expected — from legacy process.exit() mock
    } else {
      throw e
    }
  }
  // Handler uses process.exitCode (preferred) or process.exit() (mocked to set exitCode)
  // Note: Bun doesn't support process.exitCode = undefined, so we use 0 as "no error"
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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "error", failOn: "error" }))
    expect(r.exitCode).toBe(1)
  })

  test("does NOT exit 1 when --fail-on=error and only warnings", async () => {
    const file = await writeSql(tmpDir.dir, "ok.sql", "SELECT * FROM t;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "warning", message: "SELECT *" }] },
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "lint", "fail-on": "error", failOn: "error" }))
    expect(r.exitCode).toBeUndefined()
  })

  test("exits 1 when --fail-on=warning and warnings exist", async () => {
    const file = await writeSql(tmpDir.dir, "warn.sql", "SELECT *;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "warning", message: "star" }] },
    }))

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

    // severity=error filters warnings from output, but fail-on=warning
    // should still detect warnings in unfiltered findings
    const r = await runHandler(
      baseArgs({ files: [file], checks: "lint", severity: "error", "fail-on": "warning", failOn: "warning" }),
    )
    // Output only shows 1 error (severity filter hides warning)
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(1)
    // But exit code is 1 because warnings exist in unfiltered findings
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

    const r = await runHandler(
      baseArgs({ files: [file], checks: "lint", severity: "error", "fail-on": "error", failOn: "error" }),
    )
    // No errors, only warnings — should pass even with fail-on=error
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
    // No exitCode set — handler just returns without error
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

    const r = await runHandler(baseArgs({ files: [empty, real], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(2)
    expect(j.results.lint.findings).toHaveLength(1) // only non-empty file
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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    expect(r.stderr).toContain("napi-rs binding crashed")
    const j = parseJson(r.stdout)
    // Dispatcher failure now emits an error-severity finding instead of returning []
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

    const r = await runHandler(baseArgs({ files: [file], checks: "safety" }))
    const j = parseJson(r.stdout)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].rule).toBe("sql-injection")
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

    const r = await runHandler(baseArgs({ files: [file], checks: "semantic" }))
    const j = parseJson(r.stdout)
    expect(j.results.semantic.findings).toHaveLength(1)
    expect(j.results.semantic.findings[0].rule).toBe("cartesian-join")
  })

  test("grade check returns recommendations", async () => {
    const file = await writeSql(tmpDir.dir, "grade.sql", "SELECT * FROM big_table;")
    setDispatcherResponse("altimate_core.grade", () => ({
      success: true,
      data: {
        grade: "C",
        recommendations: [{ rule: "selectivity", severity: "info", message: "Add WHERE clause" }],
      },
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "grade" }))
    const j = parseJson(r.stdout)
    expect(j.results.grade.findings).toHaveLength(1)
    expect(j.results.grade.findings[0].message).toContain("WHERE clause")
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

  // --- Safety fallback (safe=false, no structured issues) ---

  test("safety: generic finding when safe=false with no issues", async () => {
    const file = await writeSql(tmpDir.dir, "unsafe2.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.safety", () => ({
      success: false,
      data: { safe: false, issues: [] },
      error: "Injection vector detected",
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "safety" }))
    const j = parseJson(r.stdout)
    expect(j.results.safety.findings).toHaveLength(1)
    expect(j.results.safety.findings[0].message).toContain("Injection vector")
  })

  // --- Semantic fallback ---

  test("semantic: generic finding when valid=false with no issues", async () => {
    const file = await writeSql(tmpDir.dir, "sem.sql", "SELECT * FROM a, b;")
    setDispatcherResponse("altimate_core.semantics", () => ({
      success: false,
      data: { valid: false, issues: [] },
      error: "Cartesian product",
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "semantic" }))
    const j = parseJson(r.stdout)
    expect(j.results.semantic.findings).toHaveLength(1)
    expect(j.results.semantic.findings[0].message).toContain("Cartesian product")
  })

  // --- Policy fallback ---

  test("policy: generic finding when allowed=false with no violations", async () => {
    const file = await writeSql(tmpDir.dir, "pol.sql", "SELECT 1;")
    const policyFile = path.join(tmpDir.dir, "p.json")
    await fs.writeFile(policyFile, JSON.stringify({ rules: [] }))

    setDispatcherResponse("altimate_core.policy", () => ({
      success: false,
      data: { allowed: false, violations: [] },
      error: "Policy violation: SELECT * not allowed",
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    const j = parseJson(r.stdout)
    expect(j.results.policy.findings).toHaveLength(1)
    expect(j.results.policy.findings[0].severity).toBe("error")
  })

  // --- Mixed success/failure across checks ---

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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint,safety,validate" }))
    expect(r.stderr).toContain("Safety engine unavailable")
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.safety.findings).toHaveLength(1) // error finding emitted
    expect(j.results.safety.findings[0].severity).toBe("error")
    expect(j.results.validate.findings).toHaveLength(0)
  })
})

// ===========================================================================
// ADVERSARIAL TESTS
// ===========================================================================

describe("check command adversarial", () => {
  // --- Malicious SQL content ---

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

  // --- Path edge cases ---

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

  // --- Malicious policy ---

  test("handles malformed policy JSON gracefully", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const policyFile = path.join(tmpDir.dir, "bad.json")
    await fs.writeFile(policyFile, "{{not valid json}}")
    setDispatcherResponse("altimate_core.policy", () => {
      throw new Error("Invalid policy JSON")
    })

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    expect(r.stderr).toContain("Invalid policy JSON")
    const j = parseJson(r.stdout)
    // Dispatcher failure now emits an error finding
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

    const r = await runHandler(baseArgs({ files: [file], checks: "policy", policy: policyFile }))
    const j = parseJson(r.stdout)
    expect(j.summary.total_findings).toBe(0)
  })

  // --- Adversarial Dispatcher responses ---

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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    expect(j.results.lint.findings[0].severity).toBe("warning") // normalizeSeverity(undefined)
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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    // normalizeSeverity now handles non-string inputs by returning "warning"
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(3)
    expect(j.results.lint.findings[0].severity).toBe("warning")
    expect(j.results.lint.findings[1].severity).toBe("warning")
    expect(j.results.lint.findings[2].severity).toBe("warning")
  })

  // --- File I/O errors ---

  test("handles directory with .sql extension", async () => {
    const good = await writeSql(tmpDir.dir, "good.sql", "SELECT 1;")
    const dir = path.join(tmpDir.dir, "dir.sql")
    await fs.mkdir(dir)

    const r = await runHandler(baseArgs({ files: [good, dir], checks: "lint" }))
    expect(r.stderr).toContain("Error reading")
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(2)
  })

  // --- Duplicate files ---

  test("processes duplicate file args (each checked separately)", async () => {
    const file = await writeSql(tmpDir.dir, "dup.sql", "SELECT 1;")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: { violations: [{ rule: "L001", severity: "info", message: "found" }] },
    }))

    const r = await runHandler(baseArgs({ files: [file, file, file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(3)
    expect(j.results.lint.findings).toHaveLength(3)
  })

  // --- JSON output integrity ---

  test("JSON output is always valid", async () => {
    const file = await writeSql(tmpDir.dir, "j.sql", "SELECT 'It\\'s a \"test\"';")
    setDispatcherResponse("altimate_core.lint", () => ({
      success: true,
      data: {
        violations: [{ rule: "L001", severity: "warning", message: "quotes and \nnewlines" }],
      },
    }))

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = JSON.parse(r.stdout.trim())
    expect(j.version).toBe(1)
  })

  // --- Prototype pollution attempt ---

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

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.results.lint.findings).toHaveLength(1)
    // Prototype pollution should not affect global Object
    expect(({} as any).isAdmin).toBeUndefined()
  })

  // --- Empty checks string ---

  test("handles empty string for --checks", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: "" }))
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("no valid checks")
  })

  // --- Checks with extra whitespace/commas ---

  test("handles checks with extra whitespace", async () => {
    const file = await writeSql(tmpDir.dir, "m.sql", "SELECT 1;")
    const r = await runHandler(baseArgs({ files: [file], checks: " lint , safety " }))
    const j = parseJson(r.stdout)
    expect(j.checks_run).toEqual(["lint", "safety"])
  })

  // --- Symlink handling ---

  test("handles symlinked SQL files", async () => {
    const real = await writeSql(tmpDir.dir, "real.sql", "SELECT 1;")
    const link = path.join(tmpDir.dir, "link.sql")
    await fs.symlink(real, link)

    const r = await runHandler(baseArgs({ files: [link], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  // --- Binary file content ---

  test("handles binary content in .sql file without crashing", async () => {
    const file = path.join(tmpDir.dir, "binary.sql")
    // Write some binary data
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47])
    await fs.writeFile(file, buf)

    const r = await runHandler(baseArgs({ files: [file], checks: "lint" }))
    const j = parseJson(r.stdout)
    expect(j.files_checked).toBe(1)
  })

  // --- Very many files ---

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

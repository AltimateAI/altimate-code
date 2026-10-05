/**
 * Fault injection end to end: the real engine, real DuckDB, real dbt.
 *
 * Runs the driver on the dbt-duckdb project in `fixtures/fault-injection/project`
 * (copied to a temp dir and built there first, so the fixture stays read-only).
 *
 * Skipped unless all of these are available:
 *   - dbt with the duckdb adapter: `ALTIMATE_DBT_PATH`, or `dbt` on PATH
 *   - the `duckdb` Node driver
 *   - `FaultInjectionSession`: an `@altimateai/altimate-core` that exports it, or,
 *     for development, `ALTIMATE_CORE_DEV_PATH` pointing at a locally built
 *     `crates/altimate-core-node`
 *
 *   ALTIMATE_DBT_PATH=/path/to/venv/bin/dbt \
 *   ALTIMATE_CORE_DEV_PATH=/path/to/altimate-core/crates/altimate-core-node \
 *     bun test test/altimate/fault-injection-e2e.test.ts --timeout 600000
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { loadFaultInjectionEngine, runFaultInjection } from "../../src/altimate/native/connections/fault-injection"
import { formatFaultInjection } from "../../src/altimate/native/connections/fault-injection-report"
import type { DbtFaultInjectionResult } from "../../src/altimate/native/types"

const FIXTURE = path.join(import.meta.dir, "fixtures", "fault-injection", "project")
const TIMEOUT_MS = 600_000

function findDbtWithDuckdb(): string | null {
  const candidate = process.env.ALTIMATE_DBT_PATH ?? "dbt"
  try {
    const out = execFileSync(candidate, ["--version"], { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
    return /duckdb/i.test(out) ? candidate : null
  } catch {
    return null
  }
}

async function engineAvailable(): Promise<boolean> {
  try {
    await loadFaultInjectionEngine()
    return true
  } catch {
    return false
  }
}

async function duckdbDriverAvailable(): Promise<boolean> {
  try {
    const { connect } = await import("@altimateai/drivers/duckdb")
    const connector = await connect({ type: "duckdb", path: ":memory:" })
    await connector.connect()
    await connector.close()
    return true
  } catch {
    return false
  }
}

const DBT = findDbtWithDuckdb()
const READY = DBT !== null && (await engineAvailable()) && (await duckdbDriverAvailable())

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

describe.skipIf(!READY)("fault injection e2e (real engine, DuckDB and dbt)", () => {
  let root: string
  let project: string
  let work: string
  let database: string
  let hashBefore: string
  let savedDbtPath: string | undefined

  beforeAll(() => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    savedDbtPath = process.env.ALTIMATE_DBT_PATH
    process.env.ALTIMATE_DBT_PATH = DBT!
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-e2e-"))
    project = path.join(root, "project")
    work = path.join(root, "work")
    fs.cpSync(FIXTURE, project, { recursive: true })
    fs.mkdirSync(work)
    // Build the "user's" database. Target and logs go outside the project so the
    // assertions below can tell whether the run itself wrote any.
    execFileSync(
      DBT!,
      ["build", "--project-dir", project, "--profiles-dir", project, "--target-path", path.join(root, "setup-target"), "--log-path", path.join(root, "setup-logs")],
      { cwd: project, stdio: "pipe", timeout: 120_000, env: { ...process.env, DBT_SEND_ANONYMOUS_USAGE_STATS: "false" } },
    )
    database = path.join(project, "fi_fixture.duckdb")
    hashBefore = sha256(database)
  }, TIMEOUT_MS)

  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    if (savedDbtPath === undefined) delete process.env.ALTIMATE_DBT_PATH
    else process.env.ALTIMATE_DBT_PATH = savedDbtPath
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  /** The user's files are exactly as they were and nothing of ours is left behind. */
  function expectNoTrace(result: DbtFaultInjectionResult) {
    expect(sha256(database)).toBe(hashBefore)
    expect(fs.readdirSync(project).sort()).toEqual(
      ["README.md", "dbt_project.yml", "fi_fixture.duckdb", "models", "profiles.yml", "seeds"].sort(),
    )
    expect(result.work_dir_removed).toBe(true)
    expect(result.original_unchanged).toBe(true)
    expect(fs.readdirSync(work)).toEqual([])
  }

  let full: DbtFaultInjectionResult
  let budgeted: DbtFaultInjectionResult

  /** Drop what legitimately differs between two runs: timings and the scratch directory. */
  const comparable = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.startsWith("Took "))
      .join("\n")
      .replace(/The work directory \S+/, "The work directory <work>")
      .replaceAll("/private/var/", "/var/")

  test(
    "finds the faults the fixture's tests miss and the ones they catch",
    async () => {
      full = await runFaultInjection({ project_dir: project, model: "raw_orders", budget: 50, work_dir: work })
      expect(full.error).toBeUndefined()
      expect(full.success).toBe(true)

      const report = full.report!
      const summary = report.summary
      expect(summary.executed).toBe(summary.selected)
      expect(summary.executed).toBeGreaterThan(0)
      expect(summary.killed + summary.slipped_through + summary.inert + summary.invalid).toBe(summary.executed)
      expect(summary.catch_rate).toBeCloseTo(summary.killed / (summary.killed + summary.slipped_through), 10)
      expect(report.dialect_verified).toBe(true)
      // --model restricts the run to one producer.
      expect(new Set(report.results.map((r: any) => r.producer_id))).toEqual(new Set(["seed.fi_fixture.raw_orders"]))

      const outcome = (suffix: string) => report.results.find((r: any) => r.fault_id.endsWith(suffix))
      // `id` carries unique + not_null, and customer_id a relationships test: these are caught.
      expect(outcome("|duplicate_rows|*").outcome).toBe("killed")
      expect(outcome("|null_out|id").outcome).toBe("killed")
      expect(outcome("|orphan_fk|customer_id").outcome).toBe("killed")
      expect(outcome("|duplicate_rows|*").failed_tests.length).toBeGreaterThan(0)

      // `amount` has no test at all: a 100x error flows into customer_orders unnoticed.
      const scaled = outcome("|unit_scale|amount")
      expect(scaled.outcome).toBe("survived_impactful")
      expect(scaled.failed_tests).toEqual([])
      const changed = scaled.changed_relations.find((c: any) => c.unique_id === "model.fi_fixture.customer_orders")
      expect(changed.comparison.method).toBe("keyed")
      expect(changed.comparison.columns.map((c: any) => c.column)).toEqual(["total_amount"])
      expect(changed.comparison.rows_changed).toBeGreaterThan(0)
      expect(scaled.proposed_test.verification).toEqual({
        baseline_failures: 0,
        sandbox_failures: scaled.affected_rows,
        catches_fault: true,
      })
      expect(report.slipped_through.map((r: any) => r.fault_id)).toContain(scaled.fault_id)

      const text = formatFaultInjection(full)
      expect(text).toContain("Fault injection: fi_fixture (duckdb)")
      expect(text).toContain("seed raw_orders: `amount` multiplied by 100 in")
      expect(text).toContain("      seeds:\n        - name: raw_orders\n          columns:\n            - name: amount\n")

      expectNoTrace(full)
    },
    TIMEOUT_MS,
  )

  test(
    "is deterministic: the same budget and seed select and classify the same faults",
    async () => {
      const again = await runFaultInjection({ project_dir: project, model: "raw_orders", budget: 2, work_dir: work })
      const first = await runFaultInjection({ project_dir: project, model: "raw_orders", budget: 2, work_dir: work })
      expect(again.success && first.success).toBe(true)
      expect(again.report!.summary.executed).toBe(2)
      expect(again.report!.results).toEqual(first.report!.results)
      // A budgeted run agrees with the full run on the faults they share.
      for (const result of again.report!.results) {
        expect(full.report!.results.find((r: any) => r.fault_id === result.fault_id)).toEqual(result)
      }
      expectNoTrace(again)
      budgeted = again
    },
    TIMEOUT_MS,
  )

  test(
    "the dbt_fault_injection tool returns what the driver returns, after asking permission",
    async () => {
      const { initTool } = await import("./tool-fixture")
      const { DbtFaultInjectionTool } = await import("../../src/altimate/tools/dbt-fault-injection")
      const tool = await initTool(DbtFaultInjectionTool)
      const asked: any[] = []
      // A relative project_dir resolves against the session's directory, not the process cwd.
      const { Instance } = await import("../../src/project/instance")
      const result = await Instance.provide({
        directory: path.dirname(project),
        fn: () =>
          tool.execute(
            { project_dir: path.basename(project), model: "raw_orders", budget: 2 },
            {
              sessionID: "test",
              messageID: "test",
              agent: "test",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => {},
              ask: async (request: any) => void asked.push(request),
            },
          ),
      })
      expect(asked).toHaveLength(1)
      expect(asked[0].permission).toBe("bash")
      expect(asked[0].patterns).toEqual([`dbt build --project-dir ${fs.realpathSync(project)}`])
      expect(result.metadata.success).toBe(true)
      expect(result.metadata.executed).toBe(2)
      expect(result.metadata.killed).toBe(budgeted.report!.summary.killed)
      expect(result.metadata.slipped_through).toBe(budgeted.report!.summary.slipped_through)
      expect(result.title).toContain("catch rate")
      expect(comparable(result.output)).toBe(comparable(formatFaultInjection(budgeted)))
      expect(sha256(database)).toBe(hashBefore)
    },
    TIMEOUT_MS,
  )

  test(
    "a project that does not build is reported and cleaned up",
    async () => {
      const broken = path.join(project, "models", "broken.sql")
      fs.writeFileSync(broken, "select no_such_column from {{ ref('raw_orders') }}\n")
      try {
        const result = await runFaultInjection({ project_dir: project, budget: 1, work_dir: work })
        expect(result.success).toBe(false)
        expect(result.error).toContain("The project does not build on a clean copy")
        expect(result.error).toContain("model.fi_fixture.broken (error)")
        expect(result.report).toBeUndefined()
        fs.rmSync(broken)
        expectNoTrace(result)
      } finally {
        fs.rmSync(broken, { force: true })
      }
    },
    TIMEOUT_MS,
  )

  test(
    "an interrupt mid-run stops dbt and removes the copies",
    async () => {
      const controller = new AbortController()
      let faults = 0
      const result = await runFaultInjection({
        project_dir: project,
        budget: 50,
        work_dir: work,
        signal: controller.signal,
        on_progress: (event) => {
          // Abort once a fault is under way, i.e. while a sandbox exists and dbt is about to run.
          if (event.kind === "fault" && ++faults === 1) setTimeout(() => controller.abort(), 1_500)
        },
      })
      expect(result.success).toBe(false)
      expect(result.interrupted).toBe(true)
      expect(result.report).toBeUndefined()
      expectNoTrace(result)
    },
    TIMEOUT_MS,
  )

  test(
    "a dbt invocation that exceeds its timeout fails the run instead of hanging",
    async () => {
      const result = await runFaultInjection({ project_dir: project, budget: 1, work_dir: work, dbt_timeout_ms: 1 })
      expect(result.success).toBe(false)
      expect(result.error).toContain("dbt parse timed out after 1ms")
      expect(result.interrupted).toBeUndefined()
      expectNoTrace(result)
    },
    TIMEOUT_MS,
  )
})

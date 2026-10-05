/**
 * Fault-injection driver against a scripted fake session.
 *
 * No database, no dbt and no engine: the session replays a fixed list of
 * actions and records what it is stepped with, and the sandbox and dbt runner
 * are fakes. This pins the caller obligations of the engine contract —
 * sequencing, error reporting and timeout handling.
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  CORE_DEV_PATH_ENV,
  DuckDbSandbox,
  copyProject,
  supportsUnitTests,
  FAULT_INJECTION_MIN_CORE_VERSION,
  FaultInjectionInterrupted,
  createDbtRunner,
  driveFaultInjectionSession,
  isFaultInjectionEngineAvailable,
  resetFaultInjectionEngineAvailability,
  loadFaultInjectionEngine,
  performAction,
  readDbtTarget,
  renderValue,
  resolveProducers,
  resolveSandboxFactory,
  runFaultInjection,
  type DbtOutcome,
  type FaultAction,
  type FaultStepResult,
  type PerformDeps,
  type SqlTarget,
} from "../../src/altimate/native/connections/fault-injection"
import {
  formatFaultInjection,
  formatRate,
  proposedTestYaml,
  summarizeFaultInjection,
} from "../../src/altimate/native/connections/fault-injection-report"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { FaultInjectionCommand } from "../../src/cli/cmd/fault-injection"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Replays `actions` in order and records every result it is stepped with. */
function scriptedSession(actions: FaultAction[]) {
  const stepped: FaultStepResult[] = []
  let cursor = 0
  return {
    stepped,
    start: () => JSON.stringify(actions[cursor++]),
    step: (resultJson: string) => {
      stepped.push(JSON.parse(resultJson))
      return JSON.stringify(actions[cursor++])
    },
    report: () => JSON.stringify({ summary: { selected: 1 } }),
  }
}

class CatalogError extends Error {}

interface FakeOptions {
  /** SQL text -> rows, or an Error to throw. Unlisted SQL returns no rows. */
  sql?: Record<string, unknown[][] | Error>
  /** Outcomes returned by successive dbt invocations. */
  dbt?: Array<DbtOutcome | Error>
  prepareError?: Error
  releaseError?: Error
}

function fakes(options: FakeOptions = {}) {
  const log: string[] = []
  const dbtQueue = [...(options.dbt ?? [])]
  const deps: PerformDeps = {
    sandbox: {
      async execute(target: SqlTarget, sql: string) {
        log.push(`sql:${target}:${sql}`)
        const scripted = options.sql?.[sql]
        if (scripted instanceof Error) throw scripted
        return scripted ?? []
      },
      isRelationMissing: (e: unknown) => e instanceof CatalogError,
      async prepareSandbox() {
        log.push("prepare")
        if (options.prepareError) throw options.prepareError
      },
      async release(target: SqlTarget) {
        log.push(`release:${target}`)
        if (options.releaseError) throw options.releaseError
      },
    },
    dbt: {
      async run(target: SqlTarget, args: string[]) {
        log.push(`dbt:${target}:${args.join(" ")}`)
        const next = dbtQueue.shift()
        if (next instanceof Error) throw next
        return next ?? { exitCode: 0, results: [], tail: "", timedOut: false }
      },
    },
  }
  return { deps, log }
}

const DONE: FaultAction = { type: "Done", report: { summary: { killed: 1 } } }

const sqlAction = (sequential: boolean, tasks: Array<[string, string, SqlTarget?, string?]>): FaultAction => ({
  type: "ExecuteSql",
  id: "a1",
  phase: "mutate",
  sequential,
  tasks: tasks.map(([id, sql, target, shape]) => ({
    id,
    sql,
    target: target ?? "Sandbox",
    expected_shape: (shape ?? "RowSet") as "RowSet",
  })),
})

const rebuild: FaultAction = {
  type: "RebuildNodes",
  id: "a3",
  producer_id: "seed.p.raw",
  fault_id: "p|seed.p.raw|drop_rows|*",
  node_ids: ["model.p.stg"],
  select: ["raw+"],
  exclude: ["raw"],
  full_refresh: true,
}

const runTests: FaultAction = {
  type: "RunTests",
  id: "a4",
  producer_id: "seed.p.raw",
  fault_id: "p|seed.p.raw|drop_rows|*",
  test_ids: ["test.p.unique_stg_id"],
  select: ["raw+"],
}

// ---------------------------------------------------------------------------
// Value rendering
// ---------------------------------------------------------------------------

describe("renderValue", () => {
  test("keeps every digit of a HUGEINT checksum", () => {
    const checksum = 170141183460469231731687303715884105727n
    expect(renderValue(checksum)).toBe("170141183460469231731687303715884105727")
    // The same value through Number would be 1.7014118346046923e+38.
    expect(renderValue(checksum)).not.toBe(String(Number(checksum)))
  })

  test("maps NULL to null and passes text through", () => {
    expect(renderValue(null)).toBeNull()
    expect(renderValue(undefined)).toBeNull()
    expect(renderValue("2024-01-02")).toBe("2024-01-02")
    expect(renderValue(42)).toBe("42")
    expect(renderValue(false)).toBe("false")
  })
})

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

describe("driveFaultInjectionSession", () => {
  test("performs each action in order and echoes its id", async () => {
    const session = scriptedSession([
      sqlAction(false, [["t1", "SELECT COUNT(*), SUM(h) FROM x", "Baseline", "SingleRow"]]),
      { type: "PrepareSandbox", id: "a2", purpose: "fault", producer_id: "seed.p.raw", fault_id: "p|seed.p.raw|drop_rows|*" },
      rebuild,
      runTests,
      DONE,
    ])
    const { deps, log } = fakes({
      sql: { "SELECT COUNT(*), SUM(h) FROM x": [[99n, 941742165569565516398n]] },
      dbt: [
        { exitCode: 0, results: [{ unique_id: "model.p.stg", status: "success" }], tail: "", timedOut: false },
        { exitCode: 1, results: [{ unique_id: "test.p.unique_stg_id", status: "fail" }], tail: "", timedOut: false },
      ],
    })

    const outcome = await driveFaultInjectionSession(session, deps)

    expect(outcome.report).toEqual({ summary: { killed: 1 } })
    expect(outcome.actions).toEqual({ ExecuteSql: 1, PrepareSandbox: 1, RebuildNodes: 1, RunTests: 1 })
    expect(Object.keys(outcome.perFaultMs)).toEqual(["p|seed.p.raw|drop_rows|*"])
    expect(session.stepped).toEqual([
      { type: "Sql", id: "a1", responses: [{ id: "t1", rows: [["99", "941742165569565516398"]] }] },
      { type: "Ok", id: "a2" },
      { type: "NodeResults", id: "a3", results: [{ unique_id: "model.p.stg", status: "success" }] },
      { type: "NodeResults", id: "a4", results: [{ unique_id: "test.p.unique_stg_id", status: "fail" }] },
    ])
    // The sandbox is released before each dbt invocation, and dbt runs single-threaded.
    expect(log).toEqual([
      "sql:Baseline:SELECT COUNT(*), SUM(h) FROM x",
      "prepare",
      "release:Sandbox",
      "dbt:Sandbox:run --threads 1 --full-refresh --select raw+ --exclude raw",
      "release:Sandbox",
      "dbt:Sandbox:test --threads 1 --select raw+",
    ])
  })

  test("returns the engine's error without performing anything further", async () => {
    const session = scriptedSession([{ type: "Error", message: "manifest has no nodes" }])
    const { deps, log } = fakes()
    const outcome = await driveFaultInjectionSession(session, deps)
    expect(outcome.error).toBe("manifest has no nodes")
    expect(outcome.report).toBeUndefined()
    expect(log).toEqual([])
  })

  test("rejects an action type it does not know", async () => {
    const session = scriptedSession([{ type: "Teleport", id: "a1" } as unknown as FaultAction])
    const outcome = await driveFaultInjectionSession(session, fakes().deps)
    expect(outcome.error).toBe("Unexpected action type: Teleport")
  })

  test("reports each fault once to the progress callback, retries included", async () => {
    const prepare: FaultAction = { type: "PrepareSandbox", id: "a1", purpose: "fault", producer_id: "seed.p.raw", fault_id: "f1" }
    const control: FaultAction = { type: "PrepareSandbox", id: "a0", purpose: "control", producer_id: "seed.p.raw" }
    const session = scriptedSession([control, prepare, { ...prepare, id: "a2" }, DONE])
    const events: unknown[] = []
    await driveFaultInjectionSession(session, fakes().deps, { onProgress: (e) => events.push(e) })
    expect(events).toEqual([
      { kind: "control", producer_id: "seed.p.raw" },
      { kind: "fault", fault_id: "f1", index: 1, total: 1 },
    ])
  })

  test("stops with FaultInjectionInterrupted when the signal aborts mid-run", async () => {
    const controller = new AbortController()
    const session = scriptedSession([sqlAction(false, [["t1", "SELECT 1"]]), rebuild, DONE])
    const { deps, log } = fakes()
    const original = deps.sandbox.execute
    deps.sandbox.execute = async (target, sql) => {
      controller.abort()
      return original(target, sql)
    }
    deps.signal = controller.signal

    await expect(driveFaultInjectionSession(session, deps, { signal: controller.signal })).rejects.toBeInstanceOf(
      FaultInjectionInterrupted,
    )
    // The rebuild that followed the abort never started.
    expect(log.some((entry) => entry.startsWith("dbt:"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SQL batches
// ---------------------------------------------------------------------------

describe("ExecuteSql", () => {
  test("a sequential batch stops at the first error and omits later tasks", async () => {
    const { deps, log } = fakes({ sql: { "DROP VIEW v": new Error("Binder Error: cannot drop") } })
    const result = await performAction(
      sqlAction(true, [
        ["t1", "SET threads = 1", "Sandbox", "Statement"],
        ["t2", "DROP VIEW v", "Sandbox", "Statement"],
        ["t3", "CREATE TABLE v AS SELECT 1", "Sandbox", "Statement"],
      ]) as any,
      deps,
    )
    expect(result).toEqual({
      type: "Sql",
      id: "a1",
      responses: [
        { id: "t1", rows: [] },
        { id: "t2", error: "Binder Error: cannot drop" },
      ],
    })
    expect(log).toEqual(["sql:Sandbox:SET threads = 1", "sql:Sandbox:DROP VIEW v"])
  })

  test("a non-sequential batch runs every task and reports errors per task", async () => {
    const { deps } = fakes({
      sql: { "SELECT * FROM gone": new CatalogError("Catalog Error: Table with name gone does not exist!"), "SELECT 2": [[2]] },
    })
    const result = await performAction(
      sqlAction(false, [
        ["t1", "SELECT * FROM gone"],
        ["t2", "SELECT 2"],
      ]) as any,
      deps,
    )
    expect(result).toEqual({
      type: "Sql",
      id: "a1",
      responses: [
        { id: "t1", error: "Catalog Error: Table with name gone does not exist!", relation_missing: true },
        { id: "t2", rows: [["2"]] },
      ],
    })
  })

  test("relation_missing is set only for catalog errors", async () => {
    const { deps } = fakes({ sql: { "SELECT bad": new Error("Conversion Error: could not cast") } })
    const result = (await performAction(sqlAction(false, [["t1", "SELECT bad"]]) as any, deps)) as any
    expect(result.responses[0].error).toContain("Conversion Error")
    expect(result.responses[0]).not.toHaveProperty("relation_missing")
  })

  test("a statement returns no rows even when the driver reports some", async () => {
    const { deps } = fakes({ sql: { "CREATE TABLE t AS SELECT 1": [[1n]] } })
    const result = (await performAction(
      sqlAction(true, [["t1", "CREATE TABLE t AS SELECT 1", "Sandbox", "Statement"]]) as any,
      deps,
    )) as any
    expect(result.responses).toEqual([{ id: "t1", rows: [] }])
  })

  test("error text is truncated", async () => {
    const { deps } = fakes({ sql: { "SELECT 1": new Error("x".repeat(5000)) } })
    const result = (await performAction(sqlAction(false, [["t1", "SELECT 1"]]) as any, deps)) as any
    expect(result.responses[0].error.length).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Sandbox and dbt failures
// ---------------------------------------------------------------------------

describe("sandbox and dbt actions", () => {
  test("a sandbox that cannot be prepared is reported as Failed", async () => {
    const { deps } = fakes({ prepareError: new Error("ENOSPC: no space left on device") })
    const result = await performAction(
      { type: "PrepareSandbox", id: "a2", purpose: "control", producer_id: "seed.p.raw" },
      deps,
    )
    expect(result).toEqual({ type: "Failed", id: "a2", message: "ENOSPC: no space left on device" })
  })

  test("a rebuild that writes no results is Failed, even on exit 0", async () => {
    for (const exitCode of [0, 2]) {
      const { deps } = fakes({ dbt: [{ exitCode, results: null, tail: "Runtime Error: database is locked", timedOut: false }] })
      const result = (await performAction(rebuild as any, deps)) as any
      expect(result.type).toBe("Failed")
      expect(result.id).toBe("a3")
      expect(result.message).toContain("dbt run produced no results")
      expect(result.message).toContain("database is locked")
      expect(result).not.toHaveProperty("timed_out")
    }
  })

  test("a dbt timeout is Failed with timed_out", async () => {
    const { deps } = fakes({ dbt: [{ exitCode: null, results: null, tail: "dbt run timed out after 50ms", timedOut: true }] })
    expect(await performAction(rebuild as any, deps)).toEqual({
      type: "Failed",
      id: "a3",
      message: "dbt run timed out after 50ms",
      timed_out: true,
    })
  })

  test("a failing model is a node result, not a failed action", async () => {
    const { deps } = fakes({
      dbt: [{ exitCode: 1, results: [{ unique_id: "model.p.stg", status: "error" }], tail: "", timedOut: false }],
    })
    expect(await performAction(rebuild as any, deps)).toEqual({
      type: "NodeResults",
      id: "a3",
      results: [{ unique_id: "model.p.stg", status: "error" }],
    })
  })

  test("dbt that cannot be started is Failed", async () => {
    const { deps } = fakes({ dbt: [new Error("spawn dbt ENOENT")] })
    expect(await performAction(runTests as any, deps)).toEqual({ type: "Failed", id: "a4", message: "spawn dbt ENOENT" })
  })

  test("dbt is not started when the sandbox cannot be released", async () => {
    const { deps, log } = fakes({ releaseError: new Error("DETACH failed") })
    const result = (await performAction(rebuild as any, deps)) as any
    expect(result.type).toBe("Failed")
    expect(result.message).toContain("could not release the sandbox")
    expect(log).toEqual(["release:Sandbox"])
  })

  test("an empty selector never reaches dbt, which would rebuild everything", async () => {
    const { deps, log } = fakes()
    const result = await performAction({ ...(rebuild as any), select: [], exclude: [] }, deps)
    expect(result).toEqual({ type: "NodeResults", id: "a3", results: [] })
    expect(log).toEqual([])
  })

  test("no test results is fine only when no test was expected", async () => {
    const none = { exitCode: 0, results: null, tail: "Nothing to do", timedOut: false }
    const expectedSome = (await performAction(runTests as any, fakes({ dbt: [none] }).deps)) as any
    expect(expectedSome.type).toBe("Failed")
    const expectedNone = await performAction({ ...(runTests as any), test_ids: [] }, fakes({ dbt: [none] }).deps)
    expect(expectedNone).toEqual({ type: "NodeResults", id: "a4", results: [] })
  })

  test("an interrupt during dbt propagates instead of being reported as a failure", async () => {
    const { deps } = fakes({ dbt: [new FaultInjectionInterrupted()] })
    await expect(performAction(rebuild as any, deps)).rejects.toBeInstanceOf(FaultInjectionInterrupted)
  })
})

// ---------------------------------------------------------------------------
// Early refusals
// ---------------------------------------------------------------------------

function tempProject(profile: string): { project: string; work: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-driver-test-"))
  const project = path.join(root, "project")
  const work = path.join(root, "work")
  fs.mkdirSync(project)
  fs.mkdirSync(work)
  fs.writeFileSync(path.join(project, "dbt_project.yml"), 'name: "p"\nprofile: "p"\n')
  fs.writeFileSync(path.join(project, "profiles.yml"), profile)
  return { project, work, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const neverLoaded = async (): Promise<never> => {
  throw new Error("the engine must not be loaded for an unsupported warehouse")
}

describe("early refusals", () => {
  test("an unsupported warehouse is named, with what is supported", () => {
    expect(() => resolveSandboxFactory("snowflake")).toThrow(
      "Fault injection does not support snowflake yet. It currently works on duckdb projects only",
    )
    expect(() => resolveSandboxFactory("DuckDB")).not.toThrow()
  })

  test("a non-DuckDB project fails before the engine loads or anything is copied", async () => {
    const { project, work, cleanup } = tempProject(
      "p:\n  target: dev\n  outputs:\n    dev:\n      type: snowflake\n      account: x\n",
    )
    try {
      const result = await runFaultInjection({ project_dir: project, work_dir: work }, { loadEngine: neverLoaded })
      expect(result.success).toBe(false)
      expect(result.error).toContain("does not support snowflake yet")
      expect(result.work_dir).toBeUndefined()
      expect(fs.readdirSync(work)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("a directory that is not a dbt project is refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fi-driver-test-"))
    try {
      const result = await runFaultInjection({ project_dir: dir })
      expect(result.success).toBe(false)
      expect(result.error).toContain("No dbt_project.yml")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const engineStub = async () => ({ Session: class {} as any, source: "package" as const })
  const dbtStub = async () => ({ path: "dbt", version: "1.10.0", env: {} })

  const refusals: Array<[string, string, string]> = [
    ["an in-memory database", "path: ':memory:'", "not a local DuckDB file"],
    ["MotherDuck", "path: 'md:prod'", "not a local DuckDB file"],
    ["attached databases", "path: db.duckdb\n      attach:\n        - path: other.duckdb", 'sets "attach"'],
    ["a database file that does not exist", "path: missing.duckdb", "DuckDB file not found"],
  ]
  for (const [what, config, message] of refusals) {
    test(`refuses ${what} and leaves no work directory behind`, async () => {
      const { project, work, cleanup } = tempProject(
        `p:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      ${config}\n`,
      )
      try {
        const result = await runFaultInjection(
          { project_dir: project, work_dir: work },
          { loadEngine: engineStub, resolveDbt: dbtStub },
        )
        expect(result.success).toBe(false)
        expect(result.error).toContain(message)
        expect(result.work_dir_removed).toBe(true)
        expect(fs.readdirSync(work)).toEqual([])
      } finally {
        cleanup()
      }
    })
  }

  test("refuses a database with a pending write-ahead log", async () => {
    const { project, work, cleanup } = tempProject("p:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: db.duckdb\n")
    try {
      fs.writeFileSync(path.join(project, "db.duckdb"), "not really a database")
      fs.writeFileSync(path.join(project, "db.duckdb.wal"), "")
      const result = await runFaultInjection(
        { project_dir: project, work_dir: work },
        { loadEngine: engineStub, resolveDbt: dbtStub },
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain("db.duckdb.wal exists")
      expect(fs.readFileSync(path.join(project, "db.duckdb"), "utf-8")).toBe("not really a database")
      expect(fs.readdirSync(work)).toEqual([])
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------------------

describe("isFaultInjectionEngineAvailable", () => {
  const ok = async () => ({ Session: class {} as never, source: "package" as const })
  const lacking = async () => {
    throw new Error(`Fault injection needs @altimateai/altimate-core ${FAULT_INJECTION_MIN_CORE_VERSION} or newer`)
  }

  test("true when the engine loads (tool is registered)", async () => {
    expect(await isFaultInjectionEngineAvailable(ok)).toBe(true)
  })

  test("false when the engine lacks the class (tool is not registered), without throwing", async () => {
    expect(await isFaultInjectionEngineAvailable(lacking)).toBe(false)
  })

  test("the command path still reports the clear version error when the engine lacks the class", async () => {
    const { project, work, cleanup } = tempProject(
      "p:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: x.duckdb\n",
    )
    try {
      const result = await runFaultInjection({ project_dir: project, work_dir: work }, { loadEngine: lacking })
      expect(result.success).toBe(false)
      expect(result.error).toContain(`needs @altimateai/altimate-core ${FAULT_INJECTION_MIN_CORE_VERSION} or newer`)
    } finally {
      cleanup()
    }
  })

  test("the default check is cached", async () => {
    resetFaultInjectionEngineAvailability()
    const first = isFaultInjectionEngineAvailable()
    expect(isFaultInjectionEngineAvailable()).toBe(first)
    await first
    resetFaultInjectionEngineAvailability()
  })
})

describe("loadFaultInjectionEngine", () => {
  class FakeSession {}
  const withClass = async () => ({ FaultInjectionSession: FakeSession })
  const withoutClass = async () => ({ DataParitySession: class {} })

  test("uses the package when it exports the class", async () => {
    const engine = await loadFaultInjectionEngine({}, true, withClass)
    expect(engine.source).toBe("package")
    expect(engine.Session as unknown).toBe(FakeSession)
  })

  test("without the class, names the minimum version", async () => {
    await expect(loadFaultInjectionEngine({}, true, withoutClass)).rejects.toThrow(
      `Fault injection needs @altimateai/altimate-core ${FAULT_INJECTION_MIN_CORE_VERSION} or newer`,
    )
  })

  test("a package that cannot be imported is reported, not thrown raw", async () => {
    const broken = async () => {
      throw new Error("Cannot find module")
    }
    await expect(loadFaultInjectionEngine({}, true, broken)).rejects.toThrow(
      "altimate-core NAPI module unavailable: Cannot find module",
    )
  })

  test("a published release ignores the development override and says so", async () => {
    const env = { [CORE_DEV_PATH_ENV]: "/nonexistent/altimate-core-node" }
    expect((await loadFaultInjectionEngine(env, false, withClass)).source).toBe("package")
    await expect(loadFaultInjectionEngine(env, false, withoutClass)).rejects.toThrow(
      `${CORE_DEV_PATH_ENV} is set but a published release does not honour it.`,
    )
  })

  test("a development override that does not exist is reported, not ignored", async () => {
    await expect(
      loadFaultInjectionEngine({ [CORE_DEV_PATH_ENV]: "/nonexistent/altimate-core-node" }, true, withClass),
    ).rejects.toThrow(`${CORE_DEV_PATH_ENV} points at "/nonexistent/altimate-core-node", which does not exist.`)
  })

  test("a development override is loaded from a directory or a file, and must export the class", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fi-driver-test-"))
    try {
      fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {}\n")
      await expect(loadFaultInjectionEngine({ [CORE_DEV_PATH_ENV]: dir }, true)).rejects.toThrow(
        "does not export FaultInjectionSession",
      )
      const good = path.join(dir, "good.js")
      fs.writeFileSync(good, "module.exports = { FaultInjectionSession: class {} }\n")
      const engine = await loadFaultInjectionEngine({ [CORE_DEV_PATH_ENV]: good }, true, withoutClass)
      expect(engine).toMatchObject({ source: "dev-override", path: good })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the pinned package either has the class or produces the version message", async () => {
    const core: any = await import("@altimateai/altimate-core")
    const load = loadFaultInjectionEngine({})
    if (typeof core.FaultInjectionSession === "function") expect((await load).source).toBe("package")
    else await expect(load).rejects.toThrow(`${FAULT_INJECTION_MIN_CORE_VERSION} or newer`)
  })
})

// ---------------------------------------------------------------------------
// Project and profile resolution
// ---------------------------------------------------------------------------

describe("readDbtTarget", () => {
  const twoTargets =
    "p:\n  target: \"{{ env_var('FI_TARGET', 'dev') }}\"\n  outputs:\n" +
    "    dev:\n      type: duckdb\n      path: \"{{ env_var('FI_DB') }}\"\n" +
    "    prod:\n      type: snowflake\n      account: x\n"

  test("resolves the default target and env_var() values, keeping the raw output", async () => {
    const { project, cleanup } = tempProject(twoTargets)
    try {
      const target = await readDbtTarget(project, { env: { FI_DB: "/data/db.duckdb" } })
      expect(target).toMatchObject({ profileName: "p", targetName: "dev", adapterType: "duckdb" })
      expect(target.output.path).toBe("/data/db.duckdb")
      expect(target.rawOutput.path).toBe("{{ env_var('FI_DB') }}")
      expect(target.profilesFile).toBe(path.join(project, "profiles.yml"))
    } finally {
      cleanup()
    }
  })

  test("--target wins over DBT_TARGET, which wins over the profile default", async () => {
    const { project, cleanup } = tempProject(twoTargets)
    try {
      expect((await readDbtTarget(project, { env: { FI_TARGET: "prod" } })).adapterType).toBe("snowflake")
      expect((await readDbtTarget(project, { env: { DBT_TARGET: "prod" } })).targetName).toBe("prod")
      expect((await readDbtTarget(project, { target: "dev", env: { DBT_TARGET: "prod" } })).targetName).toBe("dev")
    } finally {
      cleanup()
    }
  })

  test("an explicit profiles directory wins over DBT_PROFILES_DIR and the project", async () => {
    const { project, work, cleanup } = tempProject(twoTargets)
    try {
      fs.writeFileSync(path.join(work, "profiles.yml"), "p:\n  target: only\n  outputs:\n    only:\n      type: duckdb\n      path: x.duckdb\n")
      expect((await readDbtTarget(project, { env: { DBT_PROFILES_DIR: work } })).targetName).toBe("only")
      const other = path.join(work, "other")
      fs.mkdirSync(other)
      fs.writeFileSync(path.join(other, "profiles.yml"), "p:\n  target: third\n  outputs:\n    third:\n      type: duckdb\n      path: y.duckdb\n")
      expect((await readDbtTarget(project, { profilesDir: other, env: { DBT_PROFILES_DIR: work } })).targetName).toBe("third")
    } finally {
      cleanup()
    }
  })

  test("an explicit profiles directory without profiles.yml is an error, not a fallback", async () => {
    const { project, work, cleanup } = tempProject(twoTargets)
    try {
      fs.writeFileSync(path.join(project, "profiles.yml"), twoTargets)
      const empty = path.join(work, "empty")
      fs.mkdirSync(empty)
      await expect(readDbtTarget(project, { profilesDir: empty, env: {} })).rejects.toThrow("No profiles.yml in the requested profiles directory")
    } finally {
      cleanup()
    }
  })

  test("a missing profile or target is named", async () => {
    const { project, cleanup } = tempProject("other:\n  target: dev\n  outputs: {}\n")
    try {
      await expect(readDbtTarget(project, { env: {} })).rejects.toThrow('Profile "p" is not defined')
      fs.writeFileSync(path.join(project, "profiles.yml"), twoTargets)
      await expect(readDbtTarget(project, { target: "staging", env: {} })).rejects.toThrow(
        'Target "staging" is not defined for profile "p"',
      )
    } finally {
      cleanup()
    }
  })
})

describe("resolveProducers", () => {
  const manifest = {
    nodes: {
      "model.p.orders": { resource_type: "model", name: "orders" },
      "seed.p.raw_orders": { resource_type: "seed", name: "raw_orders" },
      "test.p.unique_orders_id": { resource_type: "test", name: "orders" },
    },
    sources: { "source.p.shop.orders": { resource_type: "source", name: "orders", source_name: "shop" } },
  }

  test("matches models, seeds and sources by name, and never tests", () => {
    expect(resolveProducers(manifest, "orders")).toEqual(["model.p.orders", "source.p.shop.orders"])
    expect(resolveProducers(manifest, "raw_orders")).toEqual(["seed.p.raw_orders"])
  })

  test("accepts a unique id or a qualified source name", () => {
    expect(resolveProducers(manifest, "model.p.orders")).toEqual(["model.p.orders"])
    expect(resolveProducers(manifest, "shop.orders")).toEqual(["source.p.shop.orders"])
    expect(resolveProducers(manifest, "nope")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// What the DuckDB strategy refuses after parsing
// ---------------------------------------------------------------------------

describe("DuckDbSandbox.assertManifestIsolated", () => {
  const sandbox = new DuckDbSandbox({
    projectDir: "/project",
    workDir: "/work",
    profileName: "p",
    targetName: "dev",
    output: { type: "duckdb", path: "shop.duckdb" },
    rawOutput: { type: "duckdb", path: "shop.duckdb" },
  })
  const model = (extra: Record<string, unknown> = {}) => ({
    resource_type: "model",
    name: "orders",
    database: "shop",
    config: { materialized: "table" },
    ...extra,
  })

  test("accepts a project that stays inside the copied database", () => {
    const manifest = {
      nodes: {
        a: model({ config: { materialized: "table", "post-hook": [{ sql: "analyze {{ this }}" }] } }),
        b: { resource_type: "operation", name: "on-run-start-0", raw_code: "create schema if not exists audit" },
        // A disabled model is never built, so what it would do does not matter.
        c: model({ database: "other", config: { enabled: false, materialized: "external" } }),
      },
      sources: { s: { resource_type: "source", name: "raw", database: "SHOP" } },
    }
    expect(() => sandbox.assertManifestIsolated(manifest)).not.toThrow()
  })

  const refused: Array<[string, Record<string, any>, string]> = [
    ["an external materialization", { nodes: { a: model({ config: { materialized: "external" } }) } }, '"external" materialization'],
    ["a model in another database", { nodes: { a: model({ database: "other" }) } }, 'a database other than "shop" (orders in other)'],
    ["a source in another database", { nodes: {}, sources: { s: { resource_type: "source", name: "raw", database: "lake" } } }, "raw in lake"],
    [
      "a post-hook that exports",
      { nodes: { a: model({ config: { materialized: "table", "post-hook": [{ sql: "COPY (select 1) TO 'exports/o.parquet'" }] } }) } },
      "hook(s) run ATTACH, COPY or EXPORT DATABASE",
    ],
    [
      "an on-run-start that attaches another database",
      { nodes: { op: { resource_type: "operation", name: "on-run-start-0", raw_code: "attach '/data/other.duckdb' as other" } } },
      "files outside the database (on-run-start-0)",
    ],
  ]
  for (const [what, manifest, message] of refused) {
    test(`refuses ${what}`, () => {
      expect(() => sandbox.assertManifestIsolated(manifest)).toThrow(message)
      expect(() => sandbox.assertManifestIsolated(manifest)).toThrow("Refusing to run")
    })
  }

  test("a catalog error is recognised wherever its line starts", () => {
    expect(sandbox.isRelationMissing(new Error("Catalog Error: Table with name x does not exist!"))).toBe(true)
    // The driver prefixes its own explanation when the text contains "locked".
    expect(
      sandbox.isRelationMissing(new Error('Database "x" is locked by another process.\nCatalog Error: Table with name blocked_users does not exist!')),
    ).toBe(true)
    expect(sandbox.isRelationMissing(new Error("Binder Error: column not found in Catalog Error: text"))).toBe(false)
  })

  test("a database named like a reserved DuckDB catalog is refused", () => {
    expect(
      () =>
        new DuckDbSandbox({
          projectDir: "/project",
          workDir: "/work",
          profileName: "p",
          targetName: "dev",
          output: { type: "duckdb", path: "memory.duckdb" },
          rawOutput: { type: "duckdb", path: "memory.duckdb" },
        }),
    ).toThrow('a DuckDB database called "memory" collides')
  })
})

// ---------------------------------------------------------------------------
// The dbt runner, against a fake dbt executable
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("createDbtRunner", () => {
  /** A stand-in for dbt: a shell script whose behaviour is chosen by FAKE_DBT_MODE. */
  function fakeDbt(): { runner: ReturnType<typeof createDbtRunner>; root: string; argvFile: string; cleanup: () => void; mode: (m: string) => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-dbt-runner-"))
    const script = path.join(root, "dbt")
    const argvFile = path.join(root, "argv.txt")
    fs.mkdirSync(path.join(root, "project"))
    fs.writeFileSync(
      script,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > "${argvFile}"`,
        `env | grep '^DBT_' | sort > "${argvFile}.env"`,
        `pwd > "${argvFile}.cwd"`,
        'target=""; prev=""',
        'for a in "$@"; do [ "$prev" = "--target-path" ] && target="$a"; prev="$a"; done',
        'case "$FAKE_DBT_MODE" in',
        '  results) mkdir -p "$target"; echo \'{"results":[{"unique_id":"model.p.a","status":"success","extra":1}]}\' > "$target/run_results.json"; echo "Done. PASS=1" ;;',
        '  noresults) echo "Runtime Error: could not open database" >&2; exit 2 ;;',
        "  hang) sleep 30 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    )
    const env: Record<string, string | undefined> = { ...process.env, DBT_DEFER: "true", DBT_FULL_REFRESH: "false", DBT_USER: "kept" }
    const runner = createDbtRunner({
      dbtPath: script,
      env,
      projectDir: path.join(root, "project"),
      workDir: root,
      dbtProfile: "p",
      dbtTarget: "dev",
      timeoutMs: 400,
      profilesDir: (target) => path.join(root, `profiles-${target.toLowerCase()}`),
    })
    return {
      runner,
      root,
      argvFile,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
      mode: (m) => void (env.FAKE_DBT_MODE = m),
    }
  }

  test("points dbt at the copy's profile, target and log paths and reads run_results.json", async () => {
    const fake = fakeDbt()
    try {
      fake.mode("results")
      const outcome = await fake.runner.run("Sandbox", ["run", "--select", "a+"])
      expect(outcome).toEqual({
        exitCode: 0,
        results: [{ unique_id: "model.p.a", status: "success" }],
        tail: "Done. PASS=1\n",
        timedOut: false,
      })
      expect(fs.readFileSync(fake.argvFile, "utf-8").trim().split("\n")).toEqual([
        "--no-use-colors",
        "run",
        "--project-dir",
        path.join(fake.root, "project"),
        "--profiles-dir",
        path.join(fake.root, "profiles-sandbox"),
        "--profile",
        "p",
        "--target",
        "dev",
        "--target-path",
        path.join(fake.root, "target-sandbox"),
        "--log-path",
        path.join(fake.root, "logs"),
        "--select",
        "a+",
      ])
      expect(fs.realpathSync(fs.readFileSync(`${fake.argvFile}.cwd`, "utf-8").trim())).toBe(
        fs.realpathSync(path.join(fake.root, "project")),
      )
      const dbtEnv = fs.readFileSync(`${fake.argvFile}.env`, "utf-8")
      // Flags that would change what the rebuild does are not inherited; the project's own variables are.
      expect(dbtEnv).not.toContain("DBT_DEFER=")
      expect(dbtEnv).not.toContain("DBT_FULL_REFRESH=")
      expect(dbtEnv).toContain("DBT_USER=kept")
      expect(dbtEnv).toContain(`DBT_TARGET_PATH=${path.join(fake.root, "target-sandbox")}`)
      expect(dbtEnv).toContain(`DBT_PROFILES_DIR=${path.join(fake.root, "profiles-sandbox")}`)
    } finally {
      fake.cleanup()
    }
  })

  test("results left by an earlier invocation are never mistaken for this one's", async () => {
    const fake = fakeDbt()
    try {
      fake.mode("results")
      await fake.runner.run("Sandbox", ["run"])
      fake.mode("noresults")
      const outcome = await fake.runner.run("Sandbox", ["run"])
      expect(outcome.exitCode).toBe(2)
      expect(outcome.results).toBeNull()
      expect(outcome.tail).toContain("could not open database")
    } finally {
      fake.cleanup()
    }
  })

  test("a run that exceeds the timeout is stopped and reported as timed out", async () => {
    const fake = fakeDbt()
    try {
      fake.mode("hang")
      const started = Date.now()
      const outcome = await fake.runner.run("Sandbox", ["run"])
      expect(outcome.timedOut).toBe(true)
      expect(outcome.results).toBeNull()
      expect(outcome.tail).toBe("dbt run timed out after 400ms")
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      fake.cleanup()
    }
  })

  test("an abort stops dbt and rejects with FaultInjectionInterrupted", async () => {
    const fake = fakeDbt()
    try {
      fake.mode("hang")
      const controller = new AbortController()
      const pending = fake.runner.run("Baseline", ["build"], controller.signal)
      // Abort once the fake dbt is demonstrably running.
      const started = Date.now()
      const poll = setInterval(() => {
        // Bounded: if dbt never starts, abort anyway rather than keep the process alive.
        if (!fs.existsSync(`${fake.argvFile}.cwd`) && Date.now() - started < 20_000) return
        clearInterval(poll)
        controller.abort()
      }, 10)
      try {
        await expect(pending).rejects.toBeInstanceOf(FaultInjectionInterrupted)
      } finally {
        clearInterval(poll)
      }
      // Already aborted: dbt is not started at all.
      fs.rmSync(fake.argvFile)
      await expect(fake.runner.run("Baseline", ["build"], controller.signal)).rejects.toBeInstanceOf(FaultInjectionInterrupted)
      expect(fs.existsSync(fake.argvFile)).toBe(false)
    } finally {
      fake.cleanup()
    }
  })

  test("a dbt executable that does not exist rejects instead of hanging", async () => {
    const runner = createDbtRunner({
      dbtPath: "/nonexistent/dbt",
      env: {},
      projectDir: os.tmpdir(),
      workDir: os.tmpdir(),
      dbtProfile: "p",
      dbtTarget: "dev",
      profilesDir: () => os.tmpdir(),
    })
    await expect(runner.run("Sandbox", ["run"])).rejects.toThrow("ENOENT")
  })
})

// ---------------------------------------------------------------------------
// The CLI command's exit codes
// ---------------------------------------------------------------------------

describe("fault-injection command", () => {
  const summary = (catchRate: number | null) => ({
    candidates: 4, selected: 4, executed: 4, killed: 1, slipped_through: 3, inert: 0, invalid: 0, skipped: 0, catch_rate: catchRate,
  })
  const okResult = (catchRate: number | null) => ({
    success: true,
    warehouse: "duckdb",
    budget: 20,
    report: { project: "p", dialect: "duckdb", dialect_verified: true, summary: summary(catchRate), slipped_through: [], results: [], controls: [], skipped: [], warnings: [] },
  })

  /** Run the handler with the driver replaced, capturing what it prints and the exit code it sets. */
  async function run(result: Record<string, any>, args: Record<string, unknown> = {}) {
    let received: Record<string, any> | undefined
    // Trigger lazy registration first so it cannot overwrite the stub.
    try {
      await Dispatcher.call("__trigger_hook__" as any, {} as any)
    } catch {}
    Dispatcher.register("dbt.fault_injection", async (params: any) => {
      received = params
      return result
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const write = process.stdout.write
    const error = console.error
    const before = process.exitCode
    process.stdout.write = ((chunk: any) => (stdout.push(String(chunk)), true)) as typeof process.stdout.write
    console.error = (...parts: unknown[]) => void stderr.push(parts.join(" "))
    try {
      process.exitCode = 0
      await (FaultInjectionCommand.handler as (a: any) => Promise<void>)({ budget: 20, format: "text", ...args })
      return { exitCode: process.exitCode, stdout: stdout.join(""), stderr: stderr.join("\n"), received }
    } finally {
      process.stdout.write = write
      console.error = error
      process.exitCode = before ?? 0
      // Handlers are process-wide; put the real one back for whatever runs next.
      Dispatcher.register("dbt.fault_injection", (params: any) => runFaultInjection(params))
    }
  }

  test("a successful run prints the report on stdout and exits 0", async () => {
    const out = await run(okResult(0.25), { project: "/p", model: "orders", "profiles-dir": "/profiles", "work-dir": "/w" })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain("Catch rate: 25.0%")
    expect(out.received).toMatchObject({ project_dir: "/p", model: "orders", budget: 20, profiles_dir: "/profiles", work_dir: "/w" })
    expect(out.received!.signal).toBeInstanceOf(AbortSignal)
  })

  test("--format json prints the whole result", async () => {
    const out = await run(okResult(0.25), { format: "json" })
    expect(JSON.parse(out.stdout).report.summary.killed).toBe(1)
  })

  test("--fail-under fails below the threshold and passes at it", async () => {
    expect((await run(okResult(0.25), { "fail-under": 25 })).exitCode).toBe(0)
    const below = await run(okResult(0.25), { "fail-under": 26 })
    expect(below.exitCode).toBe(1)
    expect(below.stderr).toContain("Catch rate 25.0% is below --fail-under 26.")
  })

  test("--fail-under compares exactly at the threshold despite floating-point rounding", async () => {
    // 0.29 * 100 is 28.999999999999996
    expect((await run(okResult(0.29), { "fail-under": 29 })).exitCode).toBe(0)
    expect((await run(okResult(0.57), { "fail-under": 57 })).exitCode).toBe(0)
  })

  test("--fail-under cannot pass when nothing was measured", async () => {
    const out = await run(okResult(null), { "fail-under": 10 })
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain("There is no catch rate to compare with --fail-under 10.")
  })

  test("a failed run exits 1 with the reason on stderr; an interrupted one exits 130", async () => {
    const failed = await run({ success: false, error: "The project does not build" })
    expect(failed.exitCode).toBe(1)
    expect(failed.stdout).toBe("")
    expect(failed.stderr).toContain("Fault injection failed: The project does not build")
    expect((await run({ success: false, interrupted: true, error: "Interrupted" })).exitCode).toBe(130)
  })

  test("invalid options are rejected before anything runs", async () => {
    for (const args of [{ budget: 0 }, { budget: 2.5 }, { "fail-under": 101 }, { seed: -1 }, { seed: Number.NaN }]) {
      const out = await run(okResult(0.5), args)
      expect(out.exitCode).toBe(1)
      expect(out.received).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

describe("report rendering", () => {
  const nodes = {
    "seed.p.raw_orders": { name: "raw_orders", resource_type: "seed", patch_path: "models/schema.yml" },
    "model.p.orders": { name: "orders", resource_type: "model" },
    "source.p.shop.payments": { name: "payments", resource_type: "source", source_name: "shop" },
  }
  const slipped = {
    fault_id: "p|seed.p.raw_orders|unit_scale|amount",
    producer_id: "seed.p.raw_orders",
    template: "unit_scale",
    column: "amount",
    outcome: "survived_impactful",
    affected_rows: 5,
    producer_rows: 99,
    tests_run: 4,
    failed_tests: [],
    build_errors: [],
    changed_relations: [
      {
        unique_id: "model.p.orders",
        baseline_rows: 99,
        rows: 99,
        comparison: { method: "keyed", key_columns: ["order_id"], rows_added: 0, rows_removed: 0, rows_changed: 5, columns: [{ column: "amount", rows_changed: 5 }] },
      },
    ],
    proposed_test: {
      test: "dbt_utils.accepted_range",
      node_id: "seed.p.raw_orders",
      resource_section: "seeds",
      column: "amount",
      yaml: "- dbt_utils.accepted_range:\n    min_value: 0\n    max_value: 30",
      rationale: "`amount` lies between 0 and 30 in the baseline.",
      verification: { baseline_failures: 0, sandbox_failures: 5, catches_fault: true },
    },
  }
  const result = {
    success: true,
    warehouse: "duckdb",
    database: "/p/db.duckdb",
    original_unchanged: true,
    work_dir: "/tmp/altimate-fault-injection-x",
    work_dir_removed: true,
    budget: 2,
    dbt: { path: "dbt", version: "1.10.23" },
    nodes,
    report: {
      project: "p",
      dialect: "duckdb",
      dialect_verified: true,
      summary: { candidates: 9, selected: 2, executed: 2, killed: 1, slipped_through: 1, inert: 0, invalid: 0, skipped: 0, catch_rate: 0.5 },
      slipped_through: [slipped],
      results: [slipped],
      controls: [],
      skipped: [],
      warnings: [],
    },
    timing: { total_ms: 30_000, setup_ms: 5_000, run_ms: 25_000, per_fault_ms: { a: 6_000, b: 4_000 } },
  }

  test("leads with the catch rate and lists each slipped fault with its test", () => {
    const text = formatFaultInjection(result as any)
    expect(text).toContain("Catch rate: 50.0% (1 of 2 faults that mattered were caught)")
    expect(text).toContain("2 of 9 candidate faults were selected (budget 2)")
    expect(text).toContain("1. seed raw_orders: `amount` multiplied by 100 in 5 of 99 rows")
    expect(text).toContain("model orders: 5 rows changed (amount: 5) of 99 (matched on order_id)")
    expect(text).toContain("Verified on the data: passes on the clean data and fails on the corrupted copy (5 failing).")
    expect(text).toContain("not evidence that the data in the warehouse today is wrong")
    expect(text).toContain("4 tests ran and none failed because of the fault.")
    expect(text).toContain("/p/db.duckdb is unchanged (same size and modification time as before the run).")
    expect(text).toContain("The work directory /tmp/altimate-fault-injection-x has been removed.")
    expect(text).toContain("2 faults 10s (5.0s each on average)")
    expect(summarizeFaultInjection(result as any)).toBe("catch rate 50.0% (1 caught, 1 slipped through)")
  })

  test("the proposed test is a complete, correctly indented schema block", () => {
    expect(proposedTestYaml(slipped.proposed_test, nodes, "1.10.23")).toBe(
      [
        "seeds:",
        "  - name: raw_orders",
        "    columns:",
        "      - name: amount",
        "        data_tests:",
        "          - dbt_utils.accepted_range:",
        "              min_value: 0",
        "              max_value: 30",
      ].join("\n"),
    )
  })

  test("a relation-level test on a source, on a dbt that predates data_tests", () => {
    const proposal = {
      test: "dbt_expectations.expect_table_row_count_to_be_between",
      node_id: "source.p.shop.payments",
      resource_section: "sources",
      yaml: "- dbt_expectations.expect_table_row_count_to_be_between:\n    min_value: 99",
    }
    expect(proposedTestYaml(proposal, nodes, "1.7.4")).toBe(
      [
        "sources:",
        "  - name: shop",
        "    tables:",
        "      - name: payments",
        "        tests:",
        "          - dbt_expectations.expect_table_row_count_to_be_between:",
        "              min_value: 99",
      ].join("\n"),
    )
  })

  test("a proposed test that was not verified is not presented as verified", () => {
    const unverified = { ...slipped, proposed_test: { ...slipped.proposed_test, verification: undefined } }
    const text = formatFaultInjection({ ...result, report: { ...result.report, slipped_through: [unverified] } } as any)
    expect(text).toContain("Not verified against the data.")
    expect(text).not.toContain("Verified on the data")
  })

  test("a fault with no stable test says why instead of proposing a brittle one", () => {
    const withheld = {
      ...slipped,
      proposed_test: undefined,
      proposal_note: "`days_open` is computed from the current date or time, so a range would fail as the clock moves.",
    }
    const text = formatFaultInjection({ ...result, report: { ...result.report, slipped_through: [withheld] } } as any)
    expect(text).toContain(
      "No test is proposed for this fault: `days_open` is computed from the current date or time, so a range would fail as the clock moves.",
    )
  })

  test("a singular test is shown as a file to add, with the reason it is not a schema entry", () => {
    const singular = {
      ...slipped,
      proposed_test: {
        form: "singular_sql",
        test: "range (singular test)",
        node_id: "model.pkg.stg_orders",
        resource_section: "models",
        column: "amount",
        yaml: "",
        file: "tests/fault_injection/fault_injection__stg_orders__range__amount.sql",
        sql: "SELECT * FROM {{ ref('pkg', 'stg_orders') }} WHERE \"amount\" < 0 OR \"amount\" > 1000\n",
        rationale: "`amount` lies between 0 and 30 in the baseline.",
        verification: { baseline_failures: 0, sandbox_failures: 5, catches_fault: true },
      },
    }
    const packaged = { ...nodes, "model.pkg.stg_orders": { name: "stg_orders", resource_type: "model", package_name: "pkg" } }
    const text = formatFaultInjection({ ...result, nodes: packaged, report: { ...result.report, slipped_through: [singular] } } as any)
    expect(text).toContain("belongs to the installed package pkg")
    expect(text).toContain("This is a singular test instead (plain SQL, no package needed).")
    expect(text).toContain("Save as tests/fault_injection/fault_injection__stg_orders__range__amount.sql")
    expect(text).toContain("SELECT * FROM {{ ref('pkg', 'stg_orders') }}")
    expect(text).not.toContain("data_tests:")
  })

  test("the reason a singular test was chosen is the engine's, not a guess about packages", () => {
    const quoted = {
      ...slipped,
      proposed_test: {
        form: "singular_sql",
        test: "not_null (singular test)",
        node_id: "seed.p.raw_orders",
        resource_section: "seeds",
        column: "Order ID",
        yaml: "",
        file: "tests/fault_injection/fault_injection__raw_orders__not_null__order_id.sql",
        sql: 'SELECT * FROM {{ ref(\'raw_orders\') }} WHERE "Order ID" IS NULL\n',
        singular_reason:
          "dbt writes column names and accepted values into its standard tests without quoting them, so a name or value like this one would break the standard test.",
        verification: { baseline_failures: 0, sandbox_failures: 5, catches_fault: true },
      },
    }
    const text = formatFaultInjection({ ...result, report: { ...result.report, slipped_through: [quoted] } } as any)
    expect(text).toContain("without quoting them")
    expect(text).not.toContain("has not installed")
    expect(text).not.toContain("installed package")
  })

  test("a keyed comparison without key columns still renders", () => {
    const keyless = {
      ...slipped,
      changed_relations: [
        { unique_id: "model.p.orders", baseline_rows: 99, rows: 99, comparison: { method: "keyed", rows_added: 0, rows_removed: 0, rows_changed: 5, columns: [] } },
      ],
    }
    const text = formatFaultInjection({ ...result, report: { ...result.report, slipped_through: [keyless] } } as any)
    expect(text).toContain("5 rows changed of 99")
    expect(text).not.toContain("matched on")
  })

  test("a node named like a YAML boolean or null is quoted", () => {
    const proposal = { test: "unique", node_id: "model.p.true", resource_section: "models", column: "null", yaml: "- unique" }
    const yaml = proposedTestYaml(proposal, { "model.p.true": { name: "true", resource_type: "model" } } as any, "1.10.0")
    expect(yaml).toContain('- name: "true"')
    expect(yaml).toContain('- name: "null"')
  })

  test("row-level detail from a sampled comparison says what the per-column counts cover", () => {
    const sampled = {
      ...slipped,
      changed_relations: [
        {
          unique_id: "model.p.orders",
          baseline_rows: 600000,
          rows: 600000,
          comparison: { method: "keyed", key_columns: ["order_id"], rows_added: 0, rows_removed: 0, rows_changed: 30000, sampled_rows: 20000, columns: [{ column: "amount", rows_changed: 20000 }] },
        },
      ],
    }
    const text = formatFaultInjection({ ...result, report: { ...result.report, slipped_through: [sampled] } } as any)
    expect(text).toContain("30000 rows changed (amount: 20000; the per-column counts cover the first 20000 changed rows by key)")
  })

  test("a failure says what happened and what became of the copies", () => {
    const text = formatFaultInjection({
      success: false,
      error: "The project does not build",
      database: "/p/db.duckdb",
      original_unchanged: true,
      work_dir: "/tmp/x",
      work_dir_removed: true,
    })
    expect(text).toBe(
      "Fault injection failed: The project does not build\n" +
        "/p/db.duckdb is unchanged (same size and modification time as before the run).\n" +
        "The work directory /tmp/x has been removed.",
    )
    expect(summarizeFaultInjection({ success: false, interrupted: true })).toBe("interrupted")
  })

  test("never claims the database is unchanged when that was not established", () => {
    const changed = formatFaultInjection({
      success: false,
      error: "/p/db.duckdb changed during the run (its size or modification time differs).",
      database: "/p/db.duckdb",
      original_unchanged: false,
      work_dir: "/tmp/x",
      work_dir_removed: false,
    })
    expect(changed).not.toContain("is unchanged")
    expect(changed).toContain("The work directory /tmp/x could not be removed; delete it by hand.")
    // Refused before the database was examined: nothing is claimed either way.
    const early = formatFaultInjection({ success: false, error: "Refusing to run", database: "/p/db.duckdb", work_dir: "/tmp/x", work_dir_removed: true })
    expect(early).not.toContain("is unchanged")
  })

  test("the catch rate is rounded down, so a slipped fault never reads as 100%", () => {
    expect(formatRate(0.9996)).toBe("99.9%")
    expect(formatRate(0.6538461538461539)).toBe("65.3%")
    expect(formatRate(1)).toBe("100.0%")
    expect(formatRate(0)).toBe("0.0%")
  })

  test("the budget is blamed only when it was the limit", () => {
    const summary = { ...result.report.summary, selected: 2, candidates: 9 }
    const limited = formatFaultInjection({ ...result, budget: 2, report: { ...result.report, summary } } as any)
    expect(limited).toContain("2 of 9 candidate faults were selected (budget 2). Raise the budget to run more.")
    const notLimited = formatFaultInjection({ ...result, budget: 20, report: { ...result.report, summary } } as any)
    expect(notLimited).toContain("2 of 9 candidate faults were selected.")
    expect(notLimited).not.toContain("Raise the budget")
  })

  test("a node from an installed package is not presented as editable in this project", () => {
    const packaged = { ...nodes, "seed.p.raw_orders": { ...nodes["seed.p.raw_orders"], package_name: "vendor_pkg" } }
    const text = formatFaultInjection({ ...result, nodes: packaged } as any)
    expect(text).toContain("The node belongs to the installed package vendor_pkg (models/schema.yml there).")
    expect(text).not.toContain("(the node is described in models/schema.yml)")
    // The same node in the project itself is pointed at directly.
    const own = { ...nodes, "seed.p.raw_orders": { ...nodes["seed.p.raw_orders"], package_name: "p" } }
    expect(formatFaultInjection({ ...result, nodes: own } as any)).toContain("(the node is described in models/schema.yml)")
  })

  test("names that are not plain identifiers are quoted in the YAML", () => {
    const proposal = { test: "not_null", node_id: "seed.p.raw_orders", resource_section: "seeds", column: "Order Date", yaml: "- not_null" }
    expect(proposedTestYaml(proposal, nodes, "1.10.0")).toContain('      - name: "Order Date"\n')
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as core from "@altimateai/altimate-core"
import { SessionID, MessageID } from "../../../src/session/schema"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import { SqlMaterializeTool } from "../../../src/altimate/tools/sql-materialize"
import { PostConnectSuggestions } from "../../../src/altimate/tools/post-connect-suggestions"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch, getScratch } from "../../../src/altimate/native/connections/scratch"
import * as Cache from "../../../src/altimate/native/schema/cache"
import { initTool } from "../tool-fixture"

const ctx = {
  sessionID: SessionID.make("ses_sql_execute_lint"),
  messageID: MessageID.make("msg_sql_execute_lint"),
  callID: "",
  agent: "analyst",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async () => {},
}

const warehouse = "lint_fixture"
const riskySql = "SELECT CAST(a / b AS INT) AS ratio FROM lint_numbers ORDER BY a"
const cleanSql = "SELECT a, b FROM lint_numbers ORDER BY a"
const cache = Cache.SchemaCache.createInMemory()
let cacheSpy: ReturnType<typeof spyOn<typeof Cache, "getCache">>
let lintSpy: ReturnType<typeof spyOn<typeof core, "lint">> | undefined
let previousTelemetry: string | undefined
let previousLint: string | undefined

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  previousLint = process.env.ALTIMATE_SQL_EXECUTE_LINT
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  cacheSpy = spyOn(Cache, "getCache").mockResolvedValue(cache)
})

beforeEach(async () => {
  delete process.env.ALTIMATE_SQL_EXECUTE_LINT
  PostConnectSuggestions.resetShownSuggestions()
  // Consume the one-time tip so output comparisons isolate the result and checks.
  PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
  Registry.setConfigs({ [warehouse]: { type: "sqlite", path: ":memory:" } })
  const source = await Registry.get(warehouse)
  await source.execute("CREATE TABLE lint_numbers (a INTEGER, b INTEGER)")
  await source.execute("INSERT INTO lint_numbers VALUES (1, 2), (5, 2)")
})

afterEach(async () => {
  // preValidateSql yields before accessing the cache; let that work finish before teardown.
  await new Promise<void>((resolve) => setImmediate(resolve))
  lintSpy?.mockRestore()
  lintSpy = undefined
  await Registry.closeAll()
  await closeScratch()
})

afterAll(() => {
  cacheSpy.mockRestore()
  cache.close()
  Registry.reset()
  PostConnectSuggestions.resetShownSuggestions()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
  if (previousLint === undefined) delete process.env.ALTIMATE_SQL_EXECUTE_LINT
  else process.env.ALTIMATE_SQL_EXECUTE_LINT = previousLint
})

describe("sql_execute inline lint", () => {
  test("appends real core findings without changing the successful result preview", async () => {
    const tool = await initTool(SqlExecuteTool)
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    const baseline = await tool.execute({ query: riskySql, warehouse, limit: 10 }, ctx)
    delete process.env.ALTIMATE_SQL_EXECUTE_LINT

    const result = await tool.execute({ query: riskySql, warehouse, limit: 10 }, ctx)
    expect(result.metadata.error).toBeUndefined()
    expect(result.metadata.rowCount).toBe(2)
    expect(result.output).toStartWith(baseline.output + "\n\nChecks:\n")
    expect(result.output).toMatch(/Check: cast_division_to_int: .+ — .+/)
    expect(result.output).not.toContain("select-without-limit")
    expect(result.metadata.lint_rules).toContain("cast_division_to_int")
  })

  test("clean queries have no checks block or lint metadata", async () => {
    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute({ query: cleanSql, warehouse, limit: 10 }, ctx)
    expect(result.metadata.error).toBeUndefined()
    expect(result.metadata.rowCount).toBe(2)
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
  })

  test("the environment opt-out skips the core linter", async () => {
    const tool = await initTool(SqlExecuteTool)
    lintSpy = spyOn(core, "lint")
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    const result = await tool.execute({ query: riskySql, warehouse, limit: 10 }, ctx)
    expect(result.metadata.error).toBeUndefined()
    expect(result.metadata.rowCount).toBe(2)
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
    expect(lintSpy).not.toHaveBeenCalled()
  })

  test("a core lint error leaves the successful query result untouched", async () => {
    const tool = await initTool(SqlExecuteTool)
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    const baseline = await tool.execute({ query: riskySql, warehouse, limit: 10 }, ctx)
    delete process.env.ALTIMATE_SQL_EXECUTE_LINT
    lintSpy = spyOn(core, "lint").mockImplementation(() => {
      throw new Error("lint unavailable")
    })

    const result = await tool.execute({ query: riskySql, warehouse, limit: 10 }, ctx)
    expect(lintSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual(baseline)
  })

  test("successful writes never invoke the linter", async () => {
    const tool = await initTool(SqlExecuteTool)
    lintSpy = spyOn(core, "lint")
    const result = await tool.execute(
      { query: "INSERT INTO lint_numbers SELECT CAST(a / b AS INT), b FROM lint_numbers", warehouse, limit: 10 },
      ctx,
    )
    expect(result.metadata.error).toBeUndefined()
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
    expect(lintSpy).not.toHaveBeenCalled()
  })

  test("failed reads never invoke the linter", async () => {
    const tool = await initTool(SqlExecuteTool)
    lintSpy = spyOn(core, "lint")
    const result = await tool.execute(
      { query: "SELECT CAST(a / b AS INT) FROM missing_lint_table", warehouse, limit: 10 },
      ctx,
    )
    expect(result.metadata.error).toBeDefined()
    expect(result.output).toContain("Failed to execute SQL:")
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
    expect(lintSpy).not.toHaveBeenCalled()
  })
})

describe("sql_materialize inline lint", () => {
  test("checks the original source SQL and keeps the extracted rows", async () => {
    const tool = await initTool(SqlMaterializeTool)
    lintSpy = spyOn(core, "lint")
    const result = await tool.execute({ source_warehouse: warehouse, sql: riskySql, target_table: "lint_ratios" }, ctx)
    expect(result.metadata).toMatchObject({ materialized: true, rowCount: 2 })
    expect(result.metadata.error).toBeUndefined()
    expect(result.output).toContain("Checks:\nCheck: cast_division_to_int:")
    expect(result.metadata.lint_rules).toContain("cast_division_to_int")
    expect(lintSpy).toHaveBeenCalledTimes(1)
    expect(lintSpy.mock.calls[0][0]).toBe(riskySql)
    const scratch = await getScratch(ctx.sessionID)
    expect(
      (await scratch.execute("SELECT ratio FROM lint_ratios ORDER BY ratio")).rows.map((r) => Number(r[0])),
    ).toEqual([0, 2])
  })

  test("clean source SQL has no checks block", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const result = await tool.execute({ source_warehouse: warehouse, sql: cleanSql, target_table: "lint_clean" }, ctx)
    expect(result.metadata).toMatchObject({ materialized: true, rowCount: 2 })
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
  })

  test("the environment opt-out skips source lint", async () => {
    const tool = await initTool(SqlMaterializeTool)
    lintSpy = spyOn(core, "lint")
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    const result = await tool.execute(
      { source_warehouse: warehouse, sql: riskySql, target_table: "lint_disabled" },
      ctx,
    )
    expect(result.metadata).toMatchObject({ materialized: true, rowCount: 2 })
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
    expect(lintSpy).not.toHaveBeenCalled()
  })

  test("a lint error does not turn successful materialization into a failure", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const args = { source_warehouse: warehouse, sql: riskySql, target_table: "lint_error", mode: "replace" }
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    const baseline = await tool.execute(args, ctx)
    delete process.env.ALTIMATE_SQL_EXECUTE_LINT
    lintSpy = spyOn(core, "lint").mockImplementation(() => {
      throw new Error("lint unavailable")
    })

    const result = await tool.execute(args, ctx)
    expect(lintSpy).toHaveBeenCalledTimes(1)
    expect(result.metadata).toMatchObject({ materialized: true, rowCount: 2 })
    expect(result).toEqual(baseline)
  })

  test("a failed source query never invokes the linter", async () => {
    const tool = await initTool(SqlMaterializeTool)
    lintSpy = spyOn(core, "lint")
    const result = await tool.execute(
      {
        source_warehouse: warehouse,
        sql: "SELECT CAST(a / b AS INT) FROM missing_lint_table",
        target_table: "lint_failed",
      },
      ctx,
    )
    expect(result.metadata.materialized).toBe(false)
    expect(result.metadata.error).toBeDefined()
    expect(result.output).not.toContain("Checks:")
    expect(result.metadata.lint_rules).toBeUndefined()
    expect(lintSpy).not.toHaveBeenCalled()
  })
})

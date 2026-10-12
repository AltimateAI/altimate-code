import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as core from "@altimateai/altimate-core"
import * as Registry from "../../../src/altimate/native/connections/registry"
import * as Cache from "../../../src/altimate/native/schema/cache"
import type { SchemaSearchColumnResult } from "../../../src/altimate/native/types"
import { formatSqlLint, lintSqlResult } from "../../../src/altimate/tools/sql-result-lint"

const rules = [
  "cast_division_to_int",
  "sum_of_ratio",
  "join_fan_out",
  "non_deterministic_dedup",
  "null_in_in_list",
  "not_in_nullable",
  "greatest_least_null",
  "typed_coalesce_mismatch",
  "null_propagating_concat",
  "union_without_all",
  "implicit_cross_join",
  "join_without_condition",
  "outer_join_filter_in_where",
  "count_star_vs_column",
  "division_by_column_no_guard",
  "integer_division",
  "limit_without_order_by",
  "avg_of_avg",
  "reserved_word_alias",
]

function finding(rule = "cast_division_to_int", severity = "warning") {
  return { rule, severity, message: "Division loses precision", suggestion: "Keep a decimal result" }
}

describe("formatSqlLint", () => {
  for (const rule of rules) {
    test(`keeps ${rule}`, () => {
      expect(formatSqlLint([finding(rule)])).toEqual({
        output: `Checks:\nCheck: ${rule}: Division loses precision — Keep a decimal result`,
        rules: [rule],
      })
    })
  }

  test("drops unrelated and Info findings before applying the three-finding limit", () => {
    const result = formatSqlLint([
      finding("select_star"),
      finding("integer_division", "Info"),
      finding("avg_of_avg", "INFO"),
      finding("join_fan_out", "info"),
      finding("cast_division_to_int", "error"),
      finding("not_in_nullable", "Warning"),
      finding("sum_of_ratio"),
      finding("limit_without_order_by"),
    ])
    expect(result.rules).toEqual(["cast_division_to_int", "not_in_nullable", "sum_of_ratio"])
    expect(result.output.split("\n")).toHaveLength(4)
    expect(result.output).not.toContain("limit_without_order_by")
  })

  test("collapses messages and suggestions to one line each", () => {
    expect(
      formatSqlLint([
        { ...finding(), message: "  Division\n loses\tprecision ", suggestion: " Keep\r\na decimal  result " },
      ]).output,
    ).toBe("Checks:\nCheck: cast_division_to_int: Division loses precision — Keep a decimal result")
  })

  test("omits a missing suggestion and the header when no finding survives", () => {
    expect(formatSqlLint([{ ...finding(), suggestion: undefined }]).output).toBe(
      "Checks:\nCheck: cast_division_to_int: Division loses precision",
    )
    expect(formatSqlLint([finding("select_star"), finding("integer_division", "info")])).toEqual({
      output: "",
      rules: [],
    })
    expect(formatSqlLint([])).toEqual({ output: "", rules: [] })
  })

  test("records each displayed rule only once", () => {
    const result = formatSqlLint([finding(), finding(), finding("not_in_nullable")])
    expect(result.output.split("\n")).toHaveLength(4)
    expect(result.rules).toEqual(["cast_division_to_int", "not_in_nullable"])
  })
})

describe("lintSqlResult", () => {
  const spies: { mockRestore(): void }[] = []
  let cache: Cache.SchemaCache
  let previousLint: string | undefined
  let session = 0
  const nextSession = () => `sql-result-lint-${++session}`
  const report: core.LintResult = {
    sql: "SELECT CAST(3 / 2 AS INT)",
    findings: [{ ...finding(), severity: "warning", code: "fixture" }],
    error_count: 0,
    warning_count: 1,
    clean: false,
  }

  function track<T extends { mockRestore(): void }>(spy: T): T {
    spies.push(spy)
    return spy
  }

  function status(lastIndexed: string) {
    return {
      warehouses: [
        {
          name: "warehouse",
          type: "postgresql",
          last_indexed: lastIndexed,
          databases_count: 2,
          schemas_count: 2,
          tables_count: 2,
          columns_count: 2,
        },
      ],
      total_tables: 2,
      total_columns: 2,
      cache_path: ":memory:",
    }
  }

  beforeEach(() => {
    previousLint = process.env.ALTIMATE_SQL_EXECUTE_LINT
    delete process.env.ALTIMATE_SQL_EXECUTE_LINT
    cache = Cache.SchemaCache.createInMemory()
    track(spyOn(Cache, "getCache").mockResolvedValue(cache))
    track(spyOn(Registry, "list").mockReturnValue({ warehouses: [{ name: "warehouse", type: "postgresql" }] }))
    track(
      spyOn(Registry, "getConfig").mockImplementation((name) =>
        name === "warehouse" ? { type: "postgresql" } : { type: "duckdb" },
      ),
    )
  })

  afterEach(() => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore()
    cache.close()
    if (previousLint === undefined) delete process.env.ALTIMATE_SQL_EXECUTE_LINT
    else process.env.ALTIMATE_SQL_EXECUTE_LINT = previousLint
  })

  test("uses the explicit warehouse dialect with an empty schema", async () => {
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    expect(await lintSqlResult(report.sql, "scratch", nextSession())).toEqual(formatSqlLint(report.findings))
    expect(lint).toHaveBeenCalledTimes(1)
    expect(lint.mock.calls[0][1].toJson()).toMatchObject({
      dialect: "duckdb",
      tables: { _empty_: { columns: [{ name: "id", type: "INT", nullable: true }] } },
    })
  })

  test("uses the default warehouse's canonical dialect", async () => {
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    await lintSqlResult(report.sql, undefined, nextSession())
    expect(lint).toHaveBeenCalledTimes(1)
    expect(lint.mock.calls[0][1].toJson().dialect).toBe("postgres")
  })

  for (const type of ["sqlserver", "mssql", "fabric"]) {
    test(`maps the ${type} warehouse dialect to core's tsql dialect`, async () => {
      track(spyOn(Registry, "getConfig").mockReturnValue({ type }))
      const lint = track(spyOn(core, "lint").mockReturnValue(report))
      await lintSqlResult(report.sql, "warehouse", nextSession())
      expect(lint).toHaveBeenCalledTimes(1)
      expect(lint.mock.calls[0][1].toJson().dialect).toBe("tsql")
    })
  }

  test("preserves fresh cached types, nullability, and fully qualified table names", async () => {
    const columns: SchemaSearchColumnResult[] = [
      {
        warehouse: "warehouse",
        database: "db1",
        schema_name: "public",
        table: "numbers",
        name: "a",
        data_type: "INTEGER",
        nullable: false,
        fqn: "db1.public.numbers.a",
      },
      {
        warehouse: "warehouse",
        database: "db2",
        schema_name: "public",
        table: "numbers",
        name: "a",
        data_type: "BIGINT",
        nullable: true,
        fqn: "db2.public.numbers.a",
      },
    ]
    track(spyOn(cache, "cacheStatus").mockReturnValue(status(new Date().toISOString())))
    const listColumns = track(spyOn(cache, "listColumns").mockReturnValue([...columns, columns[0]]))
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    await lintSqlResult("SELECT a / 2 FROM db1.public.numbers", "warehouse", nextSession())
    expect(listColumns).toHaveBeenCalledWith("warehouse", 500_000)
    expect(lint.mock.calls[0][1].toJson()).toMatchObject({
      dialect: "postgres",
      tables: {
        "db1.public.numbers": { columns: [{ name: "a", type: "INTEGER", nullable: false }] },
        "db2.public.numbers": { columns: [{ name: "a", type: "BIGINT", nullable: true }] },
      },
    })
    expect(lint.mock.calls[0][1].tableNames()).toHaveLength(2)
  })

  for (const lastIndexed of [new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), "invalid-date"]) {
    test(`ignores stale or invalid cache timestamp: ${lastIndexed}`, async () => {
      track(spyOn(cache, "cacheStatus").mockReturnValue(status(lastIndexed)))
      const columns = track(spyOn(cache, "listColumns"))
      const lint = track(spyOn(core, "lint").mockReturnValue(report))
      await lintSqlResult(report.sql, "warehouse", nextSession())
      expect(columns).not.toHaveBeenCalled()
      expect(lint.mock.calls[0][1].tableNames()).toEqual(["_empty_"])
    })
  }

  test("returns no block for a clean lint", async () => {
    track(spyOn(core, "lint").mockReturnValue({ ...report, findings: [], warning_count: 0, clean: true }))
    expect(await lintSqlResult("SELECT 1", "warehouse", nextSession())).toBeUndefined()
  })

  test("bypasses lint for writes, mixed statements, and the opt-out environment variable", async () => {
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    expect(await lintSqlResult("UPDATE numbers SET a = 0", "warehouse", nextSession())).toBeUndefined()
    expect(await lintSqlResult("SELECT 1; DELETE FROM numbers", "warehouse", nextSession())).toBeUndefined()
    expect(await lintSqlResult("SELECT a INTO copied FROM numbers", "warehouse", nextSession())).toBeUndefined()
    expect(
      await lintSqlResult(
        "WITH moved AS (DELETE FROM numbers RETURNING a) SELECT * FROM moved",
        "warehouse",
        nextSession(),
      ),
    ).toBeUndefined()
    expect(await lintSqlResult("SELECT nextval('sequence')", "warehouse", nextSession())).toBeUndefined()
    process.env.ALTIMATE_SQL_EXECUTE_LINT = "0"
    expect(await lintSqlResult(report.sql, "warehouse", nextSession())).toBeUndefined()
    expect(lint).not.toHaveBeenCalled()
    expect(Cache.getCache).not.toHaveBeenCalled()
  })

  test("swallows a lint error without disabling later lints in the session", async () => {
    const id = nextSession()
    const lint = track(
      spyOn(core, "lint")
        .mockImplementationOnce(() => {
          throw new Error("native lint failed")
        })
        .mockReturnValue(report),
    )
    expect(await lintSqlResult(report.sql, "warehouse", id)).toBeUndefined()
    expect(await lintSqlResult(report.sql, "warehouse", id)).toEqual(formatSqlLint(report.findings))
    expect(lint).toHaveBeenCalledTimes(2)
  })

  test("swallows a schema cache failure", async () => {
    track(spyOn(Cache, "getCache").mockRejectedValueOnce(new Error("cache unavailable")))
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    expect(await lintSqlResult(report.sql, "warehouse", nextSession())).toBeUndefined()
    expect(lint).not.toHaveBeenCalled()
  })

  test("discards a synchronous over-budget lint and disables only its session", async () => {
    let now = 0
    track(spyOn(performance, "now").mockImplementation(() => now))
    const lint = track(
      spyOn(core, "lint")
        .mockImplementationOnce(() => {
          now = 251
          return report
        })
        .mockReturnValue(report),
    )
    const id = nextSession()
    expect(await lintSqlResult(report.sql, "warehouse", id)).toBeUndefined()
    expect(await lintSqlResult(report.sql, "warehouse", id)).toBeUndefined()
    expect(lint).toHaveBeenCalledTimes(1)
    expect(await lintSqlResult(report.sql, "warehouse", nextSession())).toEqual(formatSqlLint(report.findings))
    expect(lint).toHaveBeenCalledTimes(2)
  })

  test("times out asynchronous preparation and skips late and future lint work in that session", async () => {
    let release!: (cache: Cache.SchemaCache) => void
    track(
      spyOn(Cache, "getCache").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      ),
    )
    const lint = track(spyOn(core, "lint").mockReturnValue(report))
    const id = nextSession()
    expect(await lintSqlResult(report.sql, "warehouse", id)).toBeUndefined()
    release(cache)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await lintSqlResult(report.sql, "warehouse", id)).toBeUndefined()
    expect(lint).not.toHaveBeenCalled()
    expect(await lintSqlResult(report.sql, "warehouse", nextSession())).toEqual(formatSqlLint(report.findings))
    expect(lint).toHaveBeenCalledTimes(1)
  })
})

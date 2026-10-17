import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { TestInstance, testInstanceStoreLayer, tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { initTool } from "../tool-fixture"
import { Agent } from "../../../src/agent/agent"
import { Permission } from "../../../src/permission"
import { PermissionNext } from "../../../src/permission/next"
import { Bus } from "../../../src/bus"
import { Instance } from "../../../src/project/instance"
import { SessionID } from "../../../src/session/schema"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch, getScratch } from "../../../src/altimate/native/connections/scratch"
import { checkSql, readSql, SqlCheckTool } from "../../../src/altimate/tools/sql-check"
import { maskSql, statementsOf, tokenizeSql } from "../../../src/altimate/tools/sql-tokenize"

const statements = [
  "CREATE TABLE orders (id INTEGER, customer_id INTEGER, kind TEXT, amount REAL, note TEXT)",
  "INSERT INTO orders VALUES (1, 10, 'a', 5.5, 'first'), (2, 11, 'b', 7, NULL), (3, 10, 'a', 1.25, NULL), (4, 99, 'z', 3, 'tail'), (5, NULL, 'a', NULL, NULL)",
  "CREATE TABLE customers (customer_id INTEGER, kind TEXT, name TEXT)",
  "INSERT INTO customers VALUES (10, 'a', 'Ada'), (10, 'a', 'Another Ada'), (11, 'b', 'Bob'), (12, 'q', 'Cy'), (NULL, 'a', 'Unknown')",
  "CREATE TABLE left_keys (key_value TEXT)",
  "INSERT INTO left_keys VALUES ('same'), ('same'), ('ABC'), (' space '), ('00123'), ('pre-42'), ('missing-left'), (NULL)",
  "CREATE TABLE right_keys (key_value TEXT)",
  "INSERT INTO right_keys VALUES ('same'), ('same'), ('abc'), ('space'), ('123'), ('42'), ('missing-right'), (NULL)",
  "CREATE TABLE codes (value TEXT)",
  "INSERT INTO codes VALUES ('ID-001'), ('ID-002'), ('ID-003'), ('ID-004'), ('bad')",
  ...["source", "lhs", "rhs", "groups", "summary", "samples", "l", "r"].flatMap((name) => [
    `CREATE TABLE "${name}" (id INTEGER)`,
    `INSERT INTO "${name}" VALUES (7), (7), (8)`,
  ]),
]

let fixture: Awaited<ReturnType<typeof tmpdir>>
let sqlitePath: string
let previousTelemetry: string | undefined

beforeAll(async () => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  fixture = await tmpdir()
  sqlitePath = path.join(fixture.path, "checks.sqlite")
  const sqlite = new Database(sqlitePath)
  try {
    for (const sql of statements) sqlite.run(sql)
    sqlite.run("CREATE TABLE numeric_keys (id INTEGER)")
    sqlite.run("INSERT INTO numeric_keys VALUES (1)")
    sqlite.run("CREATE TABLE text_keys (id TEXT)")
    sqlite.run("INSERT INTO text_keys VALUES ('1'), ('01')")
    sqlite.run("CREATE TABLE left_case (id TEXT COLLATE NOCASE)")
    sqlite.run("INSERT INTO left_case VALUES ('a')")
    sqlite.run("CREATE TABLE right_case (id TEXT)")
    sqlite.run("INSERT INTO right_case VALUES ('a'), ('A')")
  } finally {
    sqlite.close()
  }
})

beforeEach(async () => {
  Registry.setConfigs({ sqlite_fixture: { type: "sqlite", path: sqlitePath } })
  await closeScratch()
  for (const sessionID of ["", "test-session"]) {
    const duckdb = await getScratch(sessionID)
    for (const sql of statements) await duckdb.execute(sql, undefined, undefined, { noLimit: true })
  }
})

afterEach(async () => {
  await Registry.closeAll()
})

afterAll(async () => {
  await closeScratch()
  await fixture?.[Symbol.asyncDispose]()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

function compact(result: Awaited<ReturnType<typeof checkSql>>) {
  expect(result.output.split("\n").length).toBeLessThanOrEqual(25)
  expect(result.output.toLowerCase()).toMatch(/fan-out:|keys:|grain:|nulls:|coverage:/)
}

const leftSql = "SELECT * FROM orders"
const rightSql = "SELECT * FROM customers"
const sevenKeys = Array.from({ length: 7 }, (_, i) => `SELECT ${i + 1} AS id`).join(" UNION ALL ")

test("publishes an object schema while requiring a coverage pattern at validation", async () => {
  const tool = await initTool(SqlCheckTool)
  expect(tool.jsonSchema).toMatchObject({ type: "object", properties: { pattern: { type: "string" } } })
  expect(tool.jsonSchema).not.toHaveProperty("anyOf")
  const decode = Schema.decodeUnknownSync(tool.parameters)
  expect(() => decode({ warehouse: "sqlite_fixture", check: "coverage", sql: "SELECT '' AS note", column: "note" })).toThrow()
  expect(decode({ warehouse: "sqlite_fixture", check: "grain" })).toEqual({ warehouse: "sqlite_fixture", check: "grain" })
})

testEffect(Agent.defaultLayer).instance(
  "analyst and data-explorer can invoke sql_check while SQL writes remain denied",
  () =>
    Effect.gen(function* () {
      for (const name of ["analyst", "data-explorer"]) {
        const agent = (yield* Agent.use.get(name))!
        expect(Permission.evaluate("sql_check", "*", agent.permission).action).toBe("allow")
        expect(Permission.evaluate("sql_execute_write", "*", agent.permission).action).toBe("deny")
      }
    }),
)

for (const warehouse of ["sqlite_fixture", "scratch"] as const) {
  describe(`sql_check with ${warehouse === "scratch" ? "DuckDB" : "SQLite"}`, () => {
    test("fanout counts complete left joins and distinct multiplying keys", async () => {
      const result = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: leftSql,
        right_sql: rightSql,
        on: [["customer_id", "customer_id"]],
        join: "left",
      })
      expect(result.metadata).toMatchObject({
        check: "fanout",
        left_rows: 5,
        right_rows: 5,
        joined_rows: 7,
        fanout_ratio: 1.4,
        left_keys: 4,
        multiplying_keys: 1,
        samples: [{ key: [10], matches: 2 }],
      })
      expect(result.output).toContain("1.40")
      expect(result.output).toMatch(/multipli|multiple/)
      compact(result)
    })

    test("inner join detects multiplication even when missing matches keep the ratio at one", async () => {
      const result = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: leftSql,
        right_sql: rightSql,
        on: [["customer_id", "customer_id"]],
        join: "inner",
      })
      expect(result.metadata).toMatchObject({
        left_rows: 5,
        right_rows: 5,
        joined_rows: 5,
        fanout_ratio: 1,
        multiplying_keys: 1,
      })
      expect(result.output).not.toContain("no multiplication")
      compact(result)
    })

    test("fanout reports no multiplication for a unique right key and handles composite keys", async () => {
      const result = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: leftSql,
        right_sql: "SELECT DISTINCT customer_id, kind FROM customers",
        on: [
          ["customer_id", "customer_id"],
          ["kind", "kind"],
        ],
        join: "left",
      })
      expect(result.metadata).toMatchObject({
        left_rows: 5,
        right_rows: 4,
        joined_rows: 5,
        fanout_ratio: 1,
        multiplying_keys: 0,
        samples: [],
      })
      expect(result.output).toContain("no multiplication")
      compact(result)
    })

    test("keys identifies exact, case, whitespace, and leading-zero matches without fixing values", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT * FROM left_keys",
        left_col: "key_value",
        right_sql: "SELECT * FROM right_keys",
        right_col: "key_value",
      })
      expect(result.metadata).toMatchObject({
        check: "keys",
        distinct_left: 6,
        distinct_right: 6,
        matched_exact: 1,
        matched_trim_lower: 3,
        matched_normalized: warehouse === "scratch" ? 3 : "n/a",
        matched_without_leading_zeros: 4,
      })
      expect(result.metadata.format_differences).toEqual(
        expect.arrayContaining(["case-only", "whitespace", "leading zeros", "prefix/suffix"]),
      )
      expect(result.metadata.unmatched_left).toEqual(
        expect.arrayContaining(["ABC", " space ", "00123", "pre-42", "missing-left"]),
      )
      expect(result.metadata.unmatched_right).toEqual(
        expect.arrayContaining(["abc", "space", "123", "42", "missing-right"]),
      )
      expect(result.output).toContain("leading zeros")
      compact(result)
    })

    test("keys handles punctuation normalization or explicitly reports it unavailable", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 'AB-12' AS k",
        left_col: "k",
        right_sql: "SELECT 'ab12' AS k",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({
        matched_exact: 0,
        matched_trim_lower: 0,
        matched_normalized: warehouse === "scratch" ? 1 : "n/a",
      })
      if (warehouse === "sqlite_fixture") expect(result.output).toContain("n/a")
      compact(result)
    })

    test("keys reports a type difference even when textual values match", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 123 AS k",
        left_col: "k",
        right_sql: "SELECT '123' AS k",
        right_col: "k",
      })
      expect(result.metadata.format_differences).toContain("type")
      compact(result)
    })

    test("keys reports complete left coverage for a proper subset", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 'item-a' AS k UNION ALL SELECT 'item-a' UNION ALL SELECT NULL",
        left_col: "k",
        right_sql: "SELECT 'item-a' AS k UNION ALL SELECT 'item-ab'",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({
        distinct_left: 1,
        distinct_right: 2,
        matched_exact: 1,
        left_coverage: 1,
        right_coverage: 0.5,
        unmatched_left: [],
        unmatched_right: ["item-ab"],
      })
      expect(result.output).toContain("left coverage complete")
      expect(result.output).toContain("left 1/1; right 1/2")
      expect(result.output).not.toContain("unmatched keys found")
      expect(result.metadata.format_differences).not.toContain("prefix/suffix")
    })

    test("integer keys skip text format probes even when values share prefixes", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 12 AS k UNION ALL SELECT -12 UNION ALL SELECT NULL",
        left_col: "k",
        right_sql: "SELECT 12 AS k UNION ALL SELECT 123",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({
        matched_exact: 1,
        left_coverage: 0.5,
        right_coverage: 0.5,
        matched_trim_lower: "n/a",
        matched_normalized: "n/a",
        matched_without_leading_zeros: "n/a",
        format_differences: [],
      })
      expect(result.output).toContain("skipped (integer keys)")
      expect(result.output).toContain("unmatched left keys found")
    })

    test("normalization counts distinct left values despite colliding right forms", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 'ABC' AS k UNION ALL SELECT ' AbC ' UNION ALL SELECT '0012'",
        left_col: "k",
        right_sql:
          "SELECT 'abc' AS k UNION ALL SELECT 'ABC' UNION ALL SELECT ' abc ' UNION ALL SELECT '12' UNION ALL SELECT '012'",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({
        matched_exact: 1,
        matched_trim_lower: 2,
        matched_normalized: warehouse === "scratch" ? 2 : "n/a",
        matched_without_leading_zeros: 3,
      })
      expect(result.metadata.format_differences).toEqual(
        expect.arrayContaining(["case-only", "whitespace", "leading zeros"]),
      )
    })

    test("prefix diagnostics compare unmatched left keys with covered right keys", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT 'item' AS k UNION ALL SELECT 'prefix-item'",
        left_col: "k",
        right_sql: "SELECT 'item' AS k",
        right_col: "k",
      })
      expect(result.metadata.format_differences).toContain("prefix/suffix")
      expect(result.output).toContain("up to 100 unmatched left keys and 100 right keys")
    })

    test("keys reports empty-side coverage as unavailable", async () => {
      for (const empty of ["left", "right", "both"]) {
        const result = await checkSql({
          warehouse,
          check: "keys",
          left_sql: `SELECT 'item' AS k${empty !== "right" ? " WHERE 1 = 0" : ""}`,
          left_col: "k",
          right_sql: `SELECT 'item' AS k${empty !== "left" ? " WHERE 1 = 0" : ""}`,
          right_col: "k",
        })
        expect(result.metadata).toMatchObject({
          matched_exact: 0,
          left_coverage: empty !== "right" ? null : 0,
          right_coverage: empty !== "left" ? null : 0,
        })
        expect(result.output).toContain("n/a (empty input)")
      }
    })

    test("keys detects whitespace combined with a case difference", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT ' AbC ' AS k",
        left_col: "k",
        right_sql: "SELECT 'abc' AS k",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({ matched_exact: 0, matched_trim_lower: 1 })
      expect(result.metadata.format_differences).toContain("whitespace")
    })

    test("leading-zero normalization does not turn an empty key into zero", async () => {
      const result = await checkSql({
        warehouse,
        check: "keys",
        left_sql: "SELECT '' AS k",
        left_col: "k",
        right_sql: "SELECT '0' AS k",
        right_col: "k",
      })
      expect(result.metadata).toMatchObject({
        matched_exact: 0,
        matched_trim_lower: 0,
        matched_without_leading_zeros: 0,
      })
      expect(result.metadata.format_differences).not.toContain("leading zeros")
    })

    test("internal CTEs do not shadow source tables with common names", async () => {
      for (const name of ["source", "lhs", "rhs", "groups", "summary", "samples", "l", "r"]) {
        const result = await checkSql({ warehouse, check: "grain", sql: `SELECT * FROM "${name}"`, columns: ["id"] })
        expect(result.metadata).toMatchObject({ total_rows: 3, distinct_combinations: 2, duplicate_count: 1 })
      }
      const keys = await checkSql({
        warehouse,
        check: "keys",
        left_sql: 'SELECT * FROM "l"',
        left_col: "id",
        right_sql: 'SELECT * FROM "r"',
        right_col: "id",
      })
      expect(keys.metadata).toMatchObject({ distinct_left: 2, distinct_right: 2, matched_exact: 2 })
      const fanout = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: 'SELECT * FROM "lhs"',
        right_sql: 'SELECT * FROM "rhs"',
        on: [["id", "id"]],
      })
      expect(fanout.metadata).toMatchObject({
        left_rows: 3,
        right_rows: 3,
        joined_rows: 5,
        left_keys: 2,
        multiplying_keys: 1,
      })
      const nulls = await checkSql({ warehouse, check: "nulls", sql: 'SELECT * FROM "summary"', columns: ["id"] })
      expect(nulls.metadata).toMatchObject({ total_rows: 3, columns: [{ column: "id", null_count: 0 }] })
      const coverage = await checkSql({
        warehouse,
        check: "coverage",
        sql: 'SELECT * FROM "samples"',
        column: "id",
        pattern: "7",
      })
      expect(coverage.metadata).toMatchObject({ rows: 3, matching_rows: 2 })
    })

    test("grain counts duplicate rows and includes NULL in distinct combinations", async () => {
      const result = await checkSql({ warehouse, check: "grain", sql: leftSql, columns: ["customer_id", "kind"] })
      expect(result.metadata).toMatchObject({
        check: "grain",
        total_rows: 5,
        distinct_combinations: 4,
        duplicate_count: 1,
        samples: [{ key: [10, "a"], count: 2 }],
      })
      expect(result.output).toMatch(/duplicat/)
      compact(result)
    })

    test("grain recognizes a unique row key", async () => {
      const result = await checkSql({ warehouse, check: "grain", sql: leftSql, columns: ["id"] })
      expect(result.metadata).toMatchObject({
        total_rows: 5,
        distinct_combinations: 5,
        duplicate_count: 0,
        samples: [],
      })
      compact(result)
    })

    // Strict-schema callers (OpenAI Responses API) send every property and fill unused ones
    // with "" or []; the call must run as if those were omitted.
    test("accepts empty strings and arrays for unused fields", async () => {
      const result = await checkSql({
        warehouse,
        check: "grain",
        sql: leftSql,
        columns: ["id"],
        column: "",
        pattern: "",
        left_sql: "",
        right_sql: "",
        on: [],
        join: "",
        left_col: "",
        right_col: "",
        left_warehouse: "",
        right_warehouse: "",
        query_timeout_ms: 10_000,
      })
      expect(result.metadata).toMatchObject({ check: "grain", total_rows: 5, duplicate_count: 0 })
    })

    test("an empty coverage pattern is a value, not an omission", async () => {
      const result = await checkSql({
        warehouse,
        check: "coverage",
        sql: "SELECT '' AS note",
        column: "note",
        pattern: "",
      })
      expect(result.metadata).toMatchObject({ check: "coverage" })
      expect(result.title).not.toContain("ERROR")
    })

    test("registered coverage checks preserve empty patterns and default filler deadlines", async () => {
      const source = warehouse === "scratch" ? await getScratch("test-session") : await Registry.get(warehouse)
      const execute = spyOn(source, "execute")
      const tool = await initTool(SqlCheckTool)
      try {
        for (const query_timeout_ms of [undefined, [], "", 0, null, 4321]) {
          const result = await tool.execute(
            { warehouse, check: "coverage", sql: "SELECT '' AS note", column: "note", pattern: "", query_timeout_ms },
            {
              sessionID: "test-session",
              messageID: "test-message",
              agent: "test",
              abort: new AbortController().signal,
              messages: [],
            },
          )
          expect(result.title).not.toContain("ERROR")
          expect(result.metadata).toMatchObject({ check: "coverage", matching_rows: 1 })
          expect(execute.mock.calls.at(-1)?.[3]?.queryTimeoutMs).toBe(query_timeout_ms === 4321 ? 4321 : 120_000)
        }
        expect(execute).toHaveBeenCalledTimes(6)
      } finally {
        execute.mockRestore()
      }
    })

    test("still reports missing required fields after empty values are dropped", async () => {
      await expect(checkSql({ warehouse, check: "grain", sql: leftSql, columns: [], column: "" })).rejects.toThrow(
        /columns/,
      )
    })

    test("the registered tool accepts the strict-schema shape instead of rejecting the arguments", async () => {
      const tool = await initTool(SqlCheckTool)
      const result = await tool.execute(
        {
          warehouse,
          check: "coverage",
          sql: leftSql,
          columns: [],
          column: "note",
          pattern: "^f",
          left_sql: "",
          right_sql: "",
          on: [],
          join: "",
          left_col: "",
          right_col: "",
          left_warehouse: "",
          right_warehouse: "",
          query_timeout_ms: 0,
        },
        {
          sessionID: "test-session",
          messageID: "test-message",
          callID: "test-call",
          agent: "test",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
        },
      )
      expect(result.title).not.toContain("ERROR")
      expect(result.metadata).toMatchObject({ check: "coverage" })
    })

    test("nulls reports per-column NULL counts, shares, and non-NULL distinct values", async () => {
      const result = await checkSql({ warehouse, check: "nulls", sql: leftSql, columns: ["customer_id", "note"] })
      expect(result.metadata).toMatchObject({
        check: "nulls",
        total_rows: 5,
        columns: [
          { column: "customer_id", null_count: 1, null_share: 0.2, distinct_count: 3 },
          { column: "note", null_count: 3, null_share: 0.6, distinct_count: 2 },
        ],
      })
      compact(result)
    })

    test("coverage detects the missing fifth of values using regex or the SQLite LIKE fallback", async () => {
      const result = await checkSql({
        warehouse,
        check: "coverage",
        sql: "SELECT * FROM codes",
        column: "value",
        pattern: warehouse === "scratch" ? "^ID-[0-9]{3}$" : "ID-%",
      })
      expect(result.metadata).toMatchObject({
        check: "coverage",
        rows: 5,
        matching_rows: 4,
        share: 0.8,
        pattern_mode: warehouse === "scratch" ? "regex" : "like",
        samples: ["bad"],
      })
      if (warehouse === "sqlite_fixture") expect(result.output).toMatch(/LIKE/)
      compact(result)
    })

    test("coverage includes NULL among uncovered rows", async () => {
      const result = await checkSql({
        warehouse,
        check: "coverage",
        sql: "SELECT 'ok' AS value UNION ALL SELECT NULL",
        column: "value",
        pattern: "ok",
      })
      expect(result.metadata).toMatchObject({ rows: 2, matching_rows: 1, share: 0.5, samples: [null] })
      compact(result)
    })

    test("handles empty inputs without inventing a perfect ratio or coverage share", async () => {
      const sql = "SELECT * FROM orders WHERE 1 = 0"
      const grain = await checkSql({ warehouse, check: "grain", sql, columns: ["id"] })
      expect(grain.metadata).toMatchObject({ total_rows: 0, distinct_combinations: 0, duplicate_count: 0, samples: [] })
      const fanout = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: sql,
        right_sql: rightSql,
        on: [["customer_id", "customer_id"]],
      })
      expect(fanout.metadata).toMatchObject({ left_rows: 0, joined_rows: 0, fanout_ratio: null, multiplying_keys: 0 })
      const coverage = await checkSql({ warehouse, check: "coverage", sql, column: "kind", pattern: "a" })
      expect(coverage.metadata).toMatchObject({ rows: 0, matching_rows: 0, share: null, samples: [] })
      const nulls = await checkSql({ warehouse, check: "nulls", sql, columns: ["note"] })
      expect(nulls.metadata).toMatchObject({
        total_rows: 0,
        columns: [{ column: "note", null_count: 0, null_share: null, distinct_count: 0 }],
      })
      for (const result of [grain, fanout, coverage, nulls]) compact(result)
    })

    test("checks every source row beyond 1000 while preserving an explicit source LIMIT", async () => {
      const sql =
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1205) SELECT n % 3 AS bucket FROM seq"
      const all = await checkSql({ warehouse, check: "grain", sql, columns: ["bucket"] })
      expect(all.metadata).toMatchObject({ total_rows: 1205, distinct_combinations: 3, duplicate_count: 1202 })
      const limited = await checkSql({ warehouse, check: "grain", sql: `${sql} LIMIT 7`, columns: ["bucket"] })
      expect(limited.metadata).toMatchObject({ total_rows: 7, distinct_combinations: 3, duplicate_count: 4 })
    })

    test("caps all diagnostic sample lists at five while retaining complete counts", async () => {
      const duplicateKeys = `${sevenKeys} UNION ALL ${sevenKeys}`
      const fanout = await checkSql({
        warehouse,
        check: "fanout",
        left_sql: sevenKeys,
        right_sql: duplicateKeys,
        on: [["id", "id"]],
      })
      expect(fanout.metadata).toMatchObject({ left_rows: 7, right_rows: 14, joined_rows: 14, multiplying_keys: 7 })
      expect(fanout.metadata.samples).toHaveLength(5)
      const grain = await checkSql({ warehouse, check: "grain", sql: duplicateKeys, columns: ["id"] })
      expect(grain.metadata).toMatchObject({ total_rows: 14, distinct_combinations: 7, duplicate_count: 7 })
      expect(grain.metadata.samples).toHaveLength(5)
      const keys = await checkSql({
        warehouse,
        check: "keys",
        left_sql: sevenKeys,
        left_col: "id",
        right_sql: `SELECT id + 10 AS id FROM (${sevenKeys}) source_keys`,
        right_col: "id",
      })
      expect(keys.metadata).toMatchObject({ distinct_left: 7, distinct_right: 7, matched_exact: 0 })
      expect(keys.metadata.unmatched_left).toHaveLength(5)
      expect(keys.metadata.unmatched_right).toHaveLength(5)
      const coverage = await checkSql({
        warehouse,
        check: "coverage",
        sql: sevenKeys,
        column: "id",
        pattern: "missing",
      })
      expect(coverage.metadata).toMatchObject({ rows: 7, matching_rows: 0 })
      expect(coverage.metadata.samples).toHaveLength(5)
      for (const result of [fanout, grain, keys, coverage]) compact(result)
    })

    test("escapes column identifiers and pattern literals", async () => {
      const sql = `SELECT 'O''Reilly' AS "key""name" UNION ALL SELECT 'other' AS "key""name"`
      const grain = await checkSql({ warehouse, check: "grain", sql, columns: ['key"name'] })
      expect(grain.metadata).toMatchObject({ total_rows: 2, distinct_combinations: 2 })
      const coverage = await checkSql({ warehouse, check: "coverage", sql, column: 'key"name', pattern: "O'Reilly" })
      expect(coverage.metadata).toMatchObject({ rows: 2, matching_rows: 1, samples: ["other"] })
    })

    test("missing columns fail in every mode instead of becoming SQLite string literals", async () => {
      await expect(checkSql({ warehouse, check: "grain", sql: leftSql, columns: ["missing_column"] })).rejects.toThrow(
        /column/i,
      )
      await expect(checkSql({ warehouse, check: "nulls", sql: leftSql, columns: ["missing_column"] })).rejects.toThrow(
        /column/i,
      )
      await expect(
        checkSql({ warehouse, check: "coverage", sql: leftSql, column: "missing_column", pattern: "anything" }),
      ).rejects.toThrow(/column/i)
      await expect(
        checkSql({
          warehouse,
          check: "fanout",
          left_sql: leftSql,
          right_sql: rightSql,
          on: [["customer_id", "missing_column"]],
        }),
      ).rejects.toThrow(/column/i)
      await expect(
        checkSql({
          warehouse,
          check: "keys",
          left_sql: leftSql,
          left_col: "missing_column",
          right_sql: rightSql,
          right_col: "customer_id",
        }),
      ).rejects.toThrow(/column/i)
    })

    test("accepts a read-only REPLACE function and semicolons inside quoted text", async () => {
      const result = await checkSql({
        warehouse,
        check: "grain",
        sql: "SELECT REPLACE('a;b', ';', '') AS value; -- trailing comment",
        columns: ["value"],
      })
      expect(result.metadata).toMatchObject({ total_rows: 1, distinct_combinations: 1, duplicate_count: 0 })
    })

    test("rejects non-SELECT input before any connector execution", async () => {
      const connector = await Registry.get(warehouse)
      const execute = spyOn(connector, "execute")
      try {
        for (const sql of [
          "DELETE FROM orders",
          "INSERT INTO orders (id) VALUES (100)",
          "DROP TABLE orders",
          "SELECT 1; DELETE FROM orders",
          "WITH removed AS (DELETE FROM orders RETURNING *) SELECT * FROM removed",
          "SELECT * INTO copied_orders FROM orders",
          "SELECT nextval('seq') AS id",
          "SELECT \"nextval\"('seq') AS id",
          "SELECT setval('seq', 4) AS id",
          "SELECT load_extension('file') AS id",
          "SELECT writefile('file', 'contents') AS id",
        ]) {
          await expect(checkSql({ warehouse, check: "grain", sql, columns: ["id"] })).rejects.toThrow(/read|SELECT/i)
          await expect(
            checkSql({
              warehouse,
              check: "fanout",
              left_sql: leftSql,
              right_sql: sql,
              on: [["customer_id", "customer_id"]],
            }),
          ).rejects.toThrow(/read|SELECT/i)
        }
        expect(execute).not.toHaveBeenCalled()
      } finally {
        execute.mockRestore()
      }
      expect((await checkSql({ warehouse, check: "grain", sql: leftSql, columns: ["id"] })).metadata.total_rows).toBe(5)
    })

    test("forwards the query timeout and suppresses connector LIMIT injection", async () => {
      const connector = await Registry.get(warehouse)
      const execute = spyOn(connector, "execute")
      try {
        await checkSql({ warehouse, check: "grain", sql: leftSql, columns: ["id"], query_timeout_ms: 4321 })
        expect(execute.mock.calls.length).toBeGreaterThan(0)
        for (const call of execute.mock.calls)
          expect(call[3]).toMatchObject({ readOnly: true, noLimit: true, queryTimeoutMs: 4321 })
      } finally {
        execute.mockRestore()
      }
    })
  })
}

test("SQLite fanout preserves numeric affinity when a right key has multiple textual forms", async () => {
  const result = await checkSql({
    warehouse: "sqlite_fixture",
    check: "fanout",
    left_sql: "SELECT * FROM numeric_keys",
    right_sql: "SELECT * FROM text_keys",
    on: [["id", "id"]],
  })
  expect(result.metadata).toMatchObject({
    left_rows: 1,
    right_rows: 2,
    joined_rows: 2,
    fanout_ratio: 2,
    left_keys: 1,
    multiplying_keys: 1,
    samples: [{ key: [1], matches: 2 }],
  })
})

test("SQLite fanout respects a NOCASE left key when the right key uses binary collation", async () => {
  const result = await checkSql({
    warehouse: "sqlite_fixture",
    check: "fanout",
    left_sql: "SELECT * FROM left_case",
    right_sql: "SELECT * FROM right_case",
    on: [["id", "id"]],
  })
  expect(result.metadata).toMatchObject({
    left_rows: 1,
    right_rows: 2,
    joined_rows: 2,
    fanout_ratio: 2,
    left_keys: 1,
    multiplying_keys: 1,
    samples: [{ key: ["a"], matches: 2 }],
  })
})

test("SQLite fanout does not merge right keys under a broader collation than the join", async () => {
  const result = await checkSql({
    warehouse: "sqlite_fixture",
    check: "fanout",
    left_sql: "SELECT id FROM right_case",
    right_sql: "SELECT id COLLATE NOCASE AS id FROM right_case",
    on: [["id", "id"]],
  })
  expect(result.metadata).toMatchObject({
    left_rows: 2,
    right_rows: 2,
    joined_rows: 2,
    left_keys: 2,
    multiplying_keys: 0,
  })
})

test("refuses cross-warehouse checks and explains the materialization prerequisite", async () => {
  await expect(
    checkSql({
      warehouse: "sqlite_fixture",
      check: "fanout",
      left_warehouse: "sqlite_fixture",
      right_warehouse: "scratch",
      left_sql: leftSql,
      right_sql: rightSql,
      on: [["customer_id", "customer_id"]],
    }),
  ).rejects.toThrow(/sql_materialize/)
  await expect(
    checkSql({
      warehouse: "sqlite_fixture",
      check: "keys",
      left_warehouse: "scratch",
      left_sql: "SELECT * FROM left_keys",
      left_col: "key_value",
      right_sql: "SELECT * FROM right_keys",
      right_col: "key_value",
    }),
  ).rejects.toThrow(/sql_materialize/)
})

test("PostgreSQL checks execute with readOnly for postgres and postgresql connectors", async () => {
  const connector = await Registry.get("sqlite_fixture")
  const execute = spyOn(connector, "execute").mockResolvedValue({
    columns: ["n", "null_0", "distinct_0"],
    rows: [[1, 0, 1]],
    row_count: 1,
    truncated: false,
  })
  const get = spyOn(Registry, "get").mockResolvedValue(connector)
  try {
    for (const type of ["postgres", "postgresql"]) {
      Registry.setConfigs({ pg_fixture: { type } })
      const result = await checkSql({
        warehouse: "pg_fixture",
        check: "nulls",
        sql: "SELECT 1 AS id",
        columns: ["id"],
        query_timeout_ms: 4321,
      })
      expect(result.metadata.total_rows).toBe(1)
    }
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith("pg_fixture")
    expect(execute).toHaveBeenCalledTimes(2)
    for (const call of execute.mock.calls) {
      expect(call[3]).toMatchObject({ readOnly: true, noLimit: true, queryTimeoutMs: 4321 })
    }
  } finally {
    get.mockRestore()
    execute.mockRestore()
  }
})

test("PostgreSQL checks report a write-performing SELECT as an error under readOnly", async () => {
  const connector = await Registry.get("sqlite_fixture")
  let writes = 0
  const execute = spyOn(connector, "execute").mockImplementation(async (sql, _limit, _binds, options) => {
    expect(sql).toContain("mutate_data()")
    if (options?.readOnly) throw new Error("cannot execute INSERT in a read-only transaction")
    writes++
    return { columns: ["n", "null_0", "distinct_0"], rows: [[1, 0, 1]], row_count: 1, truncated: false }
  })
  const get = spyOn(Registry, "get").mockResolvedValue(connector)
  Registry.setConfigs({ pg_fixture: { type: "postgres" } })
  try {
    const tool = await initTool(SqlCheckTool)
    const result = await tool.execute(
      { warehouse: "pg_fixture", check: "nulls", sql: "SELECT mutate_data() AS id", columns: ["id"] },
      {
        sessionID: "test-session",
        messageID: "test-message",
        callID: "test-call",
        agent: "test",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
      },
    )
    expect(result.title).toContain("ERROR")
    expect(result.metadata.error).toBe("cannot execute INSERT in a read-only transaction")
    expect(result.output).toContain("no verdict")
    expect(writes).toBe(0)
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    get.mockRestore()
    execute.mockRestore()
  }
})

test("the registered tool reports SQL refusal as an error result", async () => {
  const tool = await initTool(SqlCheckTool)
  const result = await tool.execute(
    { warehouse: "sqlite_fixture", check: "grain", sql: "DELETE FROM orders", columns: ["id"] },
    {
      sessionID: "test-session",
      messageID: "test-message",
      callID: "test-call",
      agent: "test",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
    },
  )
  expect(result.title).toContain("ERROR")
  expect(result.metadata.error).toBeDefined()
  expect(result.output).toMatch(/read|SELECT/i)
})

for (const warehouse of ["sqlite_fixture", "scratch"] as const) {
  for (const contained of [true, false]) {
    test(
      `keys finishes large ${contained ? "contained" : "disjoint"} text sets within its deadline on ${warehouse === "scratch" ? "DuckDB" : "SQLite"}`,
      async () => {
        const connector = await Registry.get(warehouse)
        const leftTable = contained ? "contained_left_keys" : "disjoint_left_keys"
        const rightTable = contained ? "contained_right_keys" : "disjoint_right_keys"
        const values = (size: number) =>
          warehouse === "scratch"
            ? `SELECT i AS n FROM range(${size}) keys(i)`
            : `WITH RECURSIVE keys(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM keys WHERE n + 1 < ${size}) SELECT n FROM keys`
        await connector.execute(
          `CREATE TABLE ${leftTable} AS SELECT '${contained ? "key-" : "missing-"}' || n AS id FROM (${values(7_000)}) source_keys`,
          undefined,
          undefined,
          { noLimit: true },
        )
        await connector.execute(
          `CREATE TABLE ${rightTable} AS SELECT 'key-' || n AS id FROM (${values(130_000)}) source_keys`,
          undefined,
          undefined,
          { noLimit: true },
        )

        const started = performance.now()
        const result = await checkSql({
          warehouse,
          check: "keys",
          left_sql: `SELECT id FROM ${leftTable}`,
          left_col: "id",
          right_sql: `SELECT id FROM ${rightTable}`,
          right_col: "id",
          query_timeout_ms: 5_000,
        })
        const elapsed = performance.now() - started
        expect(elapsed).toBeLessThan(5_000)
        expect(result.metadata).toMatchObject({
          distinct_left: 7_000,
          distinct_right: 130_000,
          matched_exact: contained ? 7_000 : 0,
          matched_trim_lower: contained ? 7_000 : 0,
          matched_normalized: warehouse === "sqlite_fixture" ? "n/a" : contained ? 7_000 : 0,
          matched_without_leading_zeros: contained ? 7_000 : 0,
        })
        expect(result.metadata.unmatched_left).toHaveLength(contained ? 0 : 5)
        expect(result.metadata.unmatched_right).toHaveLength(5)
        compact(result)
      },
      30_000,
    )
  }
}

test("SQLite keys keeps text probes for mixed integer and text storage", async () => {
  const result = await checkSql({
    warehouse: "sqlite_fixture",
    check: "keys",
    left_sql: "SELECT 12 AS id UNION ALL SELECT ' ABC '",
    left_col: "id",
    right_sql: "SELECT 12 AS id UNION ALL SELECT 'abc'",
    right_col: "id",
  })
  expect(result.metadata).toMatchObject({
    matched_exact: 1,
    matched_trim_lower: 2,
  })
  expect(result.metadata.format_differences).toContain("whitespace")
})

test("DuckDB keys skips text probes for unsigned and huge integer types", async () => {
  for (const type of ["UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "HUGEINT", "UHUGEINT"]) {
    const result = await checkSql({
      warehouse: "scratch",
      check: "keys",
      left_sql: `SELECT CAST(12 AS ${type}) AS id`,
      left_col: "id",
      right_sql: `SELECT CAST(12 AS ${type}) AS id UNION ALL SELECT CAST(123 AS ${type})`,
      right_col: "id",
    })
    expect(result.metadata).toMatchObject({ distinct_left: 1, distinct_right: 2, matched_exact: 1 })
    expect(result.metadata.format_differences).toEqual([])
  }
})

test.each([undefined, "postgres"])("SQL comments ending at CR expose following statements for %s", (dialect) => {
  const sql = "SELECT 1 -- comment\r; DELETE FROM orders"
  expect(statementsOf(sql, dialect)).toEqual(["SELECT 1", "DELETE FROM orders"])
  expect(() => readSql(sql, dialect)).toThrow(/single read-only SELECT/)
})

test.each(["postgres", "duckdb"])("array expressions remain visible to read-only validation for %s", (dialect) => {
  const sql = "SELECT ARRAY[nextval('sequence')] AS values"
  const { tokens, complete } = tokenizeSql(sql, dialect)
  expect(complete).toBe(true)
  expect(tokens.some((token) => token.kind === "identifier")).toBe(false)
  expect(maskSql(tokens)).toContain("ARRAY[nextval(")
  expect(() => readSql(sql, dialect)).toThrow(/single read-only SELECT/)
})

test("PostgreSQL backtick operators do not conceal calls from read-only validation", () => {
  const sql = "SELECT 1 ` pg_cancel_backend(1) ` 2"
  expect(maskSql(tokenizeSql(sql, "postgres").tokens)).toBe(sql)
  expect(() => readSql(sql, "postgres")).toThrow(/single read-only SELECT/)
})

test.each(["[odd;name]", "`odd;name`"])(
  "SQLite retains quoted identifier %s as data rather than executable SQL",
  (identifier) => {
    const sql = `SELECT ${identifier} AS value`
    expect(statementsOf(sql, "sqlite")).toEqual([sql])
    expect(tokenizeSql(sql, "sqlite").tokens).toContainEqual({ kind: "identifier", text: identifier })
    expect(readSql(sql, "sqlite")).toBe(sql)
  },
)

test.each([
  "pg_cancel_backend(1)",
  'pg_catalog."pg_terminate_backend" /* comment */ (1)',
  "pg_logical_emit_message(false, 'topic', 'message')",
  "pg_advisory_unlock_all()",
  "pg_wal_replay_resume()",
  "pg_stat_reset()",
  "pg_some_future_control_function(1)",
  "dblink_send_query('remote', 'DELETE FROM orders')",
  "lo_from_bytea(0, 'value')",
  "lowrite(1, 'value')",
  "force_checkpoint()",
  "query('SELECT 1')",
  "postgres_execute('remote', 'DELETE FROM orders')",
  "mysql_execute('remote', 'DELETE FROM orders')",
  String.raw`U&"pg\005fterminate_backend"(1)`,
  String.raw`pg_catalog.U&"pg_terminate_\+000062ackend"(1)`,
  `U&"pg!005fcancel_backend" UESCAPE '!' (1)`,
])("all SQL checks refuse side-effect call %s", async (call) => {
  Registry.setConfigs({ pg_fixture: { type: "postgres" } })
  const get = spyOn(Registry, "get")
  try {
    await expect(
      checkSql({ warehouse: "pg_fixture", check: "nulls", sql: `SELECT ${call} AS id`, columns: ["id"] }),
    ).rejects.toThrow(/single read-only SELECT/)
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
  }
})

test.each([
  "pg_typeof(1)",
  "pg_column_size(1)",
  "pg_size_pretty(1::bigint)",
  "pg_backend_pid()",
  "pg_stat_get_numscans(1)",
])("read-only validation accepts PostgreSQL inspection call %s", (call) => {
  const sql = `SELECT ${call} AS value`
  expect(readSql(sql, "postgres")).toBe(sql)
})

test("read-only validation ignores side-effect names in literals, comments and column identifiers", () => {
  const sql = `SELECT 'pg_cancel_backend(1)' AS "pg_stat_reset" /* dblink_send_query('remote', 'DELETE') */`
  expect(readSql(sql, "postgres")).toBe(sql)
})

test("invalid check arguments identify the field before connecting", async () => {
  const get = spyOn(Registry, "get")
  try {
    await expect(
      checkSql({ warehouse: "sqlite_fixture", check: "nulls", sql: leftSql, columns: [""] }),
    ).rejects.toThrow(/sql_check invalid input: columns\.0:/)
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
  }
})

test("SQLite read-only checks restore query_only after success and failure", async () => {
  const connector = await Registry.get("sqlite_fixture")
  try {
    const guarded = await connector.execute("SELECT query_only FROM pragma_query_only()", undefined, undefined, {
      readOnly: true,
    })
    expect(guarded.rows).toEqual([[1]])
    expect(
      (await checkSql({ warehouse: "sqlite_fixture", check: "grain", sql: leftSql, columns: ["id"] })).metadata
        .total_rows,
    ).toBe(5)
    expect((await connector.execute("PRAGMA query_only")).rows).toEqual([[0]])
    await expect(
      connector.execute("INSERT INTO orders (id) VALUES (600)", undefined, undefined, { readOnly: true }),
    ).rejects.toThrow(/readonly/i)
    expect((await connector.execute("SELECT COUNT(*) FROM orders")).rows).toEqual([[5]])
    expect((await connector.execute("PRAGMA query_only")).rows).toEqual([[0]])
    await connector.execute("INSERT INTO orders (id) VALUES (600)")
    await connector.execute("DELETE FROM orders WHERE id = 600")
    await connector.execute("PRAGMA query_only = ON")
    await checkSql({ warehouse: "sqlite_fixture", check: "grain", sql: leftSql, columns: ["id"] })
    await expect(
      checkSql({ warehouse: "sqlite_fixture", check: "grain", sql: "SELECT * FROM missing", columns: ["id"] }),
    ).rejects.toThrow(/missing/)
    expect((await connector.execute("PRAGMA query_only")).rows).toEqual([[1]])
  } finally {
    await connector.execute("PRAGMA query_only = OFF")
    await connector.execute("DELETE FROM orders WHERE id = 600")
  }
})

test("DuckDB read-only checks block hidden sequence writes and restore the session", async () => {
  const connector = await Registry.get("scratch")
  await connector.execute("CREATE SEQUENCE check_sequence")
  await connector.execute("CREATE VIEW sequence_writer AS SELECT nextval('check_sequence') AS id")
  await expect(
    checkSql({ warehouse: "scratch", check: "grain", sql: "SELECT * FROM sequence_writer", columns: ["id"] }),
  ).rejects.toThrow(/read.only/i)
  expect(
    (await connector.execute("SELECT last_value FROM duckdb_sequences() WHERE sequence_name = 'check_sequence'")).rows,
  ).toEqual([[null]])
  await connector.execute("INSERT INTO orders (id) VALUES (6)")
  expect(
    (await checkSql({ warehouse: "scratch", check: "grain", sql: leftSql, columns: ["id"] })).metadata.total_rows,
  ).toBe(6)
})

test("DuckDB read-only checks refuse active transactions without aborting caller changes", async () => {
  const connector = await Registry.get("scratch")
  await connector.execute("BEGIN TRANSACTION")
  try {
    await connector.execute("INSERT INTO orders (id) VALUES (6)")
    await expect(checkSql({ warehouse: "scratch", check: "grain", sql: leftSql, columns: ["id"] })).rejects.toThrow(
      /DuckDB.*active transaction/i,
    )
    await connector.execute("COMMIT")
    expect(Number((await connector.execute("SELECT COUNT(*) FROM orders")).rows[0][0])).toBe(6)
  } catch (error) {
    await connector.execute("ROLLBACK").catch(() => {})
    throw error
  }
})

testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer)).instance(
  "multi-pattern SQL permissions reject a later deny before prompting and still prompt once when allowed",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* Effect.promise(() =>
        Instance.provide({
          directory,
          fn: async () => {
            const asked: PermissionNext.Request[] = []
            const publish = spyOn(Bus, "publish").mockImplementation(async (event, properties) => {
              if (event.type !== PermissionNext.Event.Asked.type) return
              const request = properties as PermissionNext.Request
              asked.push(request)
              await PermissionNext.reply({ requestID: request.id, reply: "once" })
            })
            const request = {
              permission: "sql_execute",
              patterns: ["SELECT * FROM orders", "SELECT * FROM sensitive_table"],
              always: [],
              metadata: {},
              sessionID: SessionID.make("session_sql_permissions"),
            }
            try {
              await expect(
                PermissionNext.ask({
                  ...request,
                  ruleset: [
                    { permission: "sql_execute", pattern: "*", action: "ask" },
                    { permission: "sql_execute", pattern: "*sensitive_table*", action: "deny" },
                  ],
                }),
              ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
              expect(asked).toEqual([])
              expect(await PermissionNext.list()).toEqual([])
              await PermissionNext.ask({
                ...request,
                ruleset: [{ permission: "sql_execute", pattern: "*", action: "ask" }],
              })
              expect(asked).toHaveLength(1)
              expect(asked[0].patterns).toEqual(request.patterns)
              expect(await PermissionNext.list()).toEqual([])
            } finally {
              publish.mockRestore()
            }
          },
        }),
      )
    }),
)

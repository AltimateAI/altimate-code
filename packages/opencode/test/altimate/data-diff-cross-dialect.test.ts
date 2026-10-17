/**
 * Tests for cross-dialect partitioned diff and joindiff cross-warehouse guard.
 *
 * These cover the two CRITICAL/MAJOR bugs fixed in the review follow-up:
 *   1. Partitioned WHERE was built with sourceDialect only and applied to both
 *      warehouses; cross-dialect diffs blew up the target with foreign syntax.
 *   2. Explicit `algorithm: "joindiff"` with different warehouses silently
 *      produced SQL referencing an undefined CTE alias.
 *
 * ## Why unit tests, not integration
 *
 * An earlier version of this file integration-tested the fixes by driving
 * `runDataDiff` end-to-end with mocked Registry + mocked `@altimateai/altimate-core`.
 * That approach leaked `mock.module()` state across test files in Bun (bun:test
 * runs the whole suite in one process), breaking `connections.test.ts` and
 * `telemetry-safety.test.ts`. Additionally, when other test files imported the
 * real `@altimateai/altimate-core` first, Bun cached it and our NAPI mock was
 * bypassed — the npm-published `0.2.6` lacks `DataParitySession`, so our
 * integration test would fail with "altimate-core NAPI module unavailable"
 * regardless of our mock.
 *
 * The fix is in pure-function SQL builders (`dateTruncExpr`,
 * `buildPartitionWhereClause`). Testing them directly is both more targeted
 * (zero coupling to NAPI availability / Registry state) and more reliable in a
 * single-process test runner.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test"

import {
  buildPartitionWhereClause,
  dateTruncExpr,
  runDataDiff,
} from "../../src/altimate/native/connections/data-diff"
import * as Registry from "../../src/altimate/native/connections/registry"

describe("dateTruncExpr — dialect-native output", () => {
  test("tsql uses DATETRUNC with unquoted datepart keyword", () => {
    expect(dateTruncExpr("month", "[order_date]", "tsql")).toBe("DATETRUNC(MONTH, [order_date])")
  })

  test("fabric matches tsql", () => {
    expect(dateTruncExpr("day", "[d]", "fabric")).toBe("DATETRUNC(DAY, [d])")
  })

  test("postgres uses DATE_TRUNC with lowercase string literal", () => {
    expect(dateTruncExpr("month", `"order_date"`, "postgres")).toBe(`DATE_TRUNC('month', "order_date")`)
  })

  test("bigquery uses DATE_TRUNC with uppercase unit keyword", () => {
    expect(dateTruncExpr("month", "order_date", "bigquery")).toBe("DATE_TRUNC(order_date, MONTH)")
  })

  test("mysql uses DATE_FORMAT with format strings", () => {
    expect(dateTruncExpr("month", "`d`", "mysql")).toContain("DATE_FORMAT(`d`")
    expect(dateTruncExpr("month", "`d`", "mysql")).toContain("%Y-%m-01")
  })
})

describe("buildPartitionWhereClause — cross-dialect correctness (the CRITICAL fix)", () => {
  const col = "order_date"
  const value = "2026-04-01"

  test("tsql: DATETRUNC + CONVERT(DATE, ..., 23) ISO-8601 style", () => {
    const sql = buildPartitionWhereClause(col, value, "month", undefined, "tsql")
    expect(sql).toContain("DATETRUNC(MONTH, [order_date])")
    expect(sql).toContain("CONVERT(DATE, '2026-04-01', 23)")
    // Must not leak generic single-quoted literal in tsql
    expect(sql).not.toMatch(/=\s*'2026-04-01'\s*$/)
  })

  test("fabric: same as tsql", () => {
    const sql = buildPartitionWhereClause(col, value, "month", undefined, "fabric")
    expect(sql).toContain("DATETRUNC(MONTH, [order_date])")
    expect(sql).toContain("CONVERT(DATE, '2026-04-01', 23)")
  })

  test("postgres: DATE_TRUNC + bare date literal", () => {
    const sql = buildPartitionWhereClause(col, value, "month", undefined, "postgres")
    expect(sql).toContain(`DATE_TRUNC('month', "order_date")`)
    expect(sql).toContain(`'2026-04-01'`)
    // Must not produce T-SQL syntax
    expect(sql).not.toMatch(/DATETRUNC\(/i)
    expect(sql).not.toMatch(/CONVERT\(DATE/i)
  })

  test("clickhouse: toStartOfMonth + toDate() cast", () => {
    const sql = buildPartitionWhereClause(col, value, "month", undefined, "clickhouse")
    expect(sql).toContain("toStartOfMonth(`order_date`)")
    expect(sql).toContain("toDate('2026-04-01')")
  })

  test("bigquery: DATE_TRUNC uppercase + bare literal", () => {
    const sql = buildPartitionWhereClause(col, value, "month", undefined, "bigquery")
    // `quoteIdentForDialect` falls through to ANSI double-quotes for bigquery
    expect(sql).toContain(`DATE_TRUNC("order_date", MONTH)`)
    expect(sql).toContain(`'2026-04-01'`)
  })

  // The regression this guards against: before the fix, the orchestrator built
  // ONE partition WHERE using `sourceDialect` and passed it to both sides.
  // A cross-dialect MSSQL → Postgres diff would send `DATETRUNC`/`CONVERT` to
  // Postgres and blow up. With per-side WHERE generation, the two outputs are
  // independent — asserted directly here.
  test("cross-dialect sanity: MSSQL and Postgres outputs are independent and incompatible", () => {
    const mssqlWhere = buildPartitionWhereClause(col, value, "month", undefined, "tsql")
    const pgWhere = buildPartitionWhereClause(col, value, "month", undefined, "postgres")
    expect(mssqlWhere).not.toEqual(pgWhere)
    // MSSQL WHERE would break when sent to Postgres and vice versa — the test
    // proves each dialect yields only its own syntax.
    expect(mssqlWhere).toMatch(/DATETRUNC/i)
    expect(pgWhere).not.toMatch(/DATETRUNC/i)
    expect(pgWhere).toMatch(/DATE_TRUNC/i)
    expect(mssqlWhere).not.toMatch(/DATE_TRUNC/i)
  })

  test("numeric mode produces bucket range, ignores dialect", () => {
    const sql = buildPartitionWhereClause("amount", "100000", undefined, 1000, "tsql")
    expect(sql).toContain("[amount] >= 100000")
    expect(sql).toContain("[amount] < 101000")
  })

  test("categorical mode quotes the value with single-quote escaping", () => {
    const sql = buildPartitionWhereClause("status", "it's active", undefined, undefined, "postgres")
    expect(sql).toContain(`"status" = 'it''s active'`)
  })

  test("tsql date literal normalizes timestamp inputs to ISO yyyy-mm-dd", () => {
    // Regression: mssql returns Date-like strings (e.g. "Mon Apr 01 2024 …")
    // that must be normalized before CONVERT(DATE, …, 23) can parse them.
    const sql = buildPartitionWhereClause(col, "Mon Apr 01 2024 00:00:00 GMT+0000", "month", undefined, "tsql")
    expect(sql).toContain("CONVERT(DATE, '2024-04-01', 23)")
  })

  test("mysql week-format values pass through unchanged (regression: no ISO rewrite)", () => {
    // Regression guard: MySQL `DATE_FORMAT(%Y-%u)` emits e.g. "2024-42" for
    // week 42 — that's not a parseable JS Date. An earlier revision tried
    // to normalize it to ISO `yyyy-mm-dd`, which either produced NaN or a
    // wildly wrong date (Dec 2024 in 0042 AD). Must be passed through.
    const sql = buildPartitionWhereClause("ts", "2024-42", "week", undefined, "mysql")
    expect(sql).toContain("= '2024-42'")
    expect(sql).not.toContain("0042")
    expect(sql).not.toContain("NaN")
  })

  test("mysql DATE_FORMAT month output flows through verbatim", () => {
    const sql = buildPartitionWhereClause("ts", "2024-04-01", "month", undefined, "mariadb")
    expect(sql).toContain("DATE_FORMAT(`ts`, '%Y-%m-01')")
    expect(sql).toContain("= '2024-04-01'")
  })
})

// The joindiff guard runs BEFORE `runDataDiff`'s NAPI import, so we can drive
// it end-to-end without any mock. This verifies the actual wiring, not just
// the pure-function output — complementary to the unit tests above.
describe("joindiff + cross-warehouse guard", () => {
  beforeAll(() => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  })
  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    Registry.reset()
  })
  beforeEach(() => {
    Registry.reset()
  })

  test("explicit joindiff with different warehouses (mixed dialect) returns early error", async () => {
    Registry.setConfigs({
      msrc: { type: "sqlserver", host: "mssql-host", database: "src" },
      ptgt: { type: "postgres", host: "pg-host", database: "tgt" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "public.orders",
      key_columns: ["id"],
      source_warehouse: "msrc",
      target_warehouse: "ptgt",
      algorithm: "joindiff",
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/joindiff requires both tables in the same warehouse/i)
    // Guard must fire before any NAPI/driver work, so steps stays at 0.
    expect(result.steps).toBe(0)
  })

  test("explicit joindiff with different warehouses (SAME dialect) still errors", async () => {
    // Regression guard: if `crossWarehouse` were computed from dialect
    // equality (as an earlier revision did) instead of resolved warehouse
    // identity, this case would slip through and route a JOIN query to a
    // warehouse that doesn't have the other side's tables. Two MSSQL
    // servers share a dialect but are independent physical databases.
    Registry.setConfigs({
      mssql_a: { type: "sqlserver", host: "server-a", database: "src" },
      mssql_b: { type: "sqlserver", host: "server-b", database: "tgt" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "dbo.orders",
      key_columns: ["id"],
      source_warehouse: "mssql_a",
      target_warehouse: "mssql_b",
      algorithm: "joindiff",
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/joindiff requires both tables in the same warehouse/i)
    expect(result.steps).toBe(0)
  })

  test("same-name warehouse on both sides does NOT trigger the guard", async () => {
    // Guard compares resolved warehouse identity, not dialect — same name →
    // guard stays quiet. We can't drive the whole diff without NAPI, but we
    // can confirm the guard error is NOT the one returned (the call will
    // instead fail with the NAPI-unavailable error in test envs that lack the
    // built binary, which is fine).
    Registry.setConfigs({
      shared: { type: "sqlserver", host: "shared-host", database: "d" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "dbo.orders_v2",
      key_columns: ["id"],
      source_warehouse: "shared",
      target_warehouse: "shared",
      algorithm: "joindiff",
    })
    // May succeed or fail depending on NAPI availability — the assertion here
    // is only that the joindiff guard did not reject this same-warehouse case.
    if (!result.success) {
      expect(result.error).not.toMatch(/joindiff requires both tables in the same warehouse/i)
    }
  })
})

describe("data.diff read-only warehouse probes", () => {
  test.each(["postgres", "postgresql", "sqlite"])(
    "partition discovery protects PostgreSQL reads and preserves other connector options (%s)",
    async (type) => {
      Registry.setConfigs({ probe: { type } })
      const execute = mock(async () => ({ columns: ["partition_value"], rows: [], row_count: 0, truncated: false }))
      const get = spyOn(Registry, "get").mockResolvedValue({ execute } as any)
      try {
        const result = await runDataDiff({
          source: "public.orders",
          target: "public.orders_copy",
          key_columns: ["id"],
          partition_column: "region",
        })
        expect(result.success).toBe(true)
        expect(execute).toHaveBeenCalledTimes(2)
        expect(get).toHaveBeenCalledWith("probe")
        for (const call of execute.mock.calls) {
          const [sql, limit, binds, options] = call as unknown as [string, unknown, unknown, { noLimit: boolean; readOnly?: boolean }]
          expect(sql).toContain("SELECT DISTINCT")
          expect(limit).toBeUndefined()
          expect(binds).toBeUndefined()
          expect(options.noLimit).toBe(true)
          if (type === "sqlite") expect(options).not.toHaveProperty("readOnly")
          else expect(options.readOnly).toBe(true)
        }
      } finally {
        get.mockRestore()
        Registry.reset()
      }
    },
  )
})

// altimate_change start — Trino partition literals (dbt-parity runs over Trino)
import { trinoTimestampLiteral } from "../../src/altimate/native/connections/data-diff"

describe("Trino partition WHERE", () => {
  test("date partitions cast the literal — Trino never coerces varchar to a timestamp", () => {
    expect(buildPartitionWhereClause("end_time", "2024-01-01", "day", undefined, "trino")).toBe(
      `DATE_TRUNC('day', "end_time") = CAST('2024-01-01' AS TIMESTAMP)`,
    )
  })
  test("zone-suffixed and JS Date values reduce to a zone-less ISO literal", () => {
    expect(trinoTimestampLiteral("2024-01-01 00:00:00.000 UTC")).toBe("2024-01-01 00:00:00.000")
    expect(trinoTimestampLiteral("2024-03-05T10:20:30Z")).toBe("2024-03-05 10:20:30")
    expect(trinoTimestampLiteral(new Date(Date.UTC(2024, 0, 2)).toString())).toMatch(/^2024-01-0[12] /)
  })
  test("categorical partitions are unchanged", () => {
    expect(buildPartitionWhereClause("region", "eu", undefined, undefined, "trino")).toBe(`"region" = 'eu'`)
  })
})
// altimate_change end

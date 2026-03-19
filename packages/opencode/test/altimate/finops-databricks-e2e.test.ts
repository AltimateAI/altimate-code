/**
 * FinOps Integration Tests — Databricks
 *
 * Tests query execution and response shape for all finops functions against
 * real Databricks system tables. Skips if ALTIMATE_CODE_CONN_DATABRICKS_TEST
 * is not set.
 *
 * Tests accept success OR a graceful permission error — the goal is to verify
 * the SQL is valid, binds are correct, and the response has the right shape.
 *
 * Run:
 *   export ALTIMATE_CODE_CONN_DATABRICKS_TEST='{"type":"databricks","server_hostname":"...","http_path":"/sql/1.0/warehouses/...","access_token":"...","catalog":"dbt","schema":"default"}'
 *   bun test test/altimate/finops-databricks-e2e.test.ts --timeout 60000
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

process.env.ALTIMATE_TELEMETRY_DISABLED = "true"

import * as Registry from "../../src/altimate/native/connections/registry"
import { getQueryHistory } from "../../src/altimate/native/finops/query-history"
import { analyzeCredits, getExpensiveQueries } from "../../src/altimate/native/finops/credit-analyzer"
import { adviseWarehouse } from "../../src/altimate/native/finops/warehouse-advisor"
import { findUnusedResources } from "../../src/altimate/native/finops/unused-resources"
import { queryGrants } from "../../src/altimate/native/finops/role-access"

const DB_CONFIG = process.env.ALTIMATE_CODE_CONN_DATABRICKS_TEST
const HAS_DATABRICKS = !!DB_CONFIG
const WH = "databricks_finops_e2e"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept success OR graceful error — the key check is no thrown exception and correct shape. */
function expectValidResult(result: { success: boolean; error?: string }) {
  if (!result.success) {
    expect(result.error).toBeDefined()
    expect(typeof result.error).toBe("string")
    // Should not be an unbound-parameter or syntax error
    expect(result.error).not.toMatch(/UNBOUND_SQL_PARAMETER|ParseException|syntax error/i)
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DATABRICKS)("Databricks FinOps Integration", () => {
  beforeAll(async () => {
    Registry.reset()
    Registry.setConfigs({ [WH]: JSON.parse(DB_CONFIG!) })
  }, 30000)

  afterAll(() => {
    Registry.reset()
  })

  // -------------------------------------------------------------------------
  // Query History
  // -------------------------------------------------------------------------
  describe("query_history", () => {
    test("returns valid shape for 7-day history", async () => {
      const result = await getQueryHistory({ warehouse: WH, days: 7, limit: 10 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.queries)).toBe(true)
        expect(typeof result.summary).toBe("object")
        expect(typeof result.summary.query_count).toBe("number")
        expect(result.warehouse_type).toBe("databricks")
      }
    })

    test("respects limit parameter", async () => {
      const result = await getQueryHistory({ warehouse: WH, days: 30, limit: 5 })
      expectValidResult(result)
      if (result.success) {
        expect(result.queries.length).toBeLessThanOrEqual(5)
      }
    })

    test("query rows have expected columns when data exists", async () => {
      const result = await getQueryHistory({ warehouse: WH, days: 7, limit: 1 })
      expectValidResult(result)
      if (result.success && result.queries.length > 0) {
        const row = result.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("query_text")
        expect(row).toHaveProperty("execution_time_sec")
        expect(row).toHaveProperty("start_time")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Credit Analysis
  // -------------------------------------------------------------------------
  describe("credit_analyzer", () => {
    test("analyzeCredits returns valid shape", async () => {
      const result = await analyzeCredits({ warehouse: WH, days: 30, limit: 10 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.daily_usage)).toBe(true)
        expect(Array.isArray(result.warehouse_summary)).toBe(true)
        expect(typeof result.total_credits).toBe("number")
        expect(result.days_analyzed).toBe(30)
        expect(Array.isArray(result.recommendations)).toBe(true)
        expect(result.recommendations.length).toBeGreaterThan(0)
      }
    })

    test("daily usage rows have expected columns when data exists", async () => {
      const result = await analyzeCredits({ warehouse: WH, days: 7, limit: 5 })
      expectValidResult(result)
      if (result.success && result.daily_usage.length > 0) {
        const row = result.daily_usage[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("usage_date")
        expect(row).toHaveProperty("credits_used")
      }
    })

    test("getExpensiveQueries returns valid shape", async () => {
      const result = await getExpensiveQueries({ warehouse: WH, days: 7, limit: 10 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.queries)).toBe(true)
        expect(typeof result.query_count).toBe("number")
        expect(result.days_analyzed).toBe(7)
      }
    })

    test("expensive query rows have expected columns when data exists", async () => {
      const result = await getExpensiveQueries({ warehouse: WH, days: 30, limit: 5 })
      expectValidResult(result)
      if (result.success && result.queries.length > 0) {
        const row = result.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("execution_time_sec")
        expect(row).toHaveProperty("bytes_scanned")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Warehouse Advisor
  // -------------------------------------------------------------------------
  describe("warehouse_advisor", () => {
    test("adviseWarehouse returns valid shape", async () => {
      const result = await adviseWarehouse({ warehouse: WH, days: 14 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.recommendations)).toBe(true)
        expect(result.days_analyzed).toBe(14)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Unused Resources
  // -------------------------------------------------------------------------
  describe("unused_resources", () => {
    test("findUnusedResources returns valid shape", async () => {
      const result = await findUnusedResources({ warehouse: WH, days: 90 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.unused_tables)).toBe(true)
        expect(Array.isArray(result.idle_warehouses)).toBe(true)
        expect(typeof result.summary).toBe("object")
        expect(result.days_analyzed).toBe(90)
      }
    })

    test("unused_tables rows have expected columns when data exists", async () => {
      const result = await findUnusedResources({ warehouse: WH, days: 30 })
      expectValidResult(result)
      if (result.success && result.unused_tables.length > 0) {
        const row = result.unused_tables[0]
        expect(row).toHaveProperty("table_name")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Role / Grants Access
  // -------------------------------------------------------------------------
  describe("role_access", () => {
    test("queryGrants returns valid shape", async () => {
      const result = await queryGrants({ warehouse: WH, limit: 10 })
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.grants)).toBe(true)
        expect(typeof result.grant_count).toBe("number")
        expect(typeof result.privilege_summary).toBe("object")
      }
    })

    test("queryGrants with grantee filter returns valid shape", async () => {
      const result = await queryGrants({ warehouse: WH, role: "nonexistent_grantee_xyz", limit: 10 })
      expectValidResult(result)
      if (result.success) {
        expect(result.grants).toHaveLength(0)
        expect(result.grant_count).toBe(0)
      }
    })
  })
})

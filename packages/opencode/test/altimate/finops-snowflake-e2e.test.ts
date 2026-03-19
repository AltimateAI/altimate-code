/**
 * FinOps Integration Tests — Snowflake
 *
 * Tests query execution and response shape for all finops functions against
 * real Snowflake ACCOUNT_USAGE views. Skips if ALTIMATE_CODE_CONN_SNOWFLAKE_TEST
 * is not set. Requires ACCOUNTADMIN or MONITOR USAGE privilege for
 * ACCOUNT_USAGE views.
 *
 * Tests accept success OR a graceful permission error — the goal is to verify
 * the SQL is valid, binds are correct, and the response has the right shape.
 *
 * Run:
 *   export ALTIMATE_CODE_CONN_SNOWFLAKE_TEST='{"type":"snowflake","account":"...","user":"...","password":"...","warehouse":"...","database":"...","schema":"public","role":"ACCOUNTADMIN"}'
 *   bun test test/altimate/finops-snowflake-e2e.test.ts --timeout 120000
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

process.env.ALTIMATE_TELEMETRY_DISABLED = "true"

import * as Registry from "../../src/altimate/native/connections/registry"
import { getQueryHistory } from "../../src/altimate/native/finops/query-history"
import { analyzeCredits, getExpensiveQueries } from "../../src/altimate/native/finops/credit-analyzer"
import { adviseWarehouse } from "../../src/altimate/native/finops/warehouse-advisor"
import { findUnusedResources } from "../../src/altimate/native/finops/unused-resources"
import { queryGrants, queryRoleHierarchy, queryUserRoles } from "../../src/altimate/native/finops/role-access"
import { getTags, listTags } from "../../src/altimate/native/schema/tags"

const SF_CONFIG = process.env.ALTIMATE_CODE_CONN_SNOWFLAKE_TEST
const HAS_SNOWFLAKE = !!SF_CONFIG
const WH = "snowflake_finops_e2e"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept success OR graceful error — the key check is no thrown exception and correct shape. */
function expectValidResult(result: { success: boolean; error?: string }) {
  if (!result.success) {
    expect(result.error).toBeDefined()
    expect(typeof result.error).toBe("string")
    // Should not be a bind/syntax error
    expect(result.error).not.toMatch(/syntax error|unbound|invalid identifier/i)
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_SNOWFLAKE)("Snowflake FinOps Integration", () => {
  beforeAll(async () => {
    Registry.reset()
    Registry.setConfigs({ [WH]: JSON.parse(SF_CONFIG!) })
  }, 30000)

  afterAll(() => {
    Registry.reset()
  })

  // -------------------------------------------------------------------------
  // Query History
  // -------------------------------------------------------------------------
  describe("query_history", () => {
    let result: Awaited<ReturnType<typeof getQueryHistory>>

    beforeAll(async () => {
      result = await getQueryHistory({ warehouse: WH, days: 7, limit: 10 })
    }, 60000)

    test("returns valid shape", () => {
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.queries)).toBe(true)
        expect(typeof result.summary).toBe("object")
        expect(typeof result.summary.query_count).toBe("number")
        expect(result.warehouse_type).toBe("snowflake")
      }
    })

    test("respects limit parameter", () => {
      if (result.success) {
        expect(result.queries.length).toBeLessThanOrEqual(10)
      }
    })

    test("query rows have expected columns when data exists", () => {
      if (result.success && result.queries.length > 0) {
        const row = result.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("query_text")
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("execution_time_sec")
      }
    })

    test("user filter produces valid SQL", async () => {
      const r = await getQueryHistory({ warehouse: WH, days: 7, limit: 5, user: "NONEXISTENT_USER_XYZ" })
      expectValidResult(r)
      if (r.success) expect(r.queries).toHaveLength(0)
    }, 60000)

    test("warehouse_filter produces valid SQL", async () => {
      const r = await getQueryHistory({ warehouse: WH, days: 7, limit: 5, warehouse_filter: "NONEXISTENT_WH_XYZ" })
      expectValidResult(r)
      if (r.success) expect(r.queries).toHaveLength(0)
    }, 60000)
  })

  // -------------------------------------------------------------------------
  // Credit Analysis
  // -------------------------------------------------------------------------
  describe("credit_analyzer", () => {
    let creditsResult: Awaited<ReturnType<typeof analyzeCredits>>
    let expensiveResult: Awaited<ReturnType<typeof getExpensiveQueries>>

    beforeAll(async () => {
      ;[creditsResult, expensiveResult] = await Promise.all([
        analyzeCredits({ warehouse: WH, days: 30, limit: 10 }),
        getExpensiveQueries({ warehouse: WH, days: 30, limit: 10 }),
      ])
    }, 60000)

    test("analyzeCredits returns valid shape", () => {
      expectValidResult(creditsResult)
      if (creditsResult.success) {
        expect(Array.isArray(creditsResult.daily_usage)).toBe(true)
        expect(Array.isArray(creditsResult.warehouse_summary)).toBe(true)
        expect(typeof creditsResult.total_credits).toBe("number")
        expect(creditsResult.days_analyzed).toBe(30)
        expect(Array.isArray(creditsResult.recommendations)).toBe(true)
        expect(creditsResult.recommendations.length).toBeGreaterThan(0)
      }
    })

    test("daily usage rows have expected columns when data exists", () => {
      if (creditsResult.success && creditsResult.daily_usage.length > 0) {
        const row = creditsResult.daily_usage[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("usage_date")
        expect(row).toHaveProperty("credits_used")
        expect(row).toHaveProperty("query_count")
      }
    })

    test("warehouse summary rows have expected columns when data exists", () => {
      if (creditsResult.success && creditsResult.warehouse_summary.length > 0) {
        const row = creditsResult.warehouse_summary[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("total_credits")
        expect(row).toHaveProperty("active_days")
      }
    })

    test("warehouse filter produces valid SQL", async () => {
      const r = await analyzeCredits({ warehouse: WH, days: 7, limit: 5, warehouse_filter: "NONEXISTENT_WH" })
      expectValidResult(r)
      if (r.success) expect(r.daily_usage).toHaveLength(0)
    }, 60000)

    test("getExpensiveQueries returns valid shape", () => {
      expectValidResult(expensiveResult)
      if (expensiveResult.success) {
        expect(Array.isArray(expensiveResult.queries)).toBe(true)
        expect(typeof expensiveResult.query_count).toBe("number")
        expect(expensiveResult.days_analyzed).toBe(30)
      }
    })

    test("expensive query rows have expected columns when data exists", () => {
      if (expensiveResult.success && expensiveResult.queries.length > 0) {
        const row = expensiveResult.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("query_preview")
        expect(row).toHaveProperty("execution_time_sec")
        expect(row).toHaveProperty("bytes_scanned")
        expect(row).toHaveProperty("warehouse_name")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Warehouse Advisor
  // -------------------------------------------------------------------------
  describe("warehouse_advisor", () => {
    let result: Awaited<ReturnType<typeof adviseWarehouse>>

    beforeAll(async () => {
      result = await adviseWarehouse({ warehouse: WH, days: 14 })
    }, 60000)

    test("returns valid shape", () => {
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.warehouse_load)).toBe(true)
        expect(Array.isArray(result.warehouse_performance)).toBe(true)
        expect(Array.isArray(result.recommendations)).toBe(true)
        expect(result.recommendations.length).toBeGreaterThan(0)
        expect(result.days_analyzed).toBe(14)
      }
    })

    test("warehouse_load rows have expected columns when data exists", () => {
      if (result.success && result.warehouse_load.length > 0) {
        const row = result.warehouse_load[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("avg_concurrency")
        expect(row).toHaveProperty("avg_queue_load")
      }
    })

    test("warehouse_performance rows have expected columns when data exists", () => {
      if (result.success && result.warehouse_performance.length > 0) {
        const row = result.warehouse_performance[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("query_count")
        expect(row).toHaveProperty("avg_time_sec")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Unused Resources
  // -------------------------------------------------------------------------
  describe("unused_resources", () => {
    let result: Awaited<ReturnType<typeof findUnusedResources>>

    beforeAll(async () => {
      result = await findUnusedResources({ warehouse: WH, days: 30 })
    }, 60000)

    test("returns valid shape", () => {
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.unused_tables)).toBe(true)
        expect(Array.isArray(result.idle_warehouses)).toBe(true)
        expect(typeof result.summary).toBe("object")
        expect(result.days_analyzed).toBe(30)
      }
    })

    test("summary has expected keys", () => {
      if (result.success) {
        expect(result.summary).toHaveProperty("unused_table_count")
        expect(result.summary).toHaveProperty("idle_warehouse_count")
        expect(result.summary).toHaveProperty("total_stale_storage_gb")
      }
    })

    test("unused_tables rows have expected columns when data exists", () => {
      if (result.success && result.unused_tables.length > 0) {
        const row = result.unused_tables[0]
        expect(row).toHaveProperty("table_name")
        expect(row).toHaveProperty("schema_name")
        expect(row).toHaveProperty("database_name")
      }
    })

    test("idle_warehouses rows have expected columns when data exists", () => {
      if (result.success && result.idle_warehouses.length > 0) {
        const row = result.idle_warehouses[0]
        expect(row).toHaveProperty("warehouse_name")
        expect(row).toHaveProperty("warehouse_size")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Role / Grants Access
  // -------------------------------------------------------------------------
  describe("role_access", () => {
    let grantsResult: Awaited<ReturnType<typeof queryGrants>>
    let hierarchyResult: Awaited<ReturnType<typeof queryRoleHierarchy>>
    let userRolesResult: Awaited<ReturnType<typeof queryUserRoles>>

    beforeAll(async () => {
      ;[grantsResult, hierarchyResult, userRolesResult] = await Promise.all([
        queryGrants({ warehouse: WH, limit: 10 }),
        queryRoleHierarchy({ warehouse: WH }),
        queryUserRoles({ warehouse: WH, limit: 10 }),
      ])
    }, 90000)

    test("queryGrants returns valid shape", () => {
      expectValidResult(grantsResult)
      if (grantsResult.success) {
        expect(Array.isArray(grantsResult.grants)).toBe(true)
        expect(typeof grantsResult.grant_count).toBe("number")
        expect(typeof grantsResult.privilege_summary).toBe("object")
      }
    })

    test("queryGrants with role filter produces valid SQL", async () => {
      const r = await queryGrants({ warehouse: WH, role: "NONEXISTENT_ROLE_XYZ", limit: 10 })
      expectValidResult(r)
      if (r.success) expect(r.grants).toHaveLength(0)
    }, 60000)

    test("queryGrants with object_name filter produces valid SQL", async () => {
      const r = await queryGrants({ warehouse: WH, object_name: "NONEXISTENT_TABLE_XYZ", limit: 10 })
      expectValidResult(r)
      if (r.success) expect(r.grants).toHaveLength(0)
    }, 60000)

    test("queryRoleHierarchy returns valid shape", () => {
      expectValidResult(hierarchyResult)
      if (hierarchyResult.success) {
        expect(Array.isArray(hierarchyResult.hierarchy)).toBe(true)
        expect(typeof hierarchyResult.role_count).toBe("number")
        if (hierarchyResult.hierarchy.length > 0) {
          expect(hierarchyResult.hierarchy[0]).toHaveProperty("child_role")
          expect(hierarchyResult.hierarchy[0]).toHaveProperty("parent_role")
        }
      }
    })

    test("queryUserRoles returns valid shape", () => {
      expectValidResult(userRolesResult)
      if (userRolesResult.success) {
        expect(Array.isArray(userRolesResult.assignments)).toBe(true)
        expect(typeof userRolesResult.assignment_count).toBe("number")
      }
    })

    test("queryUserRoles with user filter produces valid SQL", async () => {
      const r = await queryUserRoles({ warehouse: WH, user: "NONEXISTENT_USER_XYZ", limit: 5 })
      expectValidResult(r)
      if (r.success) expect(r.assignments).toHaveLength(0)
    }, 60000)
  })

  // -------------------------------------------------------------------------
  // Tags (Snowflake-only)
  // -------------------------------------------------------------------------
  describe("schema_tags", () => {
    let listResult: Awaited<ReturnType<typeof listTags>>
    let getResult: Awaited<ReturnType<typeof getTags>>

    beforeAll(async () => {
      ;[listResult, getResult] = await Promise.all([
        listTags({ warehouse: WH, limit: 10 }),
        getTags({ warehouse: WH, limit: 10 }),
      ])
    }, 60000)

    test("listTags returns valid shape", () => {
      expectValidResult(listResult)
      if (listResult.success) {
        expect(Array.isArray(listResult.tags)).toBe(true)
        expect(typeof listResult.tag_count).toBe("number")
      }
    })

    test("listTags rows have expected columns when data exists", () => {
      if (listResult.success && listResult.tags.length > 0) {
        const row = listResult.tags[0]
        expect(row).toHaveProperty("tag_name")
        expect(row).toHaveProperty("tag_database")
        expect(row).toHaveProperty("tag_schema")
      }
    })

    test("getTags without object_name falls back to tag list", () => {
      expectValidResult(getResult)
      if (getResult.success) {
        expect(Array.isArray(getResult.tags)).toBe(true)
        expect(typeof getResult.tag_count).toBe("number")
        expect(typeof getResult.tag_summary).toBe("object")
      }
    })

    test("getTags with object_name produces valid SQL (TAG_REFERENCES_ALL_COLUMNS)", async () => {
      // Use a non-existent object — should return empty results, not a SQL error
      const r = await getTags({ warehouse: WH, object_name: "NONEXISTENT_DB.NONEXISTENT_SCHEMA.NONEXISTENT_TABLE", limit: 5 })
      if (!r.success) {
        expect(r.error).toBeDefined()
        expect(r.error).not.toMatch(/syntax error|unbound|invalid identifier/i)
      } else {
        expect(Array.isArray(r.tags)).toBe(true)
      }
    }, 60000)

    test("getTags with tag_name filter produces valid SQL", async () => {
      const r = await getTags({ warehouse: WH, object_name: "NONEXISTENT_DB.NONEXISTENT_SCHEMA.NONEXISTENT_TABLE", tag_name: "NONEXISTENT_TAG_XYZ", limit: 5 })
      if (!r.success) {
        expect(r.error).toBeDefined()
        expect(r.error).not.toMatch(/syntax error|unbound|invalid identifier/i)
      } else {
        expect(r.tags).toHaveLength(0)
      }
    }, 60000)
  })
})

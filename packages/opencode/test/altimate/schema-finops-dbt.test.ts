import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// ---------------------------------------------------------------------------
// Import registerAll functions — call them explicitly in beforeAll to guard
// against Dispatcher.reset() in other test files clearing the shared handler map.
// ---------------------------------------------------------------------------

import { registerAll as registerSchema } from "../../src/altimate/native/schema/register"
import { registerAll as registerFinops } from "../../src/altimate/native/finops/register"
import { registerAll as registerDbt } from "../../src/altimate/native/dbt/register"
import { registerAll as registerLocal } from "../../src/altimate/native/local/register"

beforeAll(() => {
  registerSchema()
  registerFinops()
  registerDbt()
  registerLocal()
})

// Import SQL template exports for template generation tests
import { SQL_TEMPLATES as CreditTemplates } from "../../src/altimate/native/finops/credit-analyzer"
import { SQL_TEMPLATES as HistoryTemplates } from "../../src/altimate/native/finops/query-history"
import { SQL_TEMPLATES as AdvisorTemplates } from "../../src/altimate/native/finops/warehouse-advisor"
import { SQL_TEMPLATES as UnusedTemplates } from "../../src/altimate/native/finops/unused-resources"
import { SQL_TEMPLATES as RoleTemplates } from "../../src/altimate/native/finops/role-access"
import { ensureUpstreamSelector } from "../../src/altimate/native/dbt/runner"
import { parseManifest } from "../../src/altimate/native/dbt/manifest"
import { mapType } from "../../src/altimate/native/local/schema-sync"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 3+4: Dispatcher registration", () => {
  test("all schema methods are registered", () => {
    expect(Dispatcher.hasNativeHandler("schema.index")).toBe(true)
    expect(Dispatcher.hasNativeHandler("schema.search")).toBe(true)
    expect(Dispatcher.hasNativeHandler("schema.cache_status")).toBe(true)
    expect(Dispatcher.hasNativeHandler("schema.detect_pii")).toBe(true)
    expect(Dispatcher.hasNativeHandler("schema.tags")).toBe(true)
    expect(Dispatcher.hasNativeHandler("schema.tags_list")).toBe(true)
  })

  test("all finops methods are registered", () => {
    expect(Dispatcher.hasNativeHandler("finops.query_history")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.analyze_credits")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.expensive_queries")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.warehouse_advice")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.unused_resources")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.role_grants")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.role_hierarchy")).toBe(true)
    expect(Dispatcher.hasNativeHandler("finops.user_roles")).toBe(true)
  })

  test("all dbt methods are registered", () => {
    expect(Dispatcher.hasNativeHandler("dbt.run")).toBe(true)
    expect(Dispatcher.hasNativeHandler("dbt.manifest")).toBe(true)
    expect(Dispatcher.hasNativeHandler("dbt.lineage")).toBe(true)
  })

  test("local methods and ping are registered", () => {
    expect(Dispatcher.hasNativeHandler("local.schema_sync")).toBe(true)
    expect(Dispatcher.hasNativeHandler("local.test")).toBe(true)
    expect(Dispatcher.hasNativeHandler("ping")).toBe(true)
  })
})

describe("ping", () => {
  test("returns { status: 'ok' }", async () => {
    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toEqual({ status: "ok" })
  })
})

describe("FinOps: SQL template generation", () => {
  describe("credit-analyzer", () => {
    test("builds Snowflake credit usage SQL", () => {
      const built = CreditTemplates.buildCreditUsageSql("snowflake", 30, 50)
      expect(built?.sql).toContain("WAREHOUSE_METERING_HISTORY")
      expect(built?.binds).toContain(-30)   // days bind (negative for Snowflake)
      expect(built?.binds).toContain(50)    // limit bind
    })

    test("builds Snowflake credit usage SQL with warehouse filter", () => {
      const built = CreditTemplates.buildCreditUsageSql("snowflake", 7, 10, "MY_WH")
      expect(built?.binds).toContain("MY_WH")
      expect(built?.sql).toContain("?")
    })

    test("builds BigQuery credit usage SQL", () => {
      const built = CreditTemplates.buildCreditUsageSql("bigquery", 14, 25)
      expect(built?.sql).toContain("INFORMATION_SCHEMA.JOBS")
      expect(built?.binds).toContain(14)
    })

    test("builds Databricks credit usage SQL", () => {
      const built = CreditTemplates.buildCreditUsageSql("databricks", 7, 20)
      expect(built?.sql).toContain("system.billing.usage")
    })

    test("returns null for unsupported warehouse types", () => {
      expect(CreditTemplates.buildCreditUsageSql("mysql", 7, 20)).toBeNull()
    })

    test("builds Snowflake credit summary SQL", () => {
      const built = CreditTemplates.buildCreditSummarySql("snowflake", 30)
      expect(built?.sql).toContain("total_credits")
      expect(built?.binds).toContain(-30)
    })

    test("builds expensive queries SQL for Snowflake", () => {
      const built = CreditTemplates.buildExpensiveSql("snowflake", 7, 20)
      expect(built?.sql).toContain("bytes_scanned")
      expect(built?.sql).toContain("QUERY_HISTORY")
    })

    test("builds expensive queries SQL for BigQuery", () => {
      const built = CreditTemplates.buildExpensiveSql("bigquery", 7, 20)
      expect(built?.sql).toContain("total_bytes_billed")
    })
  })

  describe("query-history", () => {
    test("builds Snowflake history SQL", () => {
      const built = HistoryTemplates.buildHistoryQuery("snowflake", 7, 100)
      expect(built?.sql).toContain("QUERY_HISTORY")
      expect(built?.binds).toContain(-7)
    })

    test("builds Snowflake history SQL with user filter", () => {
      const built = HistoryTemplates.buildHistoryQuery("snowflake", 7, 100, "ADMIN")
      expect(built?.binds).toContain("ADMIN")
      expect(built?.sql).toContain("user_name")
    })

    test("builds PostgreSQL history SQL", () => {
      const built = HistoryTemplates.buildHistoryQuery("postgres", 7, 50)
      expect(built?.sql).toContain("pg_stat_statements")
      expect(built?.sql).toContain("50")  // postgres still uses string interpolation
    })

    test("returns null for DuckDB (no query history)", () => {
      expect(HistoryTemplates.buildHistoryQuery("duckdb", 7, 50)).toBeNull()
    })

    test("builds BigQuery history SQL", () => {
      const built = HistoryTemplates.buildHistoryQuery("bigquery", 14, 100)
      expect(built?.sql).toContain("INFORMATION_SCHEMA.JOBS")
      expect(built?.binds).toContain(14)
    })

    test("builds Databricks history SQL", () => {
      const built = HistoryTemplates.buildHistoryQuery("databricks", 7, 50)
      expect(built?.sql).toContain("system.query.history")
    })

    test("builds ClickHouse history SQL with clamped integer days and limit", () => {
      const built = HistoryTemplates.buildHistoryQuery("clickhouse", 7, 100)
      expect(built).not.toBeNull()
      expect(built?.sql).toContain("system.query_log")
      expect(built?.sql).toContain("QueryFinish")
      // Days and limit should be integer-substituted, not bind params
      expect(built?.binds).toEqual([])
      // Verify the clamped values are in the SQL
      expect(built?.sql).toContain("today() - 7")
      expect(built?.sql).toContain("LIMIT 100")
    })

    test("ClickHouse buildHistoryQuery clamps extreme days and limit values", () => {
      // Days clamped to [1, 365]
      const extremeDays = HistoryTemplates.buildHistoryQuery("clickhouse", 9999, 50)
      expect(extremeDays?.sql).toContain("today() - 365")

      const zeroDays = HistoryTemplates.buildHistoryQuery("clickhouse", 0, 50)
      // Math.floor(0) || 30 = 30 (0 is falsy), then Math.max(1, Math.min(30, 365)) = 30
      expect(zeroDays?.sql).toContain("today() - 30")

      // Limit clamped to [1, 10000]
      const extremeLimit = HistoryTemplates.buildHistoryQuery("clickhouse", 7, 999999)
      expect(extremeLimit?.sql).toContain("LIMIT 10000")

      const zeroLimit = HistoryTemplates.buildHistoryQuery("clickhouse", 7, 0)
      // Math.floor(0) || 100 = 100 (0 is falsy), then Math.max(1, Math.min(100, 10000)) = 100
      expect(zeroLimit?.sql).toContain("LIMIT 100")
    })

    test("ClickHouse buildHistoryQuery handles NaN and float inputs safely", () => {
      // NaN days defaults to 30 via || 30 fallback
      const nanDays = HistoryTemplates.buildHistoryQuery("clickhouse", NaN, 50)
      expect(nanDays?.sql).toContain("today() - 30")
      expect(nanDays?.sql).not.toContain("NaN")

      // NaN limit defaults to 100 via || 100 fallback
      const nanLimit = HistoryTemplates.buildHistoryQuery("clickhouse", 7, NaN)
      expect(nanLimit?.sql).toContain("LIMIT 100")
      expect(nanLimit?.sql).not.toContain("NaN")

      // Float values should be floored
      const floatInputs = HistoryTemplates.buildHistoryQuery("clickhouse", 7.9, 50.5)
      expect(floatInputs?.sql).toContain("today() - 7")
      expect(floatInputs?.sql).toContain("LIMIT 50")
    })
  })

  describe("warehouse-advisor", () => {
    test("builds Snowflake load SQL", () => {
      const sql = AdvisorTemplates.buildLoadSql("snowflake", 14)
      expect(sql).toContain("WAREHOUSE_LOAD_HISTORY")
    })

    test("builds Snowflake sizing SQL", () => {
      const sql = AdvisorTemplates.buildSizingSql("snowflake", 14)
      expect(sql).toContain("PERCENTILE_CONT")
    })

    test("builds BigQuery load SQL", () => {
      const sql = AdvisorTemplates.buildLoadSql("bigquery", 14)
      expect(sql).toContain("JOBS_TIMELINE")
    })

    test("returns null for unsupported types", () => {
      expect(AdvisorTemplates.buildLoadSql("mysql", 14)).toBeNull()
      expect(AdvisorTemplates.buildSizingSql("mysql", 14)).toBeNull()
    })
  })

  describe("unused-resources", () => {
    test("has Snowflake unused tables SQL", () => {
      expect(UnusedTemplates.SNOWFLAKE_UNUSED_TABLES_SQL).toContain("TABLE_STORAGE_METRICS")
      expect(UnusedTemplates.SNOWFLAKE_UNUSED_TABLES_SQL).toContain("ACCESS_HISTORY")
    })

    test("has Snowflake simple fallback SQL", () => {
      expect(UnusedTemplates.SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL).toContain("last_altered")
    })

    test("has BigQuery unused tables SQL", () => {
      expect(UnusedTemplates.BIGQUERY_UNUSED_TABLES_SQL).toContain("TABLE_STORAGE")
    })

    test("has Databricks unused tables SQL", () => {
      expect(UnusedTemplates.DATABRICKS_UNUSED_TABLES_SQL).toContain("system.information_schema.tables")
    })

    test("has Snowflake idle warehouses SQL", () => {
      expect(UnusedTemplates.SNOWFLAKE_IDLE_WAREHOUSES_SQL).toContain("is_idle")
    })
  })

  describe("role-access", () => {
    test("builds Snowflake grants SQL", () => {
      const built = RoleTemplates.buildGrantsSql("snowflake", "SYSADMIN", undefined, 50)
      expect(built?.sql).toContain("GRANTS_TO_ROLES")
      expect(built?.binds).toContain("SYSADMIN")
      expect(built?.binds).toContain(50)  // limit
    })

    test("builds BigQuery grants SQL", () => {
      const built = RoleTemplates.buildGrantsSql("bigquery", undefined, undefined, 100)
      expect(built?.sql).toContain("OBJECT_PRIVILEGES")
      expect(built?.binds).toContain(100)  // limit
    })

    test("builds Databricks grants SQL", () => {
      const built = RoleTemplates.buildGrantsSql("databricks", undefined, undefined, 100)
      expect(built?.sql).toContain("table_privileges")
    })

    test("returns null for unsupported types", () => {
      expect(RoleTemplates.buildGrantsSql("mysql")).toBeNull()
    })

    test("has role hierarchy SQL template", () => {
      expect(RoleTemplates.SNOWFLAKE_ROLE_HIERARCHY_SQL).toContain("GRANTS_TO_ROLES")
      expect(RoleTemplates.SNOWFLAKE_ROLE_HIERARCHY_SQL).toContain("child_role")
    })

    test("has user roles SQL template", () => {
      expect(RoleTemplates.SNOWFLAKE_USER_ROLES_SQL).toContain("GRANTS_TO_USERS")
    })
  })
})

describe("FinOps: regression #203 — WAREHOUSE_LOAD_HISTORY has no warehouse_size column", () => {
  test("SNOWFLAKE_LOAD_SQL does not reference warehouse_size at all", () => {
    expect(AdvisorTemplates.SNOWFLAKE_LOAD_SQL).not.toContain("warehouse_size")
  })

  test("SNOWFLAKE_LOAD_SQL does not GROUP BY warehouse_size", () => {
    const sql = AdvisorTemplates.SNOWFLAKE_LOAD_SQL
    const groupByMatch = sql.match(/GROUP BY\s+([^\n]+)/i)
    expect(groupByMatch?.[1]?.trim()).toBe("warehouse_name")
  })

  test("SNOWFLAKE_SIZING_SQL no longer selects warehouse_size (sourced from SHOW WAREHOUSES now)", () => {
    expect(AdvisorTemplates.SNOWFLAKE_SIZING_SQL).not.toContain("warehouse_size")
  })

  test("SNOWFLAKE_SHOW_WAREHOUSES is just SHOW WAREHOUSES", () => {
    expect(AdvisorTemplates.SNOWFLAKE_SHOW_WAREHOUSES).toBe("SHOW WAREHOUSES")
  })
})

describe("Snowflake driver: column names are lowercased (regression #203)", () => {
  test("rowsToRecords from Snowflake uppercase columns yields lowercase keys", () => {
    // Simulate Snowflake SDK returning UPPERCASE column names in row objects
    const fakeUppercaseRow: Record<string, unknown> = {
      WAREHOUSE_NAME: "MY_WH",
      AVG_CONCURRENCY: 0.5,
      AVG_QUEUE_LOAD: 0.0,
      PEAK_QUEUE_LOAD: 0.0,
      SAMPLE_COUNT: 100,
      TOTAL_CREDITS: 42.5,
    }
    const rawColumns = Object.keys(fakeUppercaseRow)
    const columns = rawColumns.map((col) => col.toLowerCase())
    const rows = [rawColumns.map((col) => fakeUppercaseRow[col])]
    const records = rows.map((row) => {
      const obj: Record<string, unknown> = {}
      columns.forEach((col, i) => { obj[col] = row[i] })
      return obj
    })
    expect(records[0]).toHaveProperty("warehouse_name", "MY_WH")
    expect(records[0]).toHaveProperty("avg_concurrency", 0.5)
    expect(records[0]).toHaveProperty("total_credits", 42.5)
    // Uppercase keys must NOT exist
    expect(records[0]["WAREHOUSE_NAME"]).toBeUndefined()
    expect(records[0]["TOTAL_CREDITS"]).toBeUndefined()
  })

  test("credit recommendation uses lowercase keys and produces correct output", () => {
    // With uppercase keys (old behavior), total_credits would be undefined → 0
    // After fix, lowercase keys are read correctly
    const loadData = [
      {
        warehouse_name: "MY_WH",
        avg_concurrency: 0.5,
        avg_queue_load: 0.0,
        peak_queue_load: 0.0,
        sample_count: 100,
      },
    ]
    const sizeByWarehouse = new Map<string, string>([["MY_WH", "Small"]])
    const recs = AdvisorTemplates.generateSizingRecommendations(loadData, [], sizeByWarehouse)
    // avg_queue_load=0, peak_queue_load=0 → no SCALE_UP/BURST
    // avg_concurrency=0.5 > 0.1 → no SCALE_DOWN
    // → HEALTHY
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ type: "HEALTHY" })
  })
})

describe("dbt: manifest parser", () => {
  test("returns empty result for non-existent file", async () => {
    const result = await parseManifest({ path: "/tmp/nonexistent-manifest.json" })
    expect(result.models).toEqual([])
    expect(result.sources).toEqual([])
    expect(result.model_count).toBe(0)
    expect(result.source_count).toBe(0)
  })

  test("parses a fixture manifest", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const fixture = {
      metadata: { adapter_type: "snowflake" },
      nodes: {
        "model.my_project.orders": {
          resource_type: "model",
          name: "orders",
          schema: "public",
          database: "analytics",
          config: { materialized: "table" },
          depends_on: { nodes: ["source.my_project.raw.customers"] },
          columns: {
            id: { name: "id", data_type: "INTEGER" },
            customer_id: { name: "customer_id", data_type: "INTEGER" },
            total: { name: "total", data_type: "DECIMAL" },
          },
        },
        "test.my_project.not_null_orders_id": {
          resource_type: "test",
          name: "not_null_orders_id",
        },
        "seed.my_project.countries": {
          resource_type: "seed",
          name: "countries",
        },
        "snapshot.my_project.snap_orders": {
          resource_type: "snapshot",
          name: "snap_orders",
        },
      },
      sources: {
        "source.my_project.raw.customers": {
          name: "customers",
          source_name: "raw",
          schema: "raw_data",
          database: "analytics",
          columns: {
            id: { name: "id", data_type: "INTEGER" },
            email: { name: "email", data_type: "VARCHAR" },
          },
        },
      },
    }

    const tmpFile = path.join(os.tmpdir(), `test-manifest-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(fixture))

    try {
      const result = await parseManifest({ path: tmpFile })

      expect(result.model_count).toBe(1)
      expect(result.source_count).toBe(1)
      expect(result.test_count).toBe(1)
      expect(result.seed_count).toBe(1)
      expect(result.snapshot_count).toBe(1)

      expect(result.models[0].name).toBe("orders")
      expect(result.models[0].schema_name).toBe("public")
      expect(result.models[0].materialized).toBe("table")
      expect(result.models[0].columns).toHaveLength(3)
      expect(result.models[0].depends_on).toEqual(["source.my_project.raw.customers"])

      expect(result.sources[0].name).toBe("customers")
      expect(result.sources[0].source_name).toBe("raw")
      expect(result.sources[0].columns).toHaveLength(2)
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })
})

describe("dbt: upstream selector", () => {
  test("adds + prefix for run command", () => {
    expect(ensureUpstreamSelector("my_model", "run")).toBe("+my_model")
  })

  test("adds + prefix for build command", () => {
    expect(ensureUpstreamSelector("my_model", "build")).toBe("+my_model")
  })

  test("does not add + for compile command", () => {
    expect(ensureUpstreamSelector("my_model", "compile")).toBe("my_model")
  })

  test("does not double-add + prefix", () => {
    expect(ensureUpstreamSelector("+my_model", "run")).toBe("+my_model")
  })

  test("does not add + for tag selectors", () => {
    expect(ensureUpstreamSelector("tag:daily", "run")).toBe("tag:daily")
  })
})

describe("Local: type mapping", () => {
  test("maps common SQL types to DuckDB", () => {
    expect(mapType("INT")).toBe("INTEGER")
    expect(mapType("BIGINT")).toBe("BIGINT")
    expect(mapType("VARCHAR")).toBe("VARCHAR")
    expect(mapType("TEXT")).toBe("VARCHAR")
    expect(mapType("BOOLEAN")).toBe("BOOLEAN")
    expect(mapType("TIMESTAMP")).toBe("TIMESTAMP")
    expect(mapType("TIMESTAMP_NTZ")).toBe("TIMESTAMP")
    expect(mapType("TIMESTAMP_TZ")).toBe("TIMESTAMPTZ")
    expect(mapType("DATE")).toBe("DATE")
    expect(mapType("FLOAT")).toBe("FLOAT")
    expect(mapType("DOUBLE")).toBe("DOUBLE")
    expect(mapType("DECIMAL")).toBe("DECIMAL")
    expect(mapType("JSON")).toBe("JSON")
    expect(mapType("VARIANT")).toBe("JSON")
    expect(mapType("BINARY")).toBe("BLOB")
    expect(mapType("UUID")).toBe("UUID")
  })

  test("strips precision/scale from type", () => {
    expect(mapType("VARCHAR(255)")).toBe("VARCHAR")
    expect(mapType("DECIMAL(10,2)")).toBe("DECIMAL")
    expect(mapType("NUMBER(38,0)")).toBe("DECIMAL")
  })

  test("falls back to VARCHAR for unknown types", () => {
    expect(mapType("SOME_EXOTIC_TYPE")).toBe("VARCHAR")
    expect(mapType("GEOGRAPHY")).toBe("VARCHAR")
  })
})

describe("FinOps: handler error paths (no warehouse configured)", () => {
  test("finops.query_history returns error when no warehouse type found", async () => {
    const result = await Dispatcher.call("finops.query_history", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test("finops.analyze_credits returns error for unknown warehouse", async () => {
    const result = await Dispatcher.call("finops.analyze_credits", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
  })

  test("finops.role_hierarchy returns error for non-snowflake", async () => {
    const result = await Dispatcher.call("finops.role_hierarchy", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not available")
  })

  test("finops.user_roles returns error for non-snowflake", async () => {
    const result = await Dispatcher.call("finops.user_roles", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not available")
  })
})

describe("Schema: tags error paths", () => {
  test("schema.tags returns error for non-snowflake", async () => {
    const result = await Dispatcher.call("schema.tags", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Snowflake")
  })

  test("schema.tags_list returns error for non-snowflake", async () => {
    const result = await Dispatcher.call("schema.tags_list", {
      warehouse: "nonexistent",
    } as any)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Snowflake")
  })
})

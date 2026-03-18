/**
 * Databricks Driver E2E Tests
 *
 * Requires env var:
 *   export ALTIMATE_CODE_CONN_DATABRICKS_TEST='{"type":"databricks","server_hostname":"dbc-xxx.cloud.databricks.com","http_path":"/sql/1.0/warehouses/xxx","access_token":"dapixxx","catalog":"dbt","schema":"default"}'
 *
 * Skips all tests if not set.
 *
 * Tests cover: PAT auth, queries, DDL, schema introspection,
 * adversarial inputs, Databricks-specific features, Unity Catalog.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import type { Connector } from "@altimateai/drivers/types"

const DB_CONFIG = process.env.ALTIMATE_CODE_CONN_DATABRICKS_TEST
const HAS_DATABRICKS = !!DB_CONFIG

describe.skipIf(!HAS_DATABRICKS)("Databricks Driver E2E", () => {
  let connector: Connector

  beforeAll(async () => {
    const { connect } = await import("@altimateai/drivers/databricks")
    const config = JSON.parse(DB_CONFIG!)
    connector = await connect(config)
    await connector.connect()
  }, 30000)

  afterAll(async () => {
    if (connector) await connector.close()
  })

  // ---------------------------------------------------------------------------
  // PAT Authentication
  // ---------------------------------------------------------------------------
  describe("PAT Auth", () => {
    test("connects with personal access token", async () => {
      const r = await connector.execute("SELECT CURRENT_USER() AS u")
      expect(r.columns.length).toBe(1)
      expect(r.rows.length).toBe(1)
    })

    test("reports correct catalog and schema", async () => {
      const r = await connector.execute(
        "SELECT CURRENT_CATALOG() AS cat, CURRENT_SCHEMA() AS sch",
      )
      expect(r.rows[0][0]).toBe("dbt")
      expect(r.rows[0][1]).toBe("default")
    })

    test("rejects invalid token", async () => {
      const { connect } = await import("@altimateai/drivers/databricks")
      const config = JSON.parse(DB_CONFIG!)
      const badConn = await connect({ ...config, access_token: "dapi_invalid_token" })
      await expect(badConn.connect()).rejects.toThrow()
    }, 15000)
  })

  // ---------------------------------------------------------------------------
  // Basic Queries
  // ---------------------------------------------------------------------------
  describe("Query Execution", () => {
    test("SELECT literal integer", async () => {
      const r = await connector.execute("SELECT 1 AS n")
      expect(r.rows).toEqual([[1]])
      expect(r.truncated).toBe(false)
    })

    test("SELECT string literal", async () => {
      const r = await connector.execute("SELECT 'hello' AS greeting")
      expect(r.rows[0][0]).toBe("hello")
    })

    test("SELECT CURRENT_TIMESTAMP", async () => {
      const r = await connector.execute("SELECT CURRENT_TIMESTAMP() AS ts")
      expect(r.rows.length).toBe(1)
    })

    test("SELECT with math", async () => {
      const r = await connector.execute("SELECT 2 + 3 AS result")
      expect(r.rows[0][0]).toBe(5)
    })

    test("SELECT multiple columns and types", async () => {
      const r = await connector.execute(
        "SELECT 1 AS a, 'b' AS b, TRUE AS c, NULL AS d",
      )
      expect(r.columns).toEqual(["a", "b", "c", "d"])
    })
  })

  // ---------------------------------------------------------------------------
  // LIMIT Handling
  // ---------------------------------------------------------------------------
  describe("LIMIT Handling", () => {
    test("respects explicit LIMIT", async () => {
      const r = await connector.execute("SELECT * FROM range(100) LIMIT 5")
      expect(r.row_count).toBe(5)
    })

    test("truncates with limit parameter", async () => {
      const r = await connector.execute("SELECT * FROM range(100)", 3)
      expect(r.row_count).toBe(3)
      expect(r.truncated).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Schema Introspection
  // ---------------------------------------------------------------------------
  describe("Schema Introspection", () => {
    test("listSchemas returns schemas", async () => {
      const schemas = await connector.listSchemas()
      expect(schemas.length).toBeGreaterThan(0)
      expect(schemas).toContain("default")
    })

    test("listTables returns tables in default schema", async () => {
      const tables = await connector.listTables("default")
      expect(Array.isArray(tables)).toBe(true)
      if (tables.length > 0) {
        expect(tables[0]).toHaveProperty("name")
        expect(tables[0]).toHaveProperty("type")
      }
    })

    test("describeTable returns column metadata", async () => {
      const tables = await connector.listTables("default")
      if (tables.length === 0) return

      const cols = await connector.describeTable("default", tables[0].name)
      expect(cols.length).toBeGreaterThan(0)
      expect(cols[0]).toHaveProperty("name")
      expect(cols[0]).toHaveProperty("data_type")
      expect(cols[0]).toHaveProperty("nullable")
    })
  })

  // ---------------------------------------------------------------------------
  // DDL
  // ---------------------------------------------------------------------------
  describe("DDL", () => {
    test("CREATE TEMPORARY VIEW", async () => {
      await connector.execute(
        "CREATE OR REPLACE TEMPORARY VIEW _altimate_db_e2e AS SELECT 1 AS id, 'test' AS name",
      )
      const r = await connector.execute("SELECT * FROM _altimate_db_e2e")
      expect(r.row_count).toBe(1)
      expect(r.columns).toEqual(["id", "name"])
    })
  })

  // ---------------------------------------------------------------------------
  // Databricks-Specific / Unity Catalog
  // ---------------------------------------------------------------------------
  describe("Databricks-Specific", () => {
    test("SHOW CATALOGS", async () => {
      const r = await connector.execute("SHOW CATALOGS")
      expect(r.row_count).toBeGreaterThan(0)
    })

    test("SHOW SCHEMAS IN catalog", async () => {
      const r = await connector.execute("SHOW SCHEMAS IN dbt")
      expect(r.row_count).toBeGreaterThan(0)
    })

    test("SHOW TABLES", async () => {
      const r = await connector.execute("SHOW TABLES IN default")
      expect(r.row_count).toBeGreaterThanOrEqual(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Adversarial Inputs
  // ---------------------------------------------------------------------------
  describe("Adversarial Inputs", () => {
    test("SQL injection blocked (multi-statement)", async () => {
      await expect(
        connector.execute("SELECT 'safe'; DROP TABLE users; --"),
      ).rejects.toThrow()
    })

    test("empty query rejected", async () => {
      await expect(connector.execute("")).rejects.toThrow()
    })

    test("invalid SQL rejected", async () => {
      await expect(
        connector.execute("SELECTTTT INVALID"),
      ).rejects.toThrow()
    })

    test("non-existent table rejected", async () => {
      await expect(
        connector.execute("SELECT * FROM nonexistent_table_xyz_123"),
      ).rejects.toThrow(/cannot be found|not found/i)
    })

    test("Unicode strings work", async () => {
      const r = await connector.execute("SELECT '日本語' AS unicode_test")
      expect(r.rows[0][0]).toBe("日本語")
    })

    test("NULL handling", async () => {
      const r = await connector.execute("SELECT NULL AS null_col")
      expect(r.rows[0][0]).toBeNull()
    })

    test("Boolean types", async () => {
      const r = await connector.execute("SELECT TRUE AS t, FALSE AS f")
      expect(r.rows[0][0]).toBe(true)
      expect(r.rows[0][1]).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Bind Parameters
  // ---------------------------------------------------------------------------
  describe("Bind Parameters", () => {
    beforeAll(async () => {
      await connector.execute(`
        CREATE OR REPLACE TEMPORARY VIEW _altimate_binds_test AS
        SELECT * FROM (VALUES
          (1, 'alice', 9.5,  true,  CAST('2024-01-01 10:00:00' AS TIMESTAMP)),
          (2, 'bob',   7.2,  false, CAST('2024-06-15 12:30:00' AS TIMESTAMP)),
          (3, 'carol', 8.8,  true,  CAST('2024-12-31 23:59:59' AS TIMESTAMP))
        ) AS t(id, name, score, active, created_at)
      `)
    }, 30000)

    afterAll(async () => {
      try { await connector.execute("DROP VIEW IF EXISTS _altimate_binds_test") } catch {}
    })

    test("binds a single string parameter", async () => {
      const result = await connector.execute(
        "SELECT name FROM _altimate_binds_test WHERE name = ?",
        undefined,
        ["alice"],
      )
      expect(result.columns).toEqual(["name"])
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][0]).toBe("alice")
    })

    test("binds a single integer parameter", async () => {
      const result = await connector.execute(
        "SELECT id, name FROM _altimate_binds_test WHERE id = ?",
        undefined,
        [2],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][1]).toBe("bob")
    })

    test("binds multiple parameters", async () => {
      const result = await connector.execute(
        "SELECT name FROM _altimate_binds_test WHERE id >= ? AND id <= ? ORDER BY id",
        undefined,
        [1, 2],
      )
      expect(result.rows).toHaveLength(2)
      expect(result.rows[0][0]).toBe("alice")
      expect(result.rows[1][0]).toBe("bob")
    })

    test("binds a float parameter", async () => {
      const result = await connector.execute(
        "SELECT name FROM _altimate_binds_test WHERE score > ? ORDER BY score DESC",
        undefined,
        [9.0],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][0]).toBe("alice")
    })

    test("returns no rows when bind value matches nothing", async () => {
      const result = await connector.execute(
        "SELECT * FROM _altimate_binds_test WHERE name = ?",
        undefined,
        ["nobody"],
      )
      expect(result.rows).toHaveLength(0)
      expect(result.row_count).toBe(0)
    })

    test("empty binds array behaves same as no binds", async () => {
      const withEmpty = await connector.execute(
        "SELECT COUNT(*) AS n FROM _altimate_binds_test",
        undefined,
        [],
      )
      const withNone = await connector.execute("SELECT COUNT(*) AS n FROM _altimate_binds_test")
      expect(withEmpty.rows[0][0]).toBe(withNone.rows[0][0])
    })

    test("prevents SQL injection via binding", async () => {
      const result = await connector.execute(
        "SELECT name FROM _altimate_binds_test WHERE name = ?",
        undefined,
        ["' OR '1'='1"],
      )
      expect(result.rows).toHaveLength(0)
    })

    test("binds a NULL parameter", async () => {
      await connector.execute(`
        CREATE OR REPLACE TEMPORARY VIEW _altimate_null_test AS
        SELECT * FROM (VALUES (CAST(NULL AS STRING)), ('hello')) AS t(val)
      `)
      const result = await connector.execute(
        "SELECT val FROM _altimate_null_test WHERE val IS NOT DISTINCT FROM ?",
        undefined,
        [null],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][0]).toBeNull()
      await connector.execute("DROP VIEW IF EXISTS _altimate_null_test")
    })

    test("scalar bind — SELECT ? returns the bound value", async () => {
      const result = await connector.execute("SELECT ? AS val", undefined, [42])
      expect(result.columns).toEqual(["val"])
      expect(Number(result.rows[0][0])).toBe(42)
    })

    test("binds a string with special characters", async () => {
      const special = "O'Brien & \"Partners\""
      const result = await connector.execute("SELECT ? AS val", undefined, [special])
      expect(result.rows[0][0]).toBe(special)
    })

    test("binds a Unicode string", async () => {
      const unicode = "日本語テスト"
      const result = await connector.execute("SELECT ? AS val", undefined, [unicode])
      expect(result.rows[0][0]).toBe(unicode)
    })
  })
})

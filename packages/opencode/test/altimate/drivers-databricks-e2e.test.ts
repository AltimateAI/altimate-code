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
})

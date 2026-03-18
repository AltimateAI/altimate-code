/**
 * BigQuery Driver E2E Tests
 *
 * Requires env var:
 *   export ALTIMATE_CODE_CONN_BIGQUERY_TEST='{"type":"bigquery","project":"my-project","credentials_path":"/path/to/service-account.json"}'
 *
 * Skips all tests if not set.
 *
 * Tests cover: service account auth, queries, schema introspection,
 * BigQuery-specific types, adversarial inputs.
 *
 * Note: BigQuery doesn't support CREATE TEMP TABLE outside sessions,
 * so DDL tests use dataset-qualified tables where available.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import type { Connector } from "@altimateai/drivers/types"

const BQ_CONFIG = process.env.ALTIMATE_CODE_CONN_BIGQUERY_TEST
const HAS_BIGQUERY = !!BQ_CONFIG

describe.skipIf(!HAS_BIGQUERY)("BigQuery Driver E2E", () => {
  let connector: Connector

  beforeAll(async () => {
    const { connect } = await import("@altimateai/drivers/bigquery")
    const config = JSON.parse(BQ_CONFIG!)
    connector = await connect(config)
    await connector.connect()
  }, 30000)

  afterAll(async () => {
    if (connector) await connector.close()
  })

  // ---------------------------------------------------------------------------
  // Service Account Authentication
  // ---------------------------------------------------------------------------
  describe("Service Account Auth", () => {
    test("connects with credentials_path", async () => {
      const r = await connector.execute("SELECT 1 AS n")
      expect(r.rows).toEqual([[1]])
    })

    test("reports correct project", async () => {
      const r = await connector.execute("SELECT @@project_id AS project")
      expect(r.rows[0][0]).toBe("diesel-command-384802")
    })

    test("rejects invalid credentials on first query", async () => {
      const { connect } = await import("@altimateai/drivers/bigquery")
      const config = JSON.parse(BQ_CONFIG!)
      const badConn = await connect({ ...config, credentials_path: "/nonexistent/creds.json" })
      await badConn.connect() // BigQuery SDK connects lazily
      await expect(badConn.execute("SELECT 1")).rejects.toThrow()
    }, 15000)
  })

  // ---------------------------------------------------------------------------
  // Basic Queries
  // ---------------------------------------------------------------------------
  describe("Query Execution", () => {
    test("SELECT literal integer", async () => {
      const r = await connector.execute("SELECT 1 AS n")
      expect(r.columns).toEqual(["n"])
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

    test("SELECT multiple types", async () => {
      const r = await connector.execute(
        "SELECT 1 AS a, 'b' AS b, TRUE AS c, NULL AS d",
      )
      expect(r.columns).toEqual(["a", "b", "c", "d"])
      expect(r.rows[0][2]).toBe(true)
      expect(r.rows[0][3]).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // LIMIT Handling
  // ---------------------------------------------------------------------------
  describe("LIMIT Handling", () => {
    test("respects explicit LIMIT", async () => {
      const r = await connector.execute(
        "SELECT num FROM UNNEST(GENERATE_ARRAY(1, 100)) AS num LIMIT 5",
      )
      expect(r.row_count).toBe(5)
    })

    test("truncates with limit parameter", async () => {
      const r = await connector.execute(
        "SELECT num FROM UNNEST(GENERATE_ARRAY(1, 100)) AS num",
        3,
      )
      expect(r.row_count).toBe(3)
      expect(r.truncated).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Schema Introspection
  // ---------------------------------------------------------------------------
  describe("Schema Introspection", () => {
    test("listSchemas returns datasets", async () => {
      const schemas = await connector.listSchemas()
      expect(schemas.length).toBeGreaterThan(0)
    })

    test("listTables returns tables/views", async () => {
      const schemas = await connector.listSchemas()
      const firstSchema = schemas.find(
        (s) => !s.startsWith("INFORMATION_SCHEMA"),
      )
      if (!firstSchema) return

      const tables = await connector.listTables(firstSchema)
      expect(Array.isArray(tables)).toBe(true)
      if (tables.length > 0) {
        expect(tables[0]).toHaveProperty("name")
        expect(tables[0]).toHaveProperty("type")
      }
    })

    test("describeTable returns column metadata", async () => {
      const schemas = await connector.listSchemas()
      const firstSchema = schemas.find(
        (s) => !s.startsWith("INFORMATION_SCHEMA"),
      )
      if (!firstSchema) return

      const tables = await connector.listTables(firstSchema)
      if (tables.length === 0) return

      const cols = await connector.describeTable(firstSchema, tables[0].name)
      expect(cols.length).toBeGreaterThan(0)
      expect(cols[0]).toHaveProperty("name")
      expect(cols[0]).toHaveProperty("data_type")
    })
  })

  // ---------------------------------------------------------------------------
  // BigQuery-Specific Types & Functions
  // ---------------------------------------------------------------------------
  describe("BigQuery-Specific", () => {
    test("UNNEST array", async () => {
      const r = await connector.execute(
        "SELECT x FROM UNNEST([1, 2, 3]) AS x ORDER BY x",
      )
      expect(r.row_count).toBe(3)
      expect(r.rows.map((row: any) => row[0])).toEqual([1, 2, 3])
    })

    test("STRUCT type", async () => {
      const r = await connector.execute(
        "SELECT STRUCT(1 AS a, 'b' AS b) AS s",
      )
      expect(r.rows.length).toBe(1)
    })

    test("DATE / DATETIME / TIMESTAMP", async () => {
      const r = await connector.execute(
        "SELECT CURRENT_DATE() AS d, CURRENT_DATETIME() AS dt, CURRENT_TIMESTAMP() AS ts",
      )
      expect(r.columns).toEqual(["d", "dt", "ts"])
    })

    test("STRING_AGG", async () => {
      const r = await connector.execute(
        "SELECT STRING_AGG(x, ',') AS joined FROM UNNEST(['a', 'b', 'c']) AS x",
      )
      expect(r.rows[0][0]).toBe("a,b,c")
    })

    test("GENERATE_ARRAY", async () => {
      const r = await connector.execute(
        "SELECT ARRAY_LENGTH(GENERATE_ARRAY(1, 10)) AS len",
      )
      expect(r.rows[0][0]).toBe(10)
    })
  })

  // ---------------------------------------------------------------------------
  // Adversarial Inputs
  // ---------------------------------------------------------------------------
  describe("Adversarial Inputs", () => {
    test("multi-statement SQL rejected", async () => {
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

    test("non-existent dataset rejected", async () => {
      await expect(
        connector.execute(
          "SELECT * FROM nonexistent_dataset_xyz.nonexistent_table",
        ),
      ).rejects.toThrow(/not found/i)
    })

    test("Unicode strings work", async () => {
      const r = await connector.execute(
        "SELECT '日本語テスト' AS unicode_test",
      )
      expect(r.rows[0][0]).toBe("日本語テスト")
    })

    test("NULL handling", async () => {
      const r = await connector.execute("SELECT NULL AS null_col")
      expect(r.rows[0][0]).toBeNull()
    })

    test("very long column list", async () => {
      const cols = Array.from(
        { length: 50 },
        (_, i) => `${i + 1} AS c${i + 1}`,
      )
      const r = await connector.execute(`SELECT ${cols.join(", ")}`)
      expect(r.columns.length).toBe(50)
    })
  })

  // ---------------------------------------------------------------------------
  // Bind Parameters
  // ---------------------------------------------------------------------------
  describe("Bind Parameters", () => {
    test("scalar bind — SELECT ? returns the bound value", async () => {
      const r = await connector.execute("SELECT ? AS val", undefined, [42])
      expect(r.columns).toEqual(["val"])
      expect(r.rows[0][0]).toBe(42)
    })

    test("binds a single integer with UNNEST", async () => {
      const r = await connector.execute(
        "SELECT n FROM UNNEST(GENERATE_ARRAY(1, 5)) AS n WHERE n = ?",
        undefined,
        [3],
      )
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0][0]).toBe(3)
    })

    test("binds multiple parameters", async () => {
      const r = await connector.execute(
        "SELECT n FROM UNNEST(GENERATE_ARRAY(1, 10)) AS n WHERE n >= ? AND n <= ? ORDER BY n",
        undefined,
        [3, 5],
      )
      expect(r.rows).toHaveLength(3)
      expect(r.rows[0][0]).toBe(3)
      expect(r.rows[2][0]).toBe(5)
    })

    test("returns no rows when bind value matches nothing", async () => {
      const r = await connector.execute(
        "SELECT n FROM UNNEST(GENERATE_ARRAY(1, 5)) AS n WHERE n = ?",
        undefined,
        [99],
      )
      expect(r.rows).toHaveLength(0)
      expect(r.row_count).toBe(0)
    })

    test("empty binds array behaves same as no binds", async () => {
      const withEmpty = await connector.execute("SELECT 1 AS n", undefined, [])
      const withNone = await connector.execute("SELECT 1 AS n")
      expect(withEmpty.rows[0][0]).toBe(withNone.rows[0][0])
    })

    test("prevents SQL injection via binding", async () => {
      const r = await connector.execute(
        "SELECT x FROM UNNEST(['alice', 'bob']) AS x WHERE x = ?",
        undefined,
        ["' OR '1'='1"],
      )
      expect(r.rows).toHaveLength(0)
    })

    test("binds a string parameter", async () => {
      const r = await connector.execute(
        "SELECT x FROM UNNEST(['alice', 'bob', 'carol']) AS x WHERE x = ?",
        undefined,
        ["bob"],
      )
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0][0]).toBe("bob")
    })

    test("binds a string with special characters", async () => {
      const special = "O'Brien & \"Partners\""
      const r = await connector.execute("SELECT ? AS val", undefined, [special])
      expect(r.rows[0][0]).toBe(special)
    })

    test("binds a Unicode string", async () => {
      const unicode = "日本語テスト"
      const r = await connector.execute("SELECT ? AS val", undefined, [unicode])
      expect(r.rows[0][0]).toBe(unicode)
    })

    test("binds work alongside maxResults truncation", async () => {
      const r = await connector.execute(
        "SELECT n FROM UNNEST(GENERATE_ARRAY(1, 200)) AS n WHERE n >= ?",
        100,
        [1],
      )
      expect(r.truncated).toBe(true)
      expect(r.row_count).toBe(100)
    })
  })
})

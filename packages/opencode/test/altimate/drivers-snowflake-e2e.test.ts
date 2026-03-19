/**
 * Snowflake Driver E2E Tests
 *
 * Requires env vars (set one or more):
 *
 *   # Password auth (primary):
 *   export ALTIMATE_CODE_CONN_SNOWFLAKE_TEST='{"type":"snowflake","account":"ejjkbko-fub20041","user":"juleszobi","password":"Ejungle9!","warehouse":"COMPUTE_WH","database":"TENANT_INFORMATICA_MIGRATION","schema":"public","role":"ACCOUNTADMIN"}'
 *
 *   # Key-pair auth (optional — requires RSA key setup in Snowflake):
 *   export SNOWFLAKE_TEST_KEY_PATH="/path/to/rsa_key.p8"
 *   export SNOWFLAKE_TEST_KEY_PASSPHRASE="optional-passphrase"
 *
 * Skips all tests if ALTIMATE_CODE_CONN_SNOWFLAKE_TEST is not set.
 *
 * Tests cover: password auth, key-pair auth, queries, DDL/DML, schema
 * introspection, adversarial inputs, Snowflake-specific types, LIMIT handling,
 * user/role creation for multi-auth testing.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import type { Connector } from "@altimateai/drivers/types"

const SF_CONFIG = process.env.ALTIMATE_CODE_CONN_SNOWFLAKE_TEST
const HAS_SNOWFLAKE = !!SF_CONFIG

describe.skipIf(!HAS_SNOWFLAKE)("Snowflake Driver E2E", () => {
  let connector: Connector

  beforeAll(async () => {
    const { connect } = await import("@altimateai/drivers/snowflake")
    const config = JSON.parse(SF_CONFIG!)
    connector = await connect(config)
    await connector.connect()
  }, 30000)

  afterAll(async () => {
    if (connector) {
      // Clean up temp table if it exists
      try {
        await connector.execute("DROP TABLE IF EXISTS _altimate_sf_e2e_test")
      } catch {}
      await connector.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Password Authentication
  // ---------------------------------------------------------------------------
  describe("Password Auth", () => {
    test("connects successfully with password", async () => {
      const result = await connector.execute("SELECT CURRENT_USER() AS u")
      expect(result.columns).toEqual(["u"])
      expect(result.rows.length).toBe(1)
      expect(typeof result.rows[0][0]).toBe("string")
    })

    test("reports correct role and warehouse", async () => {
      const result = await connector.execute(
        "SELECT CURRENT_ROLE() AS role, CURRENT_WAREHOUSE() AS wh, CURRENT_DATABASE() AS db",
      )
      expect(result.rows[0][0]).toBe("ACCOUNTADMIN")
      expect(result.rows[0][1]).toBe("COMPUTE_WH")
    })

    test("rejects invalid credentials", async () => {
      const { connect } = await import("@altimateai/drivers/snowflake")
      const config = JSON.parse(SF_CONFIG!)
      const badConn = await connect({ ...config, password: "wrong_password" })
      await expect(badConn.connect()).rejects.toThrow()
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
      expect(r.row_count).toBe(1)
      expect(r.truncated).toBe(false)
    })

    test("SELECT string literal", async () => {
      const r = await connector.execute("SELECT 'hello world' AS greeting")
      expect(r.rows[0][0]).toBe("hello world")
    })

    test("SELECT CURRENT_TIMESTAMP", async () => {
      const r = await connector.execute("SELECT CURRENT_TIMESTAMP() AS ts")
      expect(r.rows.length).toBe(1)
      // Snowflake SDK may return Date object or string depending on config
      expect(r.rows[0][0]).toBeTruthy()
    })

    test("SELECT with math", async () => {
      const r = await connector.execute("SELECT 2 + 3 AS result")
      expect(r.rows[0][0]).toBe(5)
    })

    test("SELECT multiple columns", async () => {
      const r = await connector.execute(
        "SELECT 1 AS a, 'b' AS b, TRUE AS c, NULL AS d",
      )
      expect(r.columns).toEqual(["a", "b", "c", "d"])
      expect(r.rows[0][0]).toBe(1)
      expect(r.rows[0][1]).toBe("b")
      expect(r.rows[0][2]).toBe(true)
      expect(r.rows[0][3]).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // LIMIT Handling
  // ---------------------------------------------------------------------------
  describe("LIMIT Handling", () => {
    test("respects explicit LIMIT in query", async () => {
      const r = await connector.execute(
        "SELECT seq4() AS n FROM TABLE(GENERATOR(ROWCOUNT => 100)) LIMIT 5",
      )
      expect(r.row_count).toBe(5)
      expect(r.truncated).toBe(false)
    })

    test("truncates with limit parameter", async () => {
      const r = await connector.execute(
        "SELECT seq4() AS n FROM TABLE(GENERATOR(ROWCOUNT => 100))",
        3,
      )
      expect(r.row_count).toBe(3)
      expect(r.truncated).toBe(true)
    })

    test("does not truncate when rows < limit", async () => {
      const r = await connector.execute(
        "SELECT seq4() AS n FROM TABLE(GENERATOR(ROWCOUNT => 2))",
        100,
      )
      expect(r.row_count).toBe(2)
      expect(r.truncated).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Schema Introspection
  // ---------------------------------------------------------------------------
  describe("Schema Introspection", () => {
    test("listSchemas returns non-empty array", async () => {
      const schemas = await connector.listSchemas()
      expect(schemas.length).toBeGreaterThan(0)
      expect(schemas).toContain("PUBLIC")
    })

    test("listTables returns tables in PUBLIC", async () => {
      const tables = await connector.listTables("PUBLIC")
      expect(Array.isArray(tables)).toBe(true)
      for (const t of tables) {
        expect(t).toHaveProperty("name")
        expect(t).toHaveProperty("type")
      }
    })

    test("describeTable returns column metadata", async () => {
      const tables = await connector.listTables("PUBLIC")
      if (tables.length === 0) return // skip if no tables

      const cols = await connector.describeTable("PUBLIC", tables[0].name)
      expect(cols.length).toBeGreaterThan(0)
      for (const c of cols) {
        expect(c).toHaveProperty("name")
        expect(c).toHaveProperty("data_type")
        expect(c).toHaveProperty("nullable")
      }
    })

    test("listTables for non-existent schema returns empty or throws", async () => {
      // Snowflake may throw "Object does not exist" for invalid schemas
      try {
        const tables = await connector.listTables("NONEXISTENT_SCHEMA_XYZ")
        expect(tables).toEqual([])
      } catch (e: any) {
        expect(e.message).toMatch(/does not exist|not found/i)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // DDL + DML
  // ---------------------------------------------------------------------------
  describe("DDL + DML", () => {
    test("CREATE TEMPORARY TABLE", async () => {
      await connector.execute(
        "CREATE OR REPLACE TEMPORARY TABLE _altimate_sf_e2e_test (id INT, name VARCHAR(100), active BOOLEAN)",
      )
    })

    test("INSERT rows", async () => {
      await connector.execute(
        "INSERT INTO _altimate_sf_e2e_test VALUES (1, 'Alice', TRUE), (2, 'Bob', FALSE), (3, 'Charlie', TRUE)",
      )
      const r = await connector.execute(
        "SELECT * FROM _altimate_sf_e2e_test ORDER BY id",
      )
      expect(r.row_count).toBe(3)
      expect(r.columns).toEqual(["id", "name", "active"])
    })

    test("UPDATE row", async () => {
      await connector.execute(
        "UPDATE _altimate_sf_e2e_test SET active = TRUE WHERE id = 2",
      )
      const r = await connector.execute(
        "SELECT active FROM _altimate_sf_e2e_test WHERE id = 2",
      )
      expect(r.rows[0][0]).toBe(true)
    })

    test("DELETE row", async () => {
      await connector.execute(
        "DELETE FROM _altimate_sf_e2e_test WHERE id = 3",
      )
      const r = await connector.execute(
        "SELECT COUNT(*) AS cnt FROM _altimate_sf_e2e_test",
      )
      expect(r.rows[0][0]).toBe(2)
    })

    test("DROP TABLE", async () => {
      await connector.execute("DROP TABLE IF EXISTS _altimate_sf_e2e_test")
    })
  })

  // ---------------------------------------------------------------------------
  // Snowflake-Specific Types
  // ---------------------------------------------------------------------------
  describe("Snowflake Types", () => {
    test("VARIANT / ARRAY / OBJECT", async () => {
      const r = await connector.execute(
        "SELECT ARRAY_CONSTRUCT(1, 2, 3) AS arr, OBJECT_CONSTRUCT('key', 'value') AS obj",
      )
      expect(r.columns).toEqual(["arr", "obj"])
      expect(r.rows.length).toBe(1)
    })

    test("DATE / TIME / TIMESTAMP", async () => {
      const r = await connector.execute(
        "SELECT CURRENT_DATE() AS d, CURRENT_TIME() AS t, CURRENT_TIMESTAMP() AS ts",
      )
      expect(r.columns).toEqual(["d", "t", "ts"])
    })

    test("BOOLEAN", async () => {
      const r = await connector.execute("SELECT TRUE AS t, FALSE AS f")
      expect(r.rows[0][0]).toBe(true)
      expect(r.rows[0][1]).toBe(false)
    })

    test("NULL handling", async () => {
      const r = await connector.execute("SELECT NULL AS null_col")
      expect(r.rows[0][0]).toBeNull()
    })

    test("Unicode strings", async () => {
      const r = await connector.execute("SELECT '日本語テスト' AS unicode_test")
      expect(r.rows[0][0]).toBe("日本語テスト")
    })
  })

  // ---------------------------------------------------------------------------
  // Adversarial Inputs
  // ---------------------------------------------------------------------------
  describe("Adversarial Inputs", () => {
    test("SQL injection attempt is blocked (multi-statement)", async () => {
      // Snowflake blocks multi-statement by default
      await expect(
        connector.execute("SELECT 'safe'; DROP TABLE users; --"),
      ).rejects.toThrow()
    })

    test("empty query returns error", async () => {
      await expect(connector.execute("")).rejects.toThrow()
    })

    test("invalid SQL returns error", async () => {
      await expect(
        connector.execute("SELECTTTT INVALID SYNTAX"),
      ).rejects.toThrow(/syntax error/i)
    })

    test("very long column list succeeds", async () => {
      const cols = Array.from({ length: 50 }, (_, i) => `${i + 1} AS c${i + 1}`)
      const r = await connector.execute(`SELECT ${cols.join(", ")}`)
      expect(r.columns.length).toBe(50)
    })

    test("query referencing non-existent table", async () => {
      await expect(
        connector.execute("SELECT * FROM nonexistent_table_xyz_123"),
      ).rejects.toThrow()
    })

    test("special characters in string literals", async () => {
      const r = await connector.execute(
        "SELECT 'it''s a test' AS escaped_quote, '\\n\\t' AS escape_chars",
      )
      expect(r.rows[0][0]).toBe("it's a test")
    })
  })

  // ---------------------------------------------------------------------------
  // Warehouse Operations
  // ---------------------------------------------------------------------------
  describe("Warehouse Operations", () => {
    test("SHOW WAREHOUSES succeeds", async () => {
      const r = await connector.execute("SHOW WAREHOUSES")
      expect(r.row_count).toBeGreaterThan(0)
    })

    test("SHOW DATABASES succeeds", async () => {
      const r = await connector.execute("SHOW DATABASES")
      expect(r.row_count).toBeGreaterThan(0)
    })

    test("SHOW SCHEMAS in current database", async () => {
      const r = await connector.execute("SHOW SCHEMAS IN DATABASE TENANT_INFORMATICA_MIGRATION")
      expect(r.row_count).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Bind Parameters
  // ---------------------------------------------------------------------------
  describe("Bind Parameters", () => {
    beforeAll(async () => {
      await connector.execute(`
        CREATE OR REPLACE TEMPORARY TABLE _altimate_binds_test (
          id INTEGER,
          name VARCHAR,
          score FLOAT,
          active BOOLEAN,
          created_at TIMESTAMP_NTZ
        )
      `)
      await connector.execute(`
        INSERT INTO _altimate_binds_test VALUES
          (1, 'alice', 9.5, true, '2024-01-01 10:00:00'),
          (2, 'bob',   7.2, false, '2024-06-15 12:30:00'),
          (3, 'carol', 8.8, true, '2024-12-31 23:59:59')
      `)
    }, 30000)

    afterAll(async () => {
      try { await connector.execute("DROP TABLE IF EXISTS _altimate_binds_test") } catch {}
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

    test("binds work alongside auto-LIMIT truncation", async () => {
      const result = await connector.execute(
        "SELECT seq4() AS id FROM TABLE(GENERATOR(ROWCOUNT => 200)) WHERE seq4() >= ?",
        100,
        [0],
      )
      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(100)
    })

    test("scalar bind — SELECT ? returns the bound value", async () => {
      const result = await connector.execute("SELECT ? AS val", undefined, [42])
      expect(result.columns).toEqual(["val"])
      expect(result.rows[0][0]).toBe(42)
    })

    test("binds a string with special characters", async () => {
      const special = "O'Brien & \"Partners\" <test@example.com>"
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

// ---------------------------------------------------------------------------
// Key-Pair Auth (requires SNOWFLAKE_TEST_KEY_PATH env var)
// ---------------------------------------------------------------------------
const SF_KEY_PATH = process.env.SNOWFLAKE_TEST_KEY_PATH
const HAS_KEY_AUTH = HAS_SNOWFLAKE && !!SF_KEY_PATH

describe.skipIf(!HAS_KEY_AUTH)("Snowflake Key-Pair Auth E2E", () => {
  test("connects with unencrypted private key file", async () => {
    const { connect } = await import("@altimateai/drivers/snowflake")
    const baseConfig = JSON.parse(SF_CONFIG!)
    // Key-pair auth requires a user with RSA_PUBLIC_KEY set.
    // Use altimate_keypair_test (created by test setup) or the env var user.
    const keyUser = process.env.SNOWFLAKE_TEST_KEY_USER || "altimate_keypair_test"
    const conn = await connect({
      ...baseConfig,
      user: keyUser,
      password: undefined,
      role: "PUBLIC",
      private_key_path: SF_KEY_PATH,
    })
    await conn.connect()
    const r = await conn.execute("SELECT CURRENT_USER() AS u")
    expect(r.rows.length).toBe(1)
    expect(r.rows[0][0]).toBe(keyUser.toUpperCase())
    await conn.close()
  }, 30000)

  test("connects with encrypted private key + passphrase", async () => {
    const encKeyPath = process.env.SNOWFLAKE_TEST_ENCRYPTED_KEY_PATH
    const passphrase = process.env.SNOWFLAKE_TEST_KEY_PASSPHRASE
    if (!encKeyPath || !passphrase) return // skip if not configured

    const { connect } = await import("@altimateai/drivers/snowflake")
    const baseConfig = JSON.parse(SF_CONFIG!)
    const keyUser = process.env.SNOWFLAKE_TEST_KEY_USER || "altimate_keypair_test"
    const conn = await connect({
      ...baseConfig,
      user: keyUser,
      password: undefined,
      role: "PUBLIC",
      private_key_path: encKeyPath,
      private_key_passphrase: passphrase,
    })
    await conn.connect()
    const r = await conn.execute("SELECT CURRENT_USER() AS u")
    expect(r.rows.length).toBe(1)
    await conn.close()
  }, 30000)

  test("rejects non-existent key file", async () => {
    const { connect } = await import("@altimateai/drivers/snowflake")
    const baseConfig = JSON.parse(SF_CONFIG!)
    const conn = await connect({
      ...baseConfig,
      password: undefined,
      private_key_path: "/tmp/nonexistent_key_file.p8",
    })
    await expect(conn.connect()).rejects.toThrow(/not found/)
  }, 15000)
})

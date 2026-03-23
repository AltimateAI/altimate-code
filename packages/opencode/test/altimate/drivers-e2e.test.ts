import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { execSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import net from "net"
import type { Connector, ConnectorResult } from "@altimateai/drivers/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// isDuckDBAvailable uses a synchronous require() as a fast pre-check.
// NOTE: require() may succeed even when the native binding is broken (e.g.
// in a worktree where node-pre-gyp hasn't installed the .node file).
// The beforeAll block catches that case and sets duckdbReady accordingly.
function isDuckDBAvailable(): boolean {
  try {
    require("duckdb")
    return true
  } catch {
    return false
  }
}

function isDockerAvailable(): boolean {
  if (process.env.TEST_PG_HOST) return true // CI services replace Docker
  if (!process.env.DRIVER_E2E_DOCKER) return false // Skip unless opted in
  try {
    execSync("docker info", { stdio: "ignore", timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function waitForPort(
  port: number,
  timeoutMs: number = 30000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
          sock.destroy()
          resolve()
        })
        sock.on("error", reject)
        sock.setTimeout(1000, () => {
          sock.destroy()
          reject(new Error("timeout"))
        })
      })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`Port ${port} not reachable after ${timeoutMs}ms`)
}

const duckdbAvailable = isDuckDBAvailable()
const dockerAvailable = isDockerAvailable()

// ---------------------------------------------------------------------------
// DuckDB E2E
// ---------------------------------------------------------------------------

describe("DuckDB Driver E2E", () => {
  let connector: Connector
  // duckdbReady is set to true only after the driver successfully connects.
  // isDuckDBAvailable() may return true even when the native binding is
  // broken (e.g., node-pre-gyp binding not built for this environment).
  // This flag is the authoritative signal for whether tests should run.
  let duckdbReady = false

  // altimate_change start — retry DuckDB connection initialization to handle
  // transient native binding load failures when the full suite runs in parallel
  beforeAll(async () => {
    if (!duckdbAvailable) return
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const mod = await import("@altimateai/drivers/duckdb")
        connector = await mod.connect({ type: "duckdb" })
        await connector.connect()
        duckdbReady = true
        break
      } catch (e) {
        if (attempt < maxAttempts) {
          // Brief delay before retry to let concurrent native-binding loads settle
          await new Promise((r) => setTimeout(r, 100 * attempt))
        } else {
          console.warn(
            "DuckDB not available (native binding may be missing); skipping DuckDB tests:",
            (e as Error).message,
          )
        }
      }
    }
  })
  // altimate_change end

  afterAll(async () => {
    if (connector) await connector.close()
  })

  test.skipIf(!duckdbAvailable)("connect to in-memory database", () => {
    if (!duckdbReady) return
    expect(connector).toBeDefined()
  })

  test.skipIf(!duckdbAvailable)("execute SELECT query", async () => {
    if (!duckdbReady) return
    const result = await connector.execute("SELECT 1 AS num, 'hello' AS msg")
    expect(result.columns).toEqual(["num", "msg"])
    expect(result.rows).toEqual([[1, "hello"]])
    expect(result.row_count).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test.skipIf(!duckdbAvailable)(
    "execute CREATE TABLE + INSERT + SELECT",
    async () => {
      if (!duckdbReady) return
      await connector.execute(
        "CREATE TABLE test_duck (id INTEGER, name VARCHAR)",
      )
      await connector.execute(
        "INSERT INTO test_duck VALUES (1, 'alice'), (2, 'bob'), (3, 'charlie')",
      )
      const result = await connector.execute(
        "SELECT * FROM test_duck ORDER BY id",
      )
      expect(result.columns).toEqual(["id", "name"])
      expect(result.rows).toEqual([
        [1, "alice"],
        [2, "bob"],
        [3, "charlie"],
      ])
      expect(result.row_count).toBe(3)
      expect(result.truncated).toBe(false)
    },
  )

  test.skipIf(!duckdbAvailable)(
    "execute with LIMIT truncation",
    async () => {
      if (!duckdbReady) return
      // Insert more rows
      await connector.execute(
        "CREATE TABLE test_limit (val INTEGER)",
      )
      for (let i = 0; i < 10; i++) {
        await connector.execute(`INSERT INTO test_limit VALUES (${i})`)
      }
      const result = await connector.execute(
        "SELECT * FROM test_limit ORDER BY val",
        5,
      )
      expect(result.row_count).toBe(5)
      expect(result.truncated).toBe(true)
    },
  )

  test.skipIf(!duckdbAvailable)(
    "does not add LIMIT when already present",
    async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "SELECT * FROM test_limit ORDER BY val LIMIT 3",
      )
      expect(result.row_count).toBe(3)
      expect(result.truncated).toBe(false)
    },
  )

  test.skipIf(!duckdbAvailable)(
    "listSchemas returns main schema",
    async () => {
      if (!duckdbReady) return
      const schemas = await connector.listSchemas()
      expect(schemas).toContain("main")
    },
  )

  test.skipIf(!duckdbAvailable)(
    "listTables returns created tables",
    async () => {
      if (!duckdbReady) return
      const tables = await connector.listTables("main")
      const names = tables.map((t) => t.name)
      expect(names).toContain("test_duck")
      expect(names).toContain("test_limit")
      for (const t of tables) {
        expect(t.type).toBe("table")
      }
    },
  )

  test.skipIf(!duckdbAvailable)(
    "describeTable returns column metadata",
    async () => {
      if (!duckdbReady) return
      const columns = await connector.describeTable("main", "test_duck")
      expect(columns).toEqual([
        { name: "id", data_type: "INTEGER", nullable: true },
        { name: "name", data_type: "VARCHAR", nullable: true },
      ])
    },
  )

  test.skipIf(!duckdbAvailable)(
    "handles invalid SQL gracefully",
    async () => {
      if (!duckdbReady) return
      await expect(
        connector.execute("SELECT * FROM nonexistent_table_xyz"),
      ).rejects.toThrow()
    },
  )

  test.skipIf(!duckdbAvailable)(
    "handles non-SELECT queries (CREATE, INSERT, UPDATE, DELETE)",
    async () => {
      if (!duckdbReady) return
      await connector.execute(
        "CREATE TABLE test_nonselect (id INTEGER, val TEXT)",
      )
      const insertResult = await connector.execute(
        "INSERT INTO test_nonselect VALUES (1, 'a')",
      )
      // DuckDB returns empty result for non-SELECT
      expect(insertResult.row_count).toBeGreaterThanOrEqual(0)

      await connector.execute(
        "UPDATE test_nonselect SET val = 'b' WHERE id = 1",
      )
      const result = await connector.execute("SELECT * FROM test_nonselect")
      expect(result.rows[0]).toEqual([1, "b"])

      await connector.execute("DELETE FROM test_nonselect WHERE id = 1")
      const afterDelete = await connector.execute(
        "SELECT * FROM test_nonselect",
      )
      expect(afterDelete.row_count).toBe(0)
    },
  )

  test.skipIf(!duckdbAvailable)(
    "close() cleans up resources",
    async () => {
      if (!duckdbReady) return
      const mod = await import("@altimateai/drivers/duckdb")
      const tmp = await mod.connect({ type: "duckdb" })
      await tmp.connect()
      const result = await tmp.execute("SELECT 42 AS answer")
      expect(result.rows[0][0]).toBe(42)
      await tmp.close()
      // After close, executing should fail
      await expect(tmp.execute("SELECT 1")).rejects.toThrow()
    },
  )

  test.skipIf(!duckdbAvailable)(
    "connect to file-based database",
    async () => {
      if (!duckdbReady) return
      const tmpDir = mkdtempSync(join(tmpdir(), "duckdb-test-"))
      const dbFile = join(tmpDir, "test.duckdb")
      try {
        const mod = await import("@altimateai/drivers/duckdb")
        const fileConn = await mod.connect({ type: "duckdb", path: dbFile })
        await fileConn.connect()

        await fileConn.execute("CREATE TABLE persist (x INT)")
        await fileConn.execute("INSERT INTO persist VALUES (99)")
        await fileConn.close()

        // Reopen and verify data persisted
        const fileConn2 = await mod.connect({ type: "duckdb", path: dbFile })
        await fileConn2.connect()
        const result = await fileConn2.execute("SELECT * FROM persist")
        expect(result.rows[0][0]).toBe(99)
        await fileConn2.close()
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(!duckdbAvailable)(
    "multiple concurrent queries",
    async () => {
      if (!duckdbReady) return
      const results = await Promise.all([
        connector.execute("SELECT 1 AS v"),
        connector.execute("SELECT 2 AS v"),
        connector.execute("SELECT 3 AS v"),
      ])
      expect(results.map((r) => r.rows[0][0])).toEqual([1, 2, 3])
    },
  )

  test.skipIf(!duckdbAvailable)(
    "WITH (CTE) query works with auto-limit",
    async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "WITH cte AS (SELECT 1 AS x UNION ALL SELECT 2) SELECT * FROM cte ORDER BY x",
      )
      expect(result.rows).toEqual([[1], [2]])
      expect(result.truncated).toBe(false)
    },
  )

  // -------------------------------------------------------------------------
  // Bind Parameters
  // -------------------------------------------------------------------------
  describe("Bind Parameters", () => {
    beforeAll(async () => {
      if (!duckdbReady || !connector) return
      await connector.execute(`
        CREATE TABLE bind_test (
          id INTEGER,
          name VARCHAR,
          score DOUBLE,
          active BOOLEAN,
          created_at TIMESTAMP
        )
      `)
      await connector.execute(`
        INSERT INTO bind_test VALUES
          (1, 'alice', 9.5, true, '2024-01-01 10:00:00'),
          (2, 'bob',   7.2, false, '2024-06-15 12:30:00'),
          (3, 'carol', 8.8, true, '2024-12-31 23:59:59')
      `)
    })

    afterAll(async () => {
      if (!connector) return
      try { await connector.execute("DROP TABLE IF EXISTS bind_test") } catch {}
    })

    test.skipIf(!duckdbAvailable)("binds a single string parameter", async () => {
      if (!duckdbReady) return
      const result = await connector.execute("SELECT name FROM bind_test WHERE name = ?", undefined, ["alice"])
      expect(result.columns).toEqual(["name"])
      expect(result.rows).toEqual([["alice"]])
    })

    test.skipIf(!duckdbAvailable)("binds a single integer parameter", async () => {
      if (!duckdbReady) return
      const result = await connector.execute("SELECT id, name FROM bind_test WHERE id = ?", undefined, [2])
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toEqual([2, "bob"])
    })

    test.skipIf(!duckdbAvailable)("binds multiple parameters", async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "SELECT name FROM bind_test WHERE id >= ? AND id <= ?",
        undefined,
        [1, 2],
      )
      expect(result.rows).toHaveLength(2)
      const names = result.rows.map((r) => r[0])
      expect(names).toContain("alice")
      expect(names).toContain("bob")
    })

    test.skipIf(!duckdbAvailable)("binds a boolean parameter", async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "SELECT name FROM bind_test WHERE active = ? ORDER BY name",
        undefined,
        [true],
      )
      expect(result.rows).toHaveLength(2)
      expect(result.rows[0][0]).toBe("alice")
      expect(result.rows[1][0]).toBe("carol")
    })

    test.skipIf(!duckdbAvailable)("binds a float parameter", async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "SELECT name FROM bind_test WHERE score > ? ORDER BY score",
        undefined,
        [9.0],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][0]).toBe("alice")
    })

    test.skipIf(!duckdbAvailable)("returns no rows when bind value matches nothing", async () => {
      if (!duckdbReady) return
      const result = await connector.execute("SELECT * FROM bind_test WHERE name = ?", undefined, ["nobody"])
      expect(result.rows).toHaveLength(0)
      expect(result.row_count).toBe(0)
    })

    test.skipIf(!duckdbAvailable)("empty binds array behaves same as no binds", async () => {
      if (!duckdbReady) return
      const withEmpty = await connector.execute("SELECT COUNT(*) AS n FROM bind_test", undefined, [])
      const withNone = await connector.execute("SELECT COUNT(*) AS n FROM bind_test")
      expect(withEmpty.rows[0][0]).toBe(withNone.rows[0][0])
    })

    test.skipIf(!duckdbAvailable)("binds work alongside auto-LIMIT truncation", async () => {
      if (!duckdbReady) return
      await connector.execute("CREATE TEMP TABLE many_rows AS SELECT range AS id FROM range(0, 200)")
      const result = await connector.execute("SELECT id FROM many_rows WHERE id >= ?", 100, [0])
      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(100)
      await connector.execute("DROP TABLE IF EXISTS many_rows")
    })

    test.skipIf(!duckdbAvailable)("prevents SQL injection via binding", async () => {
      if (!duckdbReady) return
      const result = await connector.execute(
        "SELECT name FROM bind_test WHERE name = ?",
        undefined,
        ["' OR '1'='1"],
      )
      expect(result.rows).toHaveLength(0)
    })

    test.skipIf(!duckdbAvailable)("binds a NULL parameter", async () => {
      if (!duckdbReady) return
      await connector.execute("CREATE TEMP TABLE null_test (val VARCHAR)")
      await connector.execute("INSERT INTO null_test VALUES (NULL), ('hello')")
      const result = await connector.execute(
        "SELECT val FROM null_test WHERE val IS NOT DISTINCT FROM ?",
        undefined,
        [null],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0][0]).toBeNull()
      await connector.execute("DROP TABLE IF EXISTS null_test")
    })

    test.skipIf(!duckdbAvailable)("scalar bind — SELECT ? returns the bound value", async () => {
      if (!duckdbReady) return
      const result = await connector.execute("SELECT ? AS val", undefined, [42])
      expect(result.columns).toEqual(["val"])
      expect(result.rows[0][0]).toBe(42)
    })
  })
})

// ---------------------------------------------------------------------------
// SQLite E2E
// ---------------------------------------------------------------------------

describe("SQLite Driver E2E", () => {
  let connector: Connector
  let tmpDir: string

  beforeAll(async () => {
    // bun:sqlite is always available — no runtime check needed
    tmpDir = mkdtempSync(join(tmpdir(), "sqlite-test-"))
    const dbFile = join(tmpDir, "test.sqlite")
    const mod = await import("@altimateai/drivers/sqlite")
    connector = await mod.connect({ type: "sqlite", path: dbFile })
    await connector.connect()
  })

  afterAll(async () => {
    if (connector) await connector.close()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  test("connect to file database", () => {
    expect(connector).toBeDefined()
  })

  test("execute SELECT query", async () => {
    const result = await connector.execute("SELECT 1 AS num, 'hello' AS msg")
    expect(result.columns).toEqual(["num", "msg"])
    expect(result.rows).toEqual([[1, "hello"]])
    expect(result.row_count).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test(
    "execute DDL + DML queries",
    async () => {
      // CREATE
      const createResult = await connector.execute(
        "CREATE TABLE test_sqlite (id INTEGER PRIMARY KEY, name TEXT, score REAL)",
      )
      expect(createResult.columns).toEqual(["changes", "lastInsertRowid"])

      // INSERT
      const insertResult = await connector.execute(
        "INSERT INTO test_sqlite (name, score) VALUES ('alice', 95.5)",
      )
      expect(insertResult.rows[0][0]).toBe(1) // 1 change

      await connector.execute(
        "INSERT INTO test_sqlite (name, score) VALUES ('bob', 87.0)",
      )
      await connector.execute(
        "INSERT INTO test_sqlite (name, score) VALUES ('charlie', 92.3)",
      )

      // SELECT
      const result = await connector.execute(
        "SELECT name, score FROM test_sqlite ORDER BY name",
      )
      expect(result.columns).toEqual(["name", "score"])
      expect(result.rows).toEqual([
        ["alice", 95.5],
        ["bob", 87.0],
        ["charlie", 92.3],
      ])

      // UPDATE
      await connector.execute(
        "UPDATE test_sqlite SET score = 99.9 WHERE name = 'alice'",
      )
      const updated = await connector.execute(
        "SELECT score FROM test_sqlite WHERE name = 'alice'",
      )
      expect(updated.rows[0][0]).toBe(99.9)

      // DELETE
      const deleteResult = await connector.execute(
        "DELETE FROM test_sqlite WHERE name = 'charlie'",
      )
      expect(deleteResult.rows[0][0]).toBe(1) // 1 change
    },
  )

  test(
    "listSchemas (SQLite has only 'main')",
    async () => {
      const schemas = await connector.listSchemas()
      expect(schemas).toEqual(["main"])
    },
  )

  test("listTables", async () => {
    const tables = await connector.listTables("main")
    const names = tables.map((t) => t.name)
    expect(names).toContain("test_sqlite")
    const entry = tables.find((t) => t.name === "test_sqlite")
    expect(entry?.type).toBe("table")
  })

  test("describeTable", async () => {
    const columns = await connector.describeTable("main", "test_sqlite")
    expect(columns).toEqual([
      // INTEGER PRIMARY KEY is a rowid alias — SQLite reports notnull=0 for it
      { name: "id", data_type: "INTEGER", nullable: true },
      { name: "name", data_type: "TEXT", nullable: true },
      { name: "score", data_type: "REAL", nullable: true },
    ])
  })

  test(
    "handles read vs write query detection",
    async () => {
      // SELECT-like returns data rows
      const selectResult = await connector.execute("SELECT 42 AS answer")
      expect(selectResult.columns).toEqual(["answer"])
      expect(selectResult.rows).toEqual([[42]])

      // PRAGMA returns data rows (treated as SELECT-like)
      const pragmaResult = await connector.execute("PRAGMA table_list")
      expect(pragmaResult.row_count).toBeGreaterThan(0)

      // INSERT returns changes/lastInsertRowid
      await connector.execute(
        "INSERT INTO test_sqlite (name, score) VALUES ('test_rw', 1.0)",
      )
      const writeResult = await connector.execute(
        "DELETE FROM test_sqlite WHERE name = 'test_rw'",
      )
      expect(writeResult.columns).toEqual(["changes", "lastInsertRowid"])
    },
  )

  test(
    "LIMIT truncation works",
    async () => {
      // Insert enough rows
      await connector.execute(
        "CREATE TABLE test_limit_sq (v INTEGER)",
      )
      for (let i = 0; i < 10; i++) {
        await connector.execute(`INSERT INTO test_limit_sq VALUES (${i})`)
      }
      const result = await connector.execute(
        "SELECT * FROM test_limit_sq ORDER BY v",
        5,
      )
      expect(result.row_count).toBe(5)
      expect(result.truncated).toBe(true)
    },
  )

  test(
    "handles invalid SQL gracefully",
    async () => {
      expect(() => connector.execute("INVALID SQL STATEMENT")).toThrow()
    },
  )

  test(
    "close and cleanup",
    async () => {
      const tmpDir2 = mkdtempSync(join(tmpdir(), "sqlite-close-test-"))
      const dbFile = join(tmpDir2, "close.sqlite")
      try {
        const mod = await import("@altimateai/drivers/sqlite")
        const conn = await mod.connect({ type: "sqlite", path: dbFile })
        await conn.connect()
        await conn.execute("SELECT 1")
        await conn.close()
        // After close, operations should fail
        await expect(conn.execute("SELECT 1")).rejects.toThrow()
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true })
      }
    },
  )

  test(
    "view is listed with correct type",
    async () => {
      await connector.execute(
        "CREATE VIEW test_view AS SELECT * FROM test_sqlite",
      )
      const tables = await connector.listTables("main")
      const view = tables.find((t) => t.name === "test_view")
      expect(view).toBeDefined()
      expect(view?.type).toBe("view")
    },
  )
})

// ---------------------------------------------------------------------------
// PostgreSQL E2E (Docker-based)
// ---------------------------------------------------------------------------

const PG_PORT = Number(process.env.TEST_PG_PORT) || 15432
const PG_PASSWORD = process.env.TEST_PG_PASSWORD || "testpass123"
const PG_HOST = process.env.TEST_PG_HOST || "127.0.0.1"
// If TEST_PG_HOST is set, assume CI services are pre-started (no Docker needed)
const PG_USE_CI_SERVICE = !!process.env.TEST_PG_HOST
const PG_CONTAINER = "altimate-test-pg"

describe("PostgreSQL Driver E2E", () => {
  let connector: Connector
  let pgStarted = false

  beforeAll(async () => {
    if (PG_USE_CI_SERVICE) {
      // CI: services are pre-started, just connect
      pgStarted = true
    } else if (dockerAvailable) {
      // Local: start a Docker container
      try {
        execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: "ignore" })
      } catch {}
      try {
        execSync(
          `docker run -d --name ${PG_CONTAINER} -p ${PG_PORT}:5432 -e POSTGRES_PASSWORD=${PG_PASSWORD} postgres:16-alpine`,
          { stdio: "ignore", timeout: 30000 },
        )
        await waitForPort(PG_PORT, 30000)
        await new Promise((r) => setTimeout(r, 2000))
        pgStarted = true
      } catch (e) {
        console.error("Failed to start PostgreSQL container:", e)
        return
      }
    } else {
      return // No Docker, no CI service — skip
    }

    const mod = await import("@altimateai/drivers/postgres")
    connector = await mod.connect({
      type: "postgres",
      host: PG_HOST,
      port: PG_PORT,
      user: "postgres",
      password: PG_PASSWORD,
      database: "postgres",
    })
    await connector.connect()
  }, 60000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
    try {
      execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: "ignore" })
    } catch {}
  })

  const skipUnless = !dockerAvailable

  test.skipIf(skipUnless)(
    "connect with host/port/user/password",
    async () => {
      if (!pgStarted) return
      expect(connector).toBeDefined()
      const result = await connector.execute("SELECT 1 AS check_val")
      expect(result.rows[0][0]).toBe(1)
    },
  )

  test.skipIf(skipUnless)(
    "connect with connection_string",
    async () => {
      if (!pgStarted) return
      const mod = await import("@altimateai/drivers/postgres")
      const conn = await mod.connect({
        type: "postgres",
        connection_string: `postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/postgres`,
      })
      await conn.connect()
      const result = await conn.execute("SELECT 'connected' AS status")
      expect(result.rows[0][0]).toBe("connected")
      await conn.close()
    },
  )

  test.skipIf(skipUnless)("execute SELECT query", async () => {
    if (!pgStarted) return
    const result = await connector.execute(
      "SELECT 42 AS num, 'hello'::text AS msg",
    )
    expect(result.columns).toEqual(["num", "msg"])
    expect(result.rows).toEqual([[42, "hello"]])
    expect(result.row_count).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test.skipIf(skipUnless)("execute DDL + DML", async () => {
    if (!pgStarted) return
    await connector.execute(
      "CREATE TABLE test_pg (id SERIAL PRIMARY KEY, name TEXT NOT NULL, score NUMERIC(5,2))",
    )
    await connector.execute(
      "INSERT INTO test_pg (name, score) VALUES ('alice', 95.50), ('bob', 87.00), ('charlie', 92.30)",
    )
    const result = await connector.execute(
      "SELECT name, score FROM test_pg ORDER BY name",
    )
    expect(result.columns).toEqual(["name", "score"])
    expect(result.row_count).toBe(3)
    expect(result.rows[0][0]).toBe("alice")

    // UPDATE
    await connector.execute(
      "UPDATE test_pg SET score = 99.99 WHERE name = 'alice'",
    )
    const updated = await connector.execute(
      "SELECT score FROM test_pg WHERE name = 'alice'",
    )
    expect(Number(updated.rows[0][0])).toBeCloseTo(99.99, 1)

    // DELETE
    await connector.execute("DELETE FROM test_pg WHERE name = 'charlie'")
    const afterDelete = await connector.execute(
      "SELECT count(*) AS cnt FROM test_pg",
    )
    expect(Number(afterDelete.rows[0][0])).toBe(2)
  })

  test.skipIf(skipUnless)(
    "listSchemas excludes system schemas",
    async () => {
      if (!pgStarted) return
      const schemas = await connector.listSchemas()
      expect(schemas).toContain("public")
      expect(schemas).not.toContain("information_schema")
      expect(schemas).not.toContain("pg_catalog")
      expect(schemas).not.toContain("pg_toast")
    },
  )

  test.skipIf(skipUnless)(
    "listTables in public schema",
    async () => {
      if (!pgStarted) return
      const tables = await connector.listTables("public")
      const names = tables.map((t) => t.name)
      expect(names).toContain("test_pg")
      const entry = tables.find((t) => t.name === "test_pg")
      expect(entry?.type).toBe("table")
    },
  )

  test.skipIf(skipUnless)(
    "describeTable returns correct types",
    async () => {
      if (!pgStarted) return
      const columns = await connector.describeTable("public", "test_pg")
      expect(columns.length).toBe(3)

      const idCol = columns.find((c) => c.name === "id")
      expect(idCol?.data_type).toBe("integer")
      expect(idCol?.nullable).toBe(false)

      const nameCol = columns.find((c) => c.name === "name")
      expect(nameCol?.data_type).toBe("text")
      expect(nameCol?.nullable).toBe(false)

      const scoreCol = columns.find((c) => c.name === "score")
      expect(scoreCol?.data_type).toBe("numeric")
      expect(scoreCol?.nullable).toBe(true)
    },
  )

  test.skipIf(skipUnless)(
    "LIMIT truncation",
    async () => {
      if (!pgStarted) return
      await connector.execute("CREATE TABLE test_pg_limit (v INTEGER)")
      await connector.execute(
        "INSERT INTO test_pg_limit SELECT generate_series(1, 20)",
      )
      const result = await connector.execute(
        "SELECT * FROM test_pg_limit ORDER BY v",
        5,
      )
      expect(result.row_count).toBe(5)
      expect(result.truncated).toBe(true)
    },
  )

  test.skipIf(skipUnless)(
    "handles invalid SQL gracefully",
    async () => {
      if (!pgStarted) return
      await expect(
        connector.execute("SELECT * FROM nonexistent_table_xyz"),
      ).rejects.toThrow()
    },
  )

  test.skipIf(skipUnless)(
    "statement timeout works",
    async () => {
      if (!pgStarted) return
      const mod = await import("@altimateai/drivers/postgres")
      const conn = await mod.connect({
        type: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        user: "postgres",
        password: PG_PASSWORD,
        database: "postgres",
        statement_timeout: 100, // 100ms
      })
      await conn.connect()
      // pg_sleep(10) should be killed by the 100ms timeout
      await expect(
        conn.execute("SELECT pg_sleep(10)"),
      ).rejects.toThrow()
      await conn.close()
    },
  )

  test.skipIf(skipUnless)(
    "connection pool reuse",
    async () => {
      if (!pgStarted) return
      // Multiple sequential queries reuse pool connections
      const results: ConnectorResult[] = []
      for (let i = 0; i < 5; i++) {
        results.push(await connector.execute(`SELECT ${i} AS v`))
      }
      expect(results.map((r) => r.rows[0][0])).toEqual([0, 1, 2, 3, 4])

      // Concurrent queries also work
      const concurrent = await Promise.all([
        connector.execute("SELECT 'a' AS v"),
        connector.execute("SELECT 'b' AS v"),
        connector.execute("SELECT 'c' AS v"),
      ])
      expect(concurrent.map((r) => r.rows[0][0]).sort()).toEqual([
        "a",
        "b",
        "c",
      ])
    },
  )

  test.skipIf(skipUnless)(
    "handles schema with special characters",
    async () => {
      if (!pgStarted) return
      // Create a schema with underscore (common in multi-tenant setups)
      await connector.execute('CREATE SCHEMA IF NOT EXISTS "test_schema_1"')
      await connector.execute(
        'CREATE TABLE "test_schema_1".test_tbl (id INT)',
      )

      const schemas = await connector.listSchemas()
      expect(schemas).toContain("test_schema_1")

      const tables = await connector.listTables("test_schema_1")
      expect(tables.map((t) => t.name)).toContain("test_tbl")

      const columns = await connector.describeTable(
        "test_schema_1",
        "test_tbl",
      )
      expect(columns[0].name).toBe("id")

      // Cleanup
      await connector.execute("DROP SCHEMA test_schema_1 CASCADE")
    },
  )

  test.skipIf(skipUnless)(
    "view is listed correctly",
    async () => {
      if (!pgStarted) return
      await connector.execute(
        "CREATE VIEW test_pg_view AS SELECT * FROM test_pg",
      )
      const tables = await connector.listTables("public")
      const view = tables.find((t) => t.name === "test_pg_view")
      expect(view).toBeDefined()
      expect(view?.type).toBe("view")

      // Cleanup
      await connector.execute("DROP VIEW test_pg_view")
    },
  )

  test.skipIf(skipUnless)(
    "WITH (CTE) query works",
    async () => {
      if (!pgStarted) return
      const result = await connector.execute(
        "WITH cte AS (SELECT 1 AS x UNION ALL SELECT 2) SELECT * FROM cte ORDER BY x",
      )
      expect(result.rows).toEqual([[1], [2]])
      expect(result.truncated).toBe(false)
    },
  )
})

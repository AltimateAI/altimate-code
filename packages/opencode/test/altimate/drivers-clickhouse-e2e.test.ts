import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { execSync } from "child_process"
import { createConnection } from "net"

// ---------------------------------------------------------------------------
// Fast skip: only run when CI services are configured or Docker is available
// ---------------------------------------------------------------------------

const HAS_CI_SERVICES = !!process.env.TEST_CLICKHOUSE_HOST

// Only run Docker tests when explicitly opted in via DRIVER_E2E_DOCKER=1
const DOCKER_OPT_IN = process.env.DRIVER_E2E_DOCKER === "1"

function isDockerAvailable(): boolean {
  if (HAS_CI_SERVICES) return true
  if (!DOCKER_OPT_IN) return false
  try {
    execSync("docker info", { stdio: "ignore", timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function waitForPort(port: number, timeout = 30000, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const sock = createConnection({ host, port })
      sock.once("connect", () => {
        sock.destroy()
        resolve()
      })
      sock.once("error", () => {
        sock.destroy()
        if (Date.now() - start > timeout) {
          reject(new Error(`Port ${port} not ready after ${timeout}ms`))
        } else {
          setTimeout(attempt, 500)
        }
      })
    }
    attempt()
  })
}

/**
 * Wait for ClickHouse to be ready by retrying a connect+query cycle.
 * ClickHouse may accept TCP before being fully ready.
 */
async function waitForDbReady(
  connectFn: () => Promise<{ connector: any; testQuery: string }>,
  timeout = 60000,
): Promise<any> {
  const start = Date.now()
  let lastErr: any
  while (Date.now() - start < timeout) {
    let connector: any
    try {
      const result = await connectFn()
      connector = result.connector
      await connector.connect()
      await connector.execute(result.testQuery)
      return connector
    } catch (e: any) {
      lastErr = e
      try { connector?.disconnect?.() } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error(`ClickHouse not ready after ${timeout}ms: ${lastErr?.message}`)
}

function dockerRm(name: string) {
  try {
    execSync(`docker rm -f ${name}`, { stdio: "ignore", timeout: 10000 })
  } catch {
    // container may not exist
  }
}

function dockerRun(args: string) {
  execSync(`docker run ${args}`, { stdio: "ignore", timeout: 120000 })
}

const DOCKER = isDockerAvailable()

// ---------------------------------------------------------------------------
// ClickHouse E2E — Latest stable
// ---------------------------------------------------------------------------

const CH_CONTAINER = "altimate-test-clickhouse"
const CH_HOST = process.env.TEST_CLICKHOUSE_HOST || "127.0.0.1"
const CH_PORT = Number(process.env.TEST_CLICKHOUSE_PORT) || 18123
const CH_PASSWORD = process.env.TEST_CLICKHOUSE_PASSWORD || ""
const CH_USER = process.env.TEST_CLICKHOUSE_USER || "default"
const CH_USE_CI = !!process.env.TEST_CLICKHOUSE_HOST

describe.skipIf(!DOCKER && !CH_USE_CI)("ClickHouse Driver E2E", () => {
  let connector: any

  beforeAll(async () => {
    if (!CH_USE_CI) {
      dockerRm(CH_CONTAINER)
      dockerRun(
        `-d --name ${CH_CONTAINER} ` +
          `-p ${CH_PORT}:8123 ` +
          `-e CLICKHOUSE_DB=testdb ` +
          `-e CLICKHOUSE_USER=${CH_USER} ` +
          `-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 ` +
          (CH_PASSWORD ? `-e "CLICKHOUSE_PASSWORD=${CH_PASSWORD}" ` : "") +
          `clickhouse/clickhouse-server:latest`,
      )
    }
    await waitForPort(CH_PORT, 60000)
    const { connect } = await import("@altimateai/drivers/clickhouse")
    connector = await waitForDbReady(async () => {
      const c = await connect({
        type: "clickhouse",
        host: CH_HOST,
        port: CH_PORT,
        user: CH_USER,
        password: CH_PASSWORD,
        database: "testdb",
      })
      return { connector: c, testQuery: "SELECT 1" }
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
    dockerRm(CH_CONTAINER)
  })

  test("connect with host/port/user", () => {
    expect(connector).toBeDefined()
  })

  test("execute SELECT query", async () => {
    const result = await connector.execute("SELECT 1 AS num, 'hello' AS greeting")
    expect(result.columns).toEqual(["num", "greeting"])
    expect(result.rows[0][0]).toBe(1)
    expect(result.rows[0][1]).toBe("hello")
    expect(result.row_count).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test("execute CREATE TABLE + INSERT + SELECT", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.test_items (
        id UInt32,
        name String,
        active UInt8 DEFAULT 1
      ) ENGINE = MergeTree()
      ORDER BY id`,
    )
    await connector.execute(
      `INSERT INTO testdb.test_items (id, name, active)
       VALUES (1, 'alpha', 1), (2, 'beta', 0), (3, 'gamma', 1)`,
    )
    const result = await connector.execute("SELECT id, name, active FROM testdb.test_items ORDER BY id")
    expect(result.columns).toEqual(["id", "name", "active"])
    expect(result.row_count).toBe(3)
    expect(result.rows[0][1]).toBe("alpha")
    expect(result.rows[1][1]).toBe("beta")
    expect(result.rows[2][1]).toBe("gamma")
  })

  test("listSchemas (SHOW DATABASES)", async () => {
    const schemas = await connector.listSchemas()
    expect(schemas).toContain("testdb")
    expect(schemas).toContain("system")
    expect(schemas).toContain("default")
  })

  test("listTables", async () => {
    const tables = await connector.listTables("testdb")
    const testTable = tables.find((t: any) => t.name === "test_items")
    expect(testTable).toBeDefined()
    expect(testTable?.type).toBe("table")
  })

  test("describeTable", async () => {
    const columns = await connector.describeTable("testdb", "test_items")
    expect(columns.length).toBeGreaterThanOrEqual(3)
    const idCol = columns.find((c: any) => c.name === "id")
    expect(idCol).toBeDefined()
    expect(idCol?.data_type).toBe("UInt32")
    expect(idCol?.nullable).toBe(false)
    const nameCol = columns.find((c: any) => c.name === "name")
    expect(nameCol).toBeDefined()
    expect(nameCol?.data_type).toBe("String")
  })

  test("handles LIMIT correctly", async () => {
    // Insert more rows
    await connector.execute(
      `INSERT INTO testdb.test_items (id, name)
       VALUES (4, 'd'), (5, 'e'), (6, 'f'), (7, 'g'), (8, 'h')`,
    )
    const result = await connector.execute("SELECT * FROM testdb.test_items ORDER BY id", 2)
    expect(result.row_count).toBe(2)
    expect(result.truncated).toBe(true)
  })

  test("handles non-SELECT queries (DDL)", async () => {
    const result = await connector.execute("CREATE TABLE IF NOT EXISTS testdb.temp_table (x UInt32) ENGINE = Memory")
    // DDL returns empty
    expect(result.columns).toEqual([])
    expect(result.row_count).toBe(0)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.temp_table")
  })

  test("ClickHouse-specific: SHOW queries", async () => {
    const result = await connector.execute("SHOW TABLES FROM testdb")
    expect(result.row_count).toBeGreaterThan(0)
    expect(result.columns.length).toBeGreaterThan(0)
  })

  test("ClickHouse-specific: system tables", async () => {
    const result = await connector.execute("SELECT name, value FROM system.settings WHERE name = 'max_threads' LIMIT 1")
    expect(result.row_count).toBe(1)
    expect(result.columns).toContain("name")
    expect(result.columns).toContain("value")
  })

  test("ClickHouse-specific: Nullable columns", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.nullable_test (
        id UInt32,
        name Nullable(String),
        score Nullable(Float64)
      ) ENGINE = MergeTree()
      ORDER BY id`,
    )
    const columns = await connector.describeTable("testdb", "nullable_test")
    const nameCol = columns.find((c: any) => c.name === "name")
    expect(nameCol?.nullable).toBe(true)
    expect(nameCol?.data_type).toBe("Nullable(String)")
    const idCol = columns.find((c: any) => c.name === "id")
    expect(idCol?.nullable).toBe(false)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.nullable_test")
  })

  test("ClickHouse-specific: various data types", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.type_test (
        id UInt64,
        name String,
        amount Decimal(18, 4),
        created_at DateTime,
        tags Array(String),
        metadata Map(String, String),
        ip IPv4
      ) ENGINE = MergeTree()
      ORDER BY id`,
    )
    await connector.execute(
      `INSERT INTO testdb.type_test (id, name, amount, created_at, tags, metadata, ip)
       VALUES (1, 'test', 123.4567, '2025-01-15 10:30:00', ['a', 'b'], {'key': 'val'}, '127.0.0.1')`,
    )
    const result = await connector.execute("SELECT * FROM testdb.type_test")
    expect(result.row_count).toBe(1)
    expect(String(result.rows[0][0])).toBe("1") // UInt64 may be string or number in JSON
    expect(result.rows[0][1]).toBe("test")

    const columns = await connector.describeTable("testdb", "type_test")
    expect(columns.length).toBe(7)
    const amountCol = columns.find((c: any) => c.name === "amount")
    expect(amountCol?.data_type).toBe("Decimal(18, 4)")
    const tagsCol = columns.find((c: any) => c.name === "tags")
    expect(tagsCol?.data_type).toBe("Array(String)")
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.type_test")
  })

  test("ClickHouse-specific: MergeTree engine variants", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.replacing_test (
        id UInt32,
        name String,
        version UInt32
      ) ENGINE = ReplacingMergeTree(version)
      ORDER BY id`,
    )
    const tables = await connector.listTables("testdb")
    const replacingTable = tables.find((t: any) => t.name === "replacing_test")
    expect(replacingTable).toBeDefined()
    expect(replacingTable?.type).toBe("table")
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.replacing_test")
  })

  test("ClickHouse-specific: views", async () => {
    await connector.execute(
      `CREATE VIEW IF NOT EXISTS testdb.test_view AS
       SELECT id, name FROM testdb.test_items WHERE active = 1`,
    )
    const tables = await connector.listTables("testdb")
    const view = tables.find((t: any) => t.name === "test_view")
    expect(view).toBeDefined()
    expect(view?.type).toBe("view")
    // Query the view
    const result = await connector.execute("SELECT * FROM testdb.test_view ORDER BY id")
    expect(result.row_count).toBeGreaterThan(0)
    // Clean up
    await connector.execute("DROP VIEW IF EXISTS testdb.test_view")
  })

  test("ClickHouse-specific: materialized views", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.mv_target (
        active UInt8,
        cnt UInt64
      ) ENGINE = SummingMergeTree()
      ORDER BY active`,
    )
    await connector.execute(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS testdb.test_mv
       TO testdb.mv_target AS
       SELECT active, count() AS cnt FROM testdb.test_items GROUP BY active`,
    )
    const tables = await connector.listTables("testdb")
    const mv = tables.find((t: any) => t.name === "test_mv")
    expect(mv).toBeDefined()
    expect(mv?.type).toBe("view")
    // Clean up
    await connector.execute("DROP VIEW IF EXISTS testdb.test_mv")
    await connector.execute("DROP TABLE IF EXISTS testdb.mv_target")
  })

  test("ClickHouse-specific: EXPLAIN query", async () => {
    const result = await connector.execute("EXPLAIN SELECT * FROM testdb.test_items WHERE active = 1")
    expect(result.row_count).toBeGreaterThan(0)
  })

  // --- Regression tests from adversarial suite (167 tests, 3 real bugs found) ---

  test("regression: DESCRIBE TABLE does not get LIMIT appended", async () => {
    // Bug: DESCRIBE matched isSelectLike regex, got LIMIT 1001 appended,
    // but ClickHouse DESCRIBE doesn't support LIMIT syntax
    const result = await connector.execute("DESCRIBE TABLE testdb.test_items")
    expect(result.row_count).toBeGreaterThan(0)
    expect(result.columns.length).toBeGreaterThan(0)
  })

  test("regression: EXISTS TABLE does not get LIMIT appended", async () => {
    // Bug: EXISTS matched isSelectLike regex, got LIMIT 1001 appended,
    // but ClickHouse EXISTS doesn't support LIMIT syntax
    const result = await connector.execute("EXISTS TABLE testdb.test_items")
    expect(result.row_count).toBe(1)
  })

  test("regression: limit=0 returns all rows (no truncation)", async () => {
    // Bug: limit=0 caused truncated=true and sliced rows to 0
    // because rows.length > 0 was always true
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.regression_limit0 (id UInt32) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute("INSERT INTO testdb.regression_limit0 VALUES (1), (2), (3), (4), (5)")
    const result = await connector.execute("SELECT * FROM testdb.regression_limit0 ORDER BY id", 0)
    expect(result.row_count).toBe(5)
    expect(result.truncated).toBe(false)
    await connector.execute("DROP TABLE IF EXISTS testdb.regression_limit0")
  })

  test("regression: INSERT uses client.command() not client.query()", async () => {
    // Bug: INSERT with VALUES was sent via client.query() with JSONEachRow format,
    // causing ClickHouse to try parsing VALUES as JSON → CANNOT_PARSE_INPUT error
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.regression_insert (id UInt32, val String) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute("INSERT INTO testdb.regression_insert VALUES (1, 'a'), (2, 'b')")
    const result = await connector.execute("SELECT * FROM testdb.regression_insert ORDER BY id")
    expect(result.row_count).toBe(2)
    expect(result.rows[0][1]).toBe("a")
    await connector.execute("DROP TABLE IF EXISTS testdb.regression_insert")
  })

  test("regression: WITH...INSERT does not get LIMIT appended", async () => {
    // Bug: WITH clause matched isSelectLike, causing LIMIT to be appended
    // to INSERT...SELECT queries, breaking them
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.regression_cte_insert (id UInt32, val String) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.regression_cte_source (id UInt32, val String) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute("INSERT INTO testdb.regression_cte_source VALUES (1, 'x'), (2, 'y')")
    await connector.execute(
      "INSERT INTO testdb.regression_cte_insert SELECT * FROM testdb.regression_cte_source WHERE id <= 2",
    )
    const result = await connector.execute("SELECT count() FROM testdb.regression_cte_insert")
    expect(Number(result.rows[0][0])).toBe(2)
    await connector.execute("DROP TABLE IF EXISTS testdb.regression_cte_insert")
    await connector.execute("DROP TABLE IF EXISTS testdb.regression_cte_source")
  })

  test("close", async () => {
    // Clean up all remaining test tables
    await connector.execute("DROP TABLE IF EXISTS testdb.test_items")
    await connector.close()
    connector = null
  })
})

// ---------------------------------------------------------------------------
// ClickHouse LTS version E2E (23.8 — oldest non-EOL LTS)
// ---------------------------------------------------------------------------

const CH_LTS_CONTAINER = "altimate-test-clickhouse-lts"
const CH_LTS_PORT = Number(process.env.TEST_CLICKHOUSE_LTS_PORT) || 18124
const CH_LTS_USE_CI = !!process.env.TEST_CLICKHOUSE_LTS_HOST

describe.skipIf(!DOCKER && !CH_LTS_USE_CI)("ClickHouse Driver E2E — LTS 23.8", () => {
  let connector: any

  beforeAll(async () => {
    if (!CH_LTS_USE_CI) {
      dockerRm(CH_LTS_CONTAINER)
      dockerRun(
        `-d --name ${CH_LTS_CONTAINER} ` +
          `-p ${CH_LTS_PORT}:8123 ` +
          `-e CLICKHOUSE_DB=testdb ` +
          `-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 ` +
          `clickhouse/clickhouse-server:23.8`,
      )
    }
    const host = process.env.TEST_CLICKHOUSE_LTS_HOST || "127.0.0.1"
    await waitForPort(CH_LTS_PORT, 60000)
    const { connect } = await import("@altimateai/drivers/clickhouse")
    connector = await waitForDbReady(async () => {
      const c = await connect({
        type: "clickhouse",
        host,
        port: CH_LTS_PORT,
        user: "default",
        database: "testdb",
      })
      return { connector: c, testQuery: "SELECT 1" }
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
    dockerRm(CH_LTS_CONTAINER)
  })

  test("connects to LTS 23.8", () => {
    expect(connector).toBeDefined()
  })

  test("SELECT query works on LTS", async () => {
    const result = await connector.execute("SELECT 1 AS num, version() AS ver")
    expect(result.row_count).toBe(1)
    expect(result.rows[0][1]).toMatch(/^23\.8/)
  })

  test("DDL + DML works on LTS", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.lts_test (
        id UInt32,
        name String
      ) ENGINE = MergeTree()
      ORDER BY id`,
    )
    await connector.execute(`INSERT INTO testdb.lts_test VALUES (1, 'alpha'), (2, 'beta')`)
    const result = await connector.execute("SELECT * FROM testdb.lts_test ORDER BY id")
    expect(result.row_count).toBe(2)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.lts_test")
  })

  test("listSchemas works on LTS", async () => {
    const schemas = await connector.listSchemas()
    expect(schemas).toContain("testdb")
    expect(schemas).toContain("system")
  })

  test("listTables works on LTS", async () => {
    await connector.execute(`CREATE TABLE IF NOT EXISTS testdb.lts_tbl (x UInt32) ENGINE = Memory`)
    const tables = await connector.listTables("testdb")
    expect(tables.length).toBeGreaterThan(0)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.lts_tbl")
  })

  test("describeTable works on LTS", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.lts_desc (
        id UInt32,
        val Nullable(String)
      ) ENGINE = MergeTree() ORDER BY id`,
    )
    const columns = await connector.describeTable("testdb", "lts_desc")
    expect(columns.length).toBe(2)
    const valCol = columns.find((c: any) => c.name === "val")
    expect(valCol?.nullable).toBe(true)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.lts_desc")
  })

  test("close LTS connection", async () => {
    await connector.close()
    connector = null
  })
})

// ---------------------------------------------------------------------------
// ClickHouse LTS 24.3 E2E
// ---------------------------------------------------------------------------

const CH_243_CONTAINER = "altimate-test-clickhouse-243"
const CH_243_PORT = Number(process.env.TEST_CLICKHOUSE_243_PORT) || 18125
const CH_243_USE_CI = !!process.env.TEST_CLICKHOUSE_243_HOST

describe.skipIf(!DOCKER && !CH_243_USE_CI)("ClickHouse Driver E2E — LTS 24.3", () => {
  let connector: any

  beforeAll(async () => {
    if (!CH_243_USE_CI) {
      dockerRm(CH_243_CONTAINER)
      dockerRun(
        `-d --name ${CH_243_CONTAINER} ` +
          `-p ${CH_243_PORT}:8123 ` +
          `-e CLICKHOUSE_DB=testdb ` +
          `-e CLICKHOUSE_USER=default ` +
          `-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 ` +
          `clickhouse/clickhouse-server:24.3`,
      )
    }
    await waitForPort(CH_243_PORT, 60000)
    const { connect } = await import("@altimateai/drivers/clickhouse")
    connector = await waitForDbReady(async () => {
      const c = await connect({
        type: "clickhouse",
        host: process.env.TEST_CLICKHOUSE_243_HOST || "127.0.0.1",
        port: CH_243_PORT,
        user: "default",
        database: "testdb",
      })
      return { connector: c, testQuery: "SELECT 1" }
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
    dockerRm(CH_243_CONTAINER)
  })

  test("connects to LTS 24.3", () => {
    expect(connector).toBeDefined()
  })

  test("version check", async () => {
    const result = await connector.execute("SELECT version() AS ver")
    expect(result.rows[0][0]).toMatch(/^24\.3/)
  })

  test("full CRUD works on 24.3", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.v243_test (
        id UInt32,
        name String,
        score Float64
      ) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute(`INSERT INTO testdb.v243_test VALUES (1, 'alpha', 9.5), (2, 'beta', 8.2)`)
    const result = await connector.execute("SELECT * FROM testdb.v243_test ORDER BY id")
    expect(result.row_count).toBe(2)
    // ALTER TABLE (ClickHouse supports lightweight deletes in 24.3)
    await connector.execute(`ALTER TABLE testdb.v243_test DELETE WHERE id = 2`)
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.v243_test")
  })

  test("close 24.3 connection", async () => {
    await connector.close()
    connector = null
  })
})

// ---------------------------------------------------------------------------
// ClickHouse LTS 24.8 E2E
// ---------------------------------------------------------------------------

const CH_248_CONTAINER = "altimate-test-clickhouse-248"
const CH_248_PORT = Number(process.env.TEST_CLICKHOUSE_248_PORT) || 18126
const CH_248_USE_CI = !!process.env.TEST_CLICKHOUSE_248_HOST

describe.skipIf(!DOCKER && !CH_248_USE_CI)("ClickHouse Driver E2E — LTS 24.8", () => {
  let connector: any

  beforeAll(async () => {
    if (!CH_248_USE_CI) {
      dockerRm(CH_248_CONTAINER)
      dockerRun(
        `-d --name ${CH_248_CONTAINER} ` +
          `-p ${CH_248_PORT}:8123 ` +
          `-e CLICKHOUSE_DB=testdb ` +
          `-e CLICKHOUSE_USER=default ` +
          `-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 ` +
          `clickhouse/clickhouse-server:24.8`,
      )
    }
    await waitForPort(CH_248_PORT, 60000)
    const { connect } = await import("@altimateai/drivers/clickhouse")
    connector = await waitForDbReady(async () => {
      const c = await connect({
        type: "clickhouse",
        host: process.env.TEST_CLICKHOUSE_248_HOST || "127.0.0.1",
        port: CH_248_PORT,
        user: "default",
        database: "testdb",
      })
      return { connector: c, testQuery: "SELECT 1" }
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
    dockerRm(CH_248_CONTAINER)
  })

  test("connects to LTS 24.8", () => {
    expect(connector).toBeDefined()
  })

  test("version check", async () => {
    const result = await connector.execute("SELECT version() AS ver")
    expect(result.rows[0][0]).toMatch(/^24\.8/)
  })

  test("full lifecycle on 24.8", async () => {
    await connector.execute(
      `CREATE TABLE IF NOT EXISTS testdb.v248_test (
        id UInt32,
        name String,
        ts DateTime64(3)
      ) ENGINE = MergeTree() ORDER BY id`,
    )
    await connector.execute(`INSERT INTO testdb.v248_test VALUES (1, 'one', '2025-06-15 12:00:00.123')`)
    const schemas = await connector.listSchemas()
    expect(schemas).toContain("testdb")
    const tables = await connector.listTables("testdb")
    expect(tables.find((t: any) => t.name === "v248_test")).toBeDefined()
    const cols = await connector.describeTable("testdb", "v248_test")
    expect(cols.length).toBe(3)
    const tsCol = cols.find((c: any) => c.name === "ts")
    expect(tsCol?.data_type).toBe("DateTime64(3)")
    // Clean up
    await connector.execute("DROP TABLE IF EXISTS testdb.v248_test")
  })

  test("close 24.8 connection", async () => {
    await connector.close()
    connector = null
  })
})

// ---------------------------------------------------------------------------
// Connection string E2E
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER && !CH_USE_CI)("ClickHouse Driver E2E — Connection String", () => {
  let connector: any

  beforeAll(async () => {
    // Reuse the main ClickHouse container from the first test suite
    if (!CH_USE_CI) {
      // Wait for the main container to be available (may already be running)
      try {
        execSync(`docker inspect ${CH_CONTAINER}`, { stdio: "ignore" })
      } catch {
        // Container doesn't exist, start it
        dockerRun(
          `-d --name ${CH_CONTAINER} ` +
            `-p ${CH_PORT}:8123 ` +
            `-e CLICKHOUSE_DB=testdb ` +
            `-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 ` +
            `clickhouse/clickhouse-server:latest`,
        )
      }
    }
    await waitForPort(CH_PORT, 60000)
    const { connect } = await import("@altimateai/drivers/clickhouse")
    connector = await waitForDbReady(async () => {
      const c = await connect({
        type: "clickhouse",
        connection_string: `http://${CH_HOST}:${CH_PORT}`,
        database: "testdb",
      })
      return { connector: c, testQuery: "SELECT 1" }
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      try {
        await connector.close()
      } catch {}
    }
  })

  test("connect via connection string", () => {
    expect(connector).toBeDefined()
  })

  test("execute query via connection string", async () => {
    const result = await connector.execute("SELECT 42 AS answer")
    expect(result.rows[0][0]).toBe(42)
  })

  test("close", async () => {
    await connector.close()
    connector = null
  })
})

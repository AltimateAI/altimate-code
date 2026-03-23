import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import * as Registry from "../../src/altimate/native/connections/registry"
import * as CredentialStore from "../../src/altimate/native/connections/credential-store"
import { parseDbtProfiles } from "../../src/altimate/native/connections/dbt-profiles"
import { discoverContainers } from "../../src/altimate/native/connections/docker-discovery"
import { registerAll } from "../../src/altimate/native/connections/register"

// ---------------------------------------------------------------------------
// ConnectionRegistry
// ---------------------------------------------------------------------------

describe("ConnectionRegistry", () => {
  beforeEach(() => {
    Registry.reset()
  })

  test("list returns empty when no configs loaded", () => {
    Registry.setConfigs({})
    const result = Registry.list()
    expect(result.warehouses).toEqual([])
  })

  test("list returns configured warehouses", () => {
    Registry.setConfigs({
      mydb: { type: "postgres", host: "localhost", port: 5432, database: "test" },
      snowprod: { type: "snowflake", account: "abc123" },
    })
    const result = Registry.list()
    expect(result.warehouses).toHaveLength(2)
    expect(result.warehouses[0].name).toBe("mydb")
    expect(result.warehouses[0].type).toBe("postgres")
    expect(result.warehouses[1].name).toBe("snowprod")
    expect(result.warehouses[1].type).toBe("snowflake")
  })

  test("get throws for unknown connection", async () => {
    Registry.setConfigs({})
    await expect(Registry.get("nonexistent")).rejects.toThrow(
      'Connection "nonexistent" not found',
    )
  })

  test("getConfig returns config for known connection", () => {
    Registry.setConfigs({
      mydb: { type: "postgres", host: "localhost" },
    })
    const config = Registry.getConfig("mydb")
    expect(config).toBeDefined()
    expect(config?.type).toBe("postgres")
  })

  test("getConfig returns undefined for unknown connection", () => {
    Registry.setConfigs({})
    expect(Registry.getConfig("nope")).toBeUndefined()
  })

  test("setConfigs overrides existing state", () => {
    Registry.setConfigs({ a: { type: "postgres" } })
    expect(Registry.list().warehouses).toHaveLength(1)

    Registry.setConfigs({ b: { type: "mysql" }, c: { type: "duckdb" } })
    expect(Registry.list().warehouses).toHaveLength(2)
    expect(Registry.getConfig("a")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CredentialStore (keytar not available in test environment)
// ---------------------------------------------------------------------------

describe("CredentialStore", () => {
  test("storeCredential returns false when keytar unavailable", async () => {
    const result = await CredentialStore.storeCredential("mydb", "password", "secret")
    expect(result).toBe(false)
  })

  test("getCredential returns null when keytar unavailable", async () => {
    const result = await CredentialStore.getCredential("mydb", "password")
    expect(result).toBeNull()
  })

  test("resolveConfig returns config as-is when keytar unavailable", async () => {
    const config = { type: "postgres", host: "localhost" } as any
    const resolved = await CredentialStore.resolveConfig("mydb", config)
    expect(resolved).toEqual(config)
  })

  test("saveConnection returns config with warnings when keytar unavailable", async () => {
    const config = { type: "postgres", password: "secret123" } as any
    const { sanitized, warnings } = await CredentialStore.saveConnection("mydb", config)
    // Password stripped from config since keytar can't store it, warning emitted
    expect(sanitized.password).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("isSensitiveField identifies sensitive fields", () => {
    expect(CredentialStore.isSensitiveField("password")).toBe(true)
    expect(CredentialStore.isSensitiveField("private_key")).toBe(true)
    expect(CredentialStore.isSensitiveField("privateKey")).toBe(true)
    expect(CredentialStore.isSensitiveField("private_key_passphrase")).toBe(true)
    expect(CredentialStore.isSensitiveField("privateKeyPassphrase")).toBe(true)
    expect(CredentialStore.isSensitiveField("privateKeyPass")).toBe(true)
    expect(CredentialStore.isSensitiveField("access_token")).toBe(true)
    expect(CredentialStore.isSensitiveField("token")).toBe(true)
    expect(CredentialStore.isSensitiveField("oauth_client_secret")).toBe(true)
    expect(CredentialStore.isSensitiveField("oauthClientSecret")).toBe(true)
    expect(CredentialStore.isSensitiveField("passcode")).toBe(true)
    expect(CredentialStore.isSensitiveField("connection_string")).toBe(true)
    expect(CredentialStore.isSensitiveField("host")).toBe(false)
    expect(CredentialStore.isSensitiveField("port")).toBe(false)
    expect(CredentialStore.isSensitiveField("authenticator")).toBe(false)
  })

  test("saveConnection strips inline private_key as sensitive", async () => {
    const config = { type: "snowflake", private_key: "-----BEGIN PRIVATE KEY-----\nMIIE..." } as any
    const { sanitized, warnings } = await CredentialStore.saveConnection("sf_keypair", config)
    expect(sanitized.private_key).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("saveConnection strips OAuth credentials as sensitive", async () => {
    const config = { type: "snowflake", authenticator: "oauth", token: "access-token-123", oauth_client_secret: "secret" } as any
    const { sanitized } = await CredentialStore.saveConnection("sf_oauth", config)
    expect(sanitized.token).toBeUndefined()
    expect(sanitized.oauth_client_secret).toBeUndefined()
    expect(sanitized.authenticator).toBe("oauth")
  })
})

// ---------------------------------------------------------------------------
// dbt profiles parser
// ---------------------------------------------------------------------------

describe("dbt profiles parser", () => {
  test("returns empty array for non-existent file", async () => {
    const connections = await parseDbtProfiles("/nonexistent/profiles.yml")
    expect(connections).toEqual([])
  })

  // For a real profiles.yml parse test, we would need to write a temp file.
  // Keeping it simple for now — the parser is mostly about YAML parsing + mapping.
  test("handles env_var resolution in profiles", async () => {
    // Set env var for test
    process.env.TEST_DBT_PASSWORD = "my_secret"

    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
myproject:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost
      port: 5432
      user: testuser
      password: "{{ env_var('TEST_DBT_PASSWORD') }}"
      dbname: mydb
      schema: public
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("myproject_dev")
      expect(connections[0].type).toBe("postgres")
      expect(connections[0].config.password).toBe("my_secret")
      expect(connections[0].config.database).toBe("mydb")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
      delete process.env.TEST_DBT_PASSWORD
    }
  })

  test("parses Snowflake private_key from dbt profile", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
snowflake_keypair:
  outputs:
    prod:
      type: snowflake
      account: abc123
      user: svc_user
      private_key: "-----BEGIN PRIVATE KEY-----\\nMIIEvQ..."
      private_key_passphrase: "my-passphrase"
      database: ANALYTICS
      warehouse: COMPUTE_WH
      schema: PUBLIC
      role: TRANSFORMER
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe("snowflake")
      expect(connections[0].config.private_key).toBe("-----BEGIN PRIVATE KEY-----\nMIIEvQ...")
      expect(connections[0].config.private_key_passphrase).toBe("my-passphrase")
      expect(connections[0].config.password).toBeUndefined()
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("maps dbt adapter types correctly", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
snow:
  outputs:
    prod:
      type: snowflake
      account: abc123
      user: admin
      password: pw
      database: ANALYTICS
      warehouse: COMPUTE_WH
      schema: PUBLIC
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe("snowflake")
      expect(connections[0].config.account).toBe("abc123")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Docker discovery (dockerode not available)
// ---------------------------------------------------------------------------

describe("Docker discovery", () => {
  test("returns empty array when dockerode not installed", async () => {
    const containers = await discoverContainers()
    expect(containers).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dispatcher registration
// ---------------------------------------------------------------------------

describe("Connection dispatcher registration", () => {
  beforeEach(() => {
    Dispatcher.reset()
    Registry.reset()
    registerAll()
  })

  test("registers sql.execute handler", () => {
    expect(Dispatcher.hasNativeHandler("sql.execute")).toBe(true)
  })

  test("registers sql.explain handler", () => {
    expect(Dispatcher.hasNativeHandler("sql.explain")).toBe(true)
  })

  test("registers warehouse.list handler", () => {
    expect(Dispatcher.hasNativeHandler("warehouse.list")).toBe(true)
  })

  test("registers warehouse.test handler", () => {
    expect(Dispatcher.hasNativeHandler("warehouse.test")).toBe(true)
  })

  test("registers warehouse.add handler", () => {
    expect(Dispatcher.hasNativeHandler("warehouse.add")).toBe(true)
  })

  test("registers warehouse.remove handler", () => {
    expect(Dispatcher.hasNativeHandler("warehouse.remove")).toBe(true)
  })

  test("registers warehouse.discover handler", () => {
    expect(Dispatcher.hasNativeHandler("warehouse.discover")).toBe(true)
  })

  test("registers schema.inspect handler", () => {
    expect(Dispatcher.hasNativeHandler("schema.inspect")).toBe(true)
  })

  test("registers dbt.profiles handler", () => {
    expect(Dispatcher.hasNativeHandler("dbt.profiles")).toBe(true)
  })

  test("does NOT register sql.autocomplete (deferred to bridge)", () => {
    expect(Dispatcher.hasNativeHandler("sql.autocomplete")).toBe(false)
  })

  test("warehouse.list returns empty when no configs", async () => {
    Registry.setConfigs({})
    const result = await Dispatcher.call("warehouse.list", {})
    expect(result.warehouses).toEqual([])
  })

  test("warehouse.list returns configured warehouses", async () => {
    Registry.setConfigs({
      pg_local: { type: "postgres", host: "localhost", database: "testdb" },
    })
    const result = await Dispatcher.call("warehouse.list", {})
    expect(result.warehouses).toHaveLength(1)
    expect(result.warehouses[0].name).toBe("pg_local")
    expect(result.warehouses[0].type).toBe("postgres")
    expect(result.warehouses[0].database).toBe("testdb")
  })

  test("warehouse.test returns error for unknown connection", async () => {
    Registry.setConfigs({})
    const result = await Dispatcher.call("warehouse.test", { name: "nope" })
    expect(result.connected).toBe(false)
    expect(result.error).toContain("not found")
  })

  test("warehouse.add rejects config without type", async () => {
    const result = await Dispatcher.call("warehouse.add", {
      name: "bad",
      config: { host: "localhost" },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("type")
  })

  test("warehouse.discover returns containers (empty when docker unavailable)", async () => {
    const result = await Dispatcher.call("warehouse.discover", {})
    expect(result.containers).toEqual([])
    expect(result.container_count).toBe(0)
  })

  test("sql.execute returns error when no warehouse configured", async () => {
    Registry.setConfigs({})
    const result = await Dispatcher.call("sql.execute", { sql: "SELECT 1" }) as any
    expect(result.error).toContain("No warehouse configured")
    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([])
  })

  test("dbt.profiles returns empty for non-existent path", async () => {
    const result = await Dispatcher.call("dbt.profiles", {
      path: "/nonexistent/profiles.yml",
    })
    expect(result.success).toBe(true)
    expect(result.connections).toEqual([])
    expect(result.connection_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// DuckDB driver (in-memory, actual queries)
// ---------------------------------------------------------------------------

// altimate_change start - check DuckDB availability by actually connecting to guard
// against environments where require.resolve succeeds but the native binding is broken
// (e.g. worktrees where node-pre-gyp hasn't built the .node file).
let duckdbAvailable = false
try {
  require.resolve("duckdb")
  duckdbAvailable = true
} catch {
  // DuckDB native driver not installed — skip all tests in this block
}

describe.skipIf(!duckdbAvailable)("DuckDB driver (in-memory)", () => {
  let connector: any
  // duckdbReady is set only when the driver successfully connects.
  // duckdbAvailable may be true even when the native binding is broken.
  let duckdbReady = false

  // altimate_change start — use beforeAll/afterAll to share one connection per
  // describe block, avoiding native-binding contention when the full suite runs
  // in parallel. A single connection is created once and reused across all tests.
  beforeAll(async () => {
    duckdbReady = false
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { connect } = await import("@altimateai/drivers/duckdb")
        connector = await connect({ type: "duckdb", path: ":memory:" })
        await connector.connect()
        // Verify connector has the full API (guards against test-suite mock leakage)
        if (
          typeof connector.listSchemas === "function" &&
          typeof connector.listTables === "function" &&
          typeof connector.describeTable === "function"
        ) {
          duckdbReady = true
          break
        }
      } catch {
        if (attempt < maxAttempts) {
          // Brief delay before retry to let concurrent native-binding loads settle
          await new Promise((r) => setTimeout(r, 100 * attempt))
        }
        // Native binding unavailable — tests will skip via duckdbReady guard
      }
    }
  })

  afterAll(async () => {
    if (connector) {
      await connector.close()
      connector = undefined
    }
  })
  // altimate_change end

  test("execute SELECT 1", async () => {
    if (!duckdbReady) return
    const result = await connector.execute("SELECT 1 AS num")
    expect(result.columns).toEqual(["num"])
    expect(result.rows).toEqual([[1]])
    expect(result.row_count).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test("execute with limit truncation", async () => {
    if (!duckdbReady) return
    // Generate 5 rows, limit to 3
    const result = await connector.execute(
      "SELECT * FROM generate_series(1, 5)",
      3,
    )
    expect(result.row_count).toBe(3)
    expect(result.truncated).toBe(true)
  })

  test("listSchemas returns schemas", async () => {
    if (!duckdbReady) return
    const schemas = await connector.listSchemas()
    expect(schemas).toContain("main")
  })

  test("listTables and describeTable", async () => {
    if (!duckdbReady) return
    // Use DROP IF EXISTS before CREATE to prevent cross-test interference
    // when the shared connection already has this table from a prior run
    await connector.execute("DROP TABLE IF EXISTS conn_test_table")
    await connector.execute(
      "CREATE TABLE conn_test_table (id INTEGER NOT NULL, name VARCHAR, active BOOLEAN)",
    )

    const tables = await connector.listTables("main")
    const testTable = tables.find((t: any) => t.name === "conn_test_table")
    expect(testTable).toBeDefined()
    expect(testTable?.type).toBe("table")

    const columns = await connector.describeTable("main", "conn_test_table")
    expect(columns).toHaveLength(3)
    expect(columns[0].name).toBe("id")
    expect(columns[0].nullable).toBe(false)
    expect(columns[1].name).toBe("name")
    expect(columns[1].nullable).toBe(true)
  })
})
// altimate_change end

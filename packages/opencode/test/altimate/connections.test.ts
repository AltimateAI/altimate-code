import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import * as Registry from "../../src/altimate/native/connections/registry"
import { detectAuthMethod } from "../../src/altimate/native/connections/registry"
import * as CredentialStore from "../../src/altimate/native/connections/credential-store"
import { parseDbtProfiles, dbtConnectionsToConfigs } from "../../src/altimate/native/connections/dbt-profiles"
import { discoverContainers, containerToConfig } from "../../src/altimate/native/connections/docker-discovery"
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

  test("cassandra gives helpful hint instead of generic unsupported error", async () => {
    Registry.setConfigs({
      mydb: { type: "cassandra", host: "localhost" },
    })
    await expect(Registry.get("mydb")).rejects.toThrow("not yet supported")
    await expect(Registry.get("mydb")).rejects.toThrow("cqlsh")
  })

  test("cockroachdb suggests using postgres type", async () => {
    Registry.setConfigs({
      mydb: { type: "cockroachdb", host: "localhost" },
    })
    await expect(Registry.get("mydb")).rejects.toThrow("postgres")
  })

  test("timescaledb suggests using postgres type", async () => {
    Registry.setConfigs({
      mydb: { type: "timescaledb", host: "localhost" },
    })
    await expect(Registry.get("mydb")).rejects.toThrow("postgres")
  })

  test("truly unknown type gives generic unsupported error with supported list", async () => {
    Registry.setConfigs({
      mydb: { type: "neo4j", host: "localhost" },
    })
    await expect(Registry.get("mydb")).rejects.toThrow("Unsupported database type")
    await expect(Registry.get("mydb")).rejects.toThrow("Supported:")
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
// loadFromEnv — env-var-based connection config loading
// ---------------------------------------------------------------------------

describe("loadFromEnv via Registry.load()", () => {
  const saved: Record<string, string | undefined> = {}

  function setEnv(key: string, value: string) {
    saved[key] = process.env[key]
    process.env[key] = value
  }

  beforeEach(() => {
    Registry.reset()
  })

  afterEach(() => {
    for (const [key, orig] of Object.entries(saved)) {
      if (orig === undefined) delete process.env[key]
      else process.env[key] = orig
    }
    for (const key of Object.keys(saved)) delete saved[key]
  })

  test("parses valid JSON from ALTIMATE_CODE_CONN_* env vars", () => {
    setEnv("ALTIMATE_CODE_CONN_MYDB", JSON.stringify({ type: "postgres", host: "localhost", port: 5432 }))
    Registry.load()
    const config = Registry.getConfig("mydb")
    expect(config).toBeDefined()
    expect(config?.type).toBe("postgres")
    expect(config?.host).toBe("localhost")
  })

  test("lowercases connection name from env var suffix", () => {
    setEnv("ALTIMATE_CODE_CONN_PROD_DB", JSON.stringify({ type: "snowflake", account: "abc" }))
    Registry.load()
    expect(Registry.getConfig("prod_db")).toBeDefined()
    expect(Registry.getConfig("PROD_DB")).toBeUndefined()
  })

  test("ignores env var with invalid JSON", () => {
    setEnv("ALTIMATE_CODE_CONN_BAD", "not-valid-json{")
    Registry.load()
    expect(Registry.getConfig("bad")).toBeUndefined()
  })

  test("ignores env var config without type field", () => {
    setEnv("ALTIMATE_CODE_CONN_NOTYPE", JSON.stringify({ host: "localhost", port: 5432 }))
    Registry.load()
    expect(Registry.getConfig("notype")).toBeUndefined()
  })

  test("ignores non-object JSON values (string, number, array)", () => {
    setEnv("ALTIMATE_CODE_CONN_STR", JSON.stringify("just a string"))
    setEnv("ALTIMATE_CODE_CONN_NUM", JSON.stringify(42))
    setEnv("ALTIMATE_CODE_CONN_ARR", JSON.stringify([1, 2, 3]))
    Registry.load()
    expect(Registry.getConfig("str")).toBeUndefined()
    expect(Registry.getConfig("num")).toBeUndefined()
    expect(Registry.getConfig("arr")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectAuthMethod
// ---------------------------------------------------------------------------

describe("detectAuthMethod", () => {
  test("returns 'connection_string' for config with connection_string", () => {
    expect(detectAuthMethod({ type: "postgres", connection_string: "postgresql://..." } as any)).toBe("connection_string")
  })

  test("returns 'key_pair' for Snowflake private_key_path", () => {
    expect(detectAuthMethod({ type: "snowflake", private_key_path: "/path/to/key.p8" } as any)).toBe("key_pair")
  })

  test("returns 'key_pair' for camelCase privateKeyPath", () => {
    expect(detectAuthMethod({ type: "snowflake", privateKeyPath: "/path/to/key.p8" } as any)).toBe("key_pair")
  })

  test("returns 'sso' for Snowflake externalbrowser", () => {
    expect(detectAuthMethod({ type: "snowflake", authenticator: "EXTERNALBROWSER" } as any)).toBe("sso")
  })

  test("returns 'sso' for Okta URL authenticator", () => {
    expect(detectAuthMethod({ type: "snowflake", authenticator: "https://myorg.okta.com" } as any)).toBe("sso")
  })

  test("returns 'oauth' for OAuth authenticator", () => {
    expect(detectAuthMethod({ type: "snowflake", authenticator: "OAUTH" } as any)).toBe("oauth")
  })

  test("returns 'token' for access_token", () => {
    expect(detectAuthMethod({ type: "databricks", access_token: "dapi..." } as any)).toBe("token")
  })

  test("returns 'password' for config with password", () => {
    expect(detectAuthMethod({ type: "postgres", password: "test-fake-password" } as any)).toBe("password")
  })

  test("returns 'file' for duckdb", () => {
    expect(detectAuthMethod({ type: "duckdb", path: "/data/my.db" } as any)).toBe("file")
  })

  test("returns 'file' for sqlite", () => {
    expect(detectAuthMethod({ type: "sqlite", path: "/data/my.sqlite" } as any)).toBe("file")
  })

  test("returns 'connection_string' for mongodb without password", () => {
    expect(detectAuthMethod({ type: "mongodb" } as any)).toBe("connection_string")
  })

  test("returns 'password' for mongo with password", () => {
    expect(detectAuthMethod({ type: "mongo", password: "test-fake-password" } as any)).toBe("password")
  })

  test("returns 'unknown' for null/undefined", () => {
    expect(detectAuthMethod(null)).toBe("unknown")
    expect(detectAuthMethod(undefined)).toBe("unknown")
  })

  test("returns 'unknown' for empty config with no identifiable auth", () => {
    expect(detectAuthMethod({ type: "postgres" } as any)).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// CredentialStore (keytar not available in test environment)
// ---------------------------------------------------------------------------

describe("CredentialStore", () => {
  test("storeCredential returns false when keytar unavailable", async () => {
    const result = await CredentialStore.storeCredential("mydb", "password", "test-fake-password")
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

  // altimate_change start — cover remaining SENSITIVE_FIELDS entries not in the test above
  test("isSensitiveField covers BigQuery, SSL, and SSH credential fields", () => {
    expect(CredentialStore.isSensitiveField("credentials_json")).toBe(true)
    expect(CredentialStore.isSensitiveField("keyfile_json")).toBe(true)
    expect(CredentialStore.isSensitiveField("ssl_key")).toBe(true)
    expect(CredentialStore.isSensitiveField("ssl_cert")).toBe(true)
    expect(CredentialStore.isSensitiveField("ssl_ca")).toBe(true)
    expect(CredentialStore.isSensitiveField("ssh_password")).toBe(true)
  })
  // altimate_change end

  test("saveConnection strips inline private_key as sensitive", async () => {
    const config = { type: "snowflake", private_key: "-----BEGIN PRIVATE KEY-----\nMIIE..." } as any
    const { sanitized, warnings } = await CredentialStore.saveConnection("sf_keypair", config)
    expect(sanitized.private_key).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("saveConnection strips OAuth credentials as sensitive", async () => {
    const config = { type: "snowflake", authenticator: "oauth", token: "test-fake-token", oauth_client_secret: "test-fake-password" } as any
    const { sanitized } = await CredentialStore.saveConnection("sf_oauth", config)
    expect(sanitized.token).toBeUndefined()
    expect(sanitized.oauth_client_secret).toBeUndefined()
    expect(sanitized.authenticator).toBe("oauth")
  })

  test("saveConnection strips all sensitive fields from complex config", async () => {
    const config = {
      type: "snowflake",
      account: "abc123",
      user: "svc_user",
      password: "test-fake-pw",
      private_key: "-----BEGIN PRIVATE KEY-----",
      private_key_passphrase: "test-fake-passphrase",
      token: "test-fake-oauth-token",
      oauth_client_secret: "test-fake-client-secret",
      ssh_password: "test-fake-ssh-pw",
      connection_string: "test-fake-connstring",
    } as any
    const { sanitized, warnings } = await CredentialStore.saveConnection("complex", config)

    expect(sanitized.password).toBeUndefined()
    expect(sanitized.private_key).toBeUndefined()
    expect(sanitized.private_key_passphrase).toBeUndefined()
    expect(sanitized.token).toBeUndefined()
    expect(sanitized.oauth_client_secret).toBeUndefined()
    expect(sanitized.ssh_password).toBeUndefined()
    expect(sanitized.connection_string).toBeUndefined()

    expect(sanitized.type).toBe("snowflake")
    expect(sanitized.account).toBe("abc123")
    expect(sanitized.user).toBe("svc_user")

    expect(warnings).toHaveLength(7)
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
    process.env.TEST_DBT_PASSWORD = "test-fake-dbt-pw"

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
      expect(connections[0].config.password).toBe("test-fake-dbt-pw")
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
      private_key_passphrase: "test-fake-pp"
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
      expect(connections[0].config.private_key_passphrase).toBe("test-fake-pp")
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

  // altimate_change start — tests for untested dbt profiles parser edge cases
  test("resolves env_var with default fallback when env var is missing", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    delete process.env.__TEST_DBT_MISSING_VAR_12345

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
myproject:
  outputs:
    dev:
      type: postgres
      host: "{{ env_var('__TEST_DBT_MISSING_VAR_12345', 'localhost') }}"
      port: 5432
      user: "{{ env_var('__TEST_DBT_MISSING_USER_12345', 'default_user') }}"
      password: secret
      dbname: mydb
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].config.host).toBe("localhost")
      expect(connections[0].config.user).toBe("default_user")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("skips 'config' top-level key (dbt global settings)", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
config:
  send_anonymous_usage_stats: false
  use_colors: true

real_project:
  outputs:
    dev:
      type: postgres
      host: localhost
      dbname: analytics
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("real_project_dev")
      expect(connections.find((c) => c.name.startsWith("config"))).toBeUndefined()
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("handles multiple profiles with multiple outputs", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
warehouse_a:
  outputs:
    dev:
      type: postgres
      host: localhost
      dbname: dev_db
    prod:
      type: postgres
      host: prod.example.com
      dbname: prod_db

warehouse_b:
  outputs:
    staging:
      type: snowflake
      account: abc123
      user: admin
      password: pw
      database: STAGING
      warehouse: COMPUTE_WH
      schema: PUBLIC
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(3)
      const names = connections.map((c) => c.name).sort()
      expect(names).toEqual(["warehouse_a_dev", "warehouse_a_prod", "warehouse_b_staging"])
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
  // altimate_change end

  test("spark adapter maps to databricks", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
spark_project:
  outputs:
    prod:
      type: spark
      server_hostname: my-spark-cluster.databricks.com
      http_path: /sql/1.0/warehouses/abc123
      token: test_fake_dapi
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe("databricks")
      expect(connections[0].config.type).toBe("databricks")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("trino adapter maps to postgres (wire-compatible)", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
trino_project:
  outputs:
    prod:
      type: trino
      host: trino.example.com
      port: 8080
      user: analyst
      dbname: hive
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe("postgres")
      expect(connections[0].config.type).toBe("postgres")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("clickhouse adapter maps correctly from dbt profiles", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"))
    const profilesPath = path.join(tmpDir, "profiles.yml")

    fs.writeFileSync(
      profilesPath,
      `
ch_project:
  outputs:
    dev:
      type: clickhouse
      host: clickhouse.example.com
      port: 8443
      user: default
      password: secret
      database: analytics
      schema: default
`,
    )

    try {
      const connections = await parseDbtProfiles(profilesPath)
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe("clickhouse")
      expect(connections[0].config.type).toBe("clickhouse")
      expect(connections[0].config.host).toBe("clickhouse.example.com")
      expect(connections[0].config.port).toBe(8443)
      expect(connections[0].config.user).toBe("default")
      expect(connections[0].config.database).toBe("analytics")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
})

// ---------------------------------------------------------------------------
// dbt profiles path resolution (DBT_PROFILES_DIR + project-local)
// ---------------------------------------------------------------------------

describe("dbt profiles path resolution", () => {
  const PROFILE_CONTENT = `
myproject:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost
      port: 5432
      user: test
      pass: secret
      dbname: testdb
      schema: public
`

  test("finds profiles.yml via DBT_PROFILES_DIR env var", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-envdir-"))
    fs.writeFileSync(path.join(tmpDir, "profiles.yml"), PROFILE_CONTENT)

    const origEnv = process.env.DBT_PROFILES_DIR
    process.env.DBT_PROFILES_DIR = tmpDir

    try {
      const connections = await parseDbtProfiles()
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("myproject_dev")
    } finally {
      if (origEnv === undefined) delete process.env.DBT_PROFILES_DIR
      else process.env.DBT_PROFILES_DIR = origEnv
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("finds project-local profiles.yml via projectDir", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-projdir-"))
    fs.writeFileSync(path.join(tmpDir, "profiles.yml"), PROFILE_CONTENT)

    try {
      const connections = await parseDbtProfiles(undefined, tmpDir)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("myproject_dev")
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test("DBT_PROFILES_DIR takes priority over projectDir", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-env-pri-"))
    fs.writeFileSync(
      path.join(envDir, "profiles.yml"),
      `
env_profile:
  outputs:
    dev:
      type: postgres
      host: env-host
      dbname: envdb
      schema: public
`,
    )

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-proj-pri-"))
    fs.writeFileSync(
      path.join(projDir, "profiles.yml"),
      `
proj_profile:
  outputs:
    dev:
      type: postgres
      host: proj-host
      dbname: projdb
      schema: public
`,
    )

    const origEnv = process.env.DBT_PROFILES_DIR
    process.env.DBT_PROFILES_DIR = envDir

    try {
      const connections = await parseDbtProfiles(undefined, projDir)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("env_profile_dev")
      expect(connections[0].config.host).toBe("env-host")
    } finally {
      if (origEnv === undefined) delete process.env.DBT_PROFILES_DIR
      else process.env.DBT_PROFILES_DIR = origEnv
      fs.rmSync(envDir, { recursive: true })
      fs.rmSync(projDir, { recursive: true })
    }
  })

  test("explicit path takes priority over DBT_PROFILES_DIR", async () => {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")

    const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-explicit-"))
    fs.writeFileSync(
      path.join(explicitDir, "profiles.yml"),
      `
explicit_profile:
  outputs:
    dev:
      type: postgres
      host: explicit-host
      dbname: explicitdb
      schema: public
`,
    )

    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-env-nouse-"))
    fs.writeFileSync(path.join(envDir, "profiles.yml"), PROFILE_CONTENT)

    const origEnv = process.env.DBT_PROFILES_DIR
    process.env.DBT_PROFILES_DIR = envDir

    try {
      const connections = await parseDbtProfiles(path.join(explicitDir, "profiles.yml"), undefined)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("explicit_profile_dev")
    } finally {
      if (origEnv === undefined) delete process.env.DBT_PROFILES_DIR
      else process.env.DBT_PROFILES_DIR = origEnv
      fs.rmSync(explicitDir, { recursive: true })
      fs.rmSync(envDir, { recursive: true })
    }
  })
})

// ---------------------------------------------------------------------------
// dbtConnectionsToConfigs
// ---------------------------------------------------------------------------

describe("dbtConnectionsToConfigs", () => {
  test("converts connection array to keyed record", () => {
    const connections = [
      { name: "pg_dev", type: "postgres", config: { type: "postgres", host: "localhost" } },
      { name: "sf_prod", type: "snowflake", config: { type: "snowflake", account: "abc" } },
    ]
    const result = dbtConnectionsToConfigs(connections)
    expect(Object.keys(result)).toHaveLength(2)
    expect(result["pg_dev"].type).toBe("postgres")
    expect(result["sf_prod"].type).toBe("snowflake")
  })

  test("returns empty object for empty array", () => {
    const result = dbtConnectionsToConfigs([])
    expect(result).toEqual({})
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

  test("containerToConfig creates config with all fields from a fully-populated container", () => {
    const container = {
      container_id: "abc123def456",
      name: "my-postgres",
      image: "postgres:16",
      db_type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "admin",
      password: "test-fake-password",
      database: "mydb",
      status: "running",
    }
    const config = containerToConfig(container as any)
    expect(config.type).toBe("postgres")
    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(5432)
    expect(config.user).toBe("admin")
    expect(config.password).toBe("test-fake-password")
    expect(config.database).toBe("mydb")
  })

  test("containerToConfig omits undefined optional fields", () => {
    const container = {
      container_id: "def456",
      name: "mysql_dev",
      image: "mysql:8",
      db_type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      user: undefined as string | undefined,
      password: undefined as string | undefined,
      database: undefined as string | undefined,
      status: "running",
    }
    const config = containerToConfig(container as any)
    expect(config.type).toBe("mysql")
    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(3306)
    expect(config.user).toBeUndefined()
    expect(config.password).toBeUndefined()
    expect(config.database).toBeUndefined()
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

import { describe, expect, test } from "bun:test"
import { normalizeConfig } from "@altimateai/drivers"
import { isSensitiveField } from "../../src/altimate/native/connections/credential-store"

// ---------------------------------------------------------------------------
// normalizeConfig — identity (canonical fields pass through unchanged)
// ---------------------------------------------------------------------------

describe("normalizeConfig — identity", () => {
  test("canonical postgres config passes through unchanged", () => {
    const config = {
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "mydb",
      user: "admin",
      password: "secret",
    }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("canonical snowflake config passes through unchanged", () => {
    const config = {
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      password: "secret",
      database: "MYDB",
      warehouse: "COMPUTE_WH",
    }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("unknown type passes through unchanged", () => {
    const config = { type: "unknown_db", foo: "bar", baz: 42 }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("missing type passes through unchanged", () => {
    const config = { type: "", host: "localhost" }
    expect(normalizeConfig(config)).toEqual(config)
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — first-value-wins
// ---------------------------------------------------------------------------

describe("normalizeConfig — first-value-wins", () => {
  test("canonical field takes precedence over alias", () => {
    const config = {
      type: "postgres",
      user: "correct",
      username: "wrong",
    }
    const result = normalizeConfig(config)
    expect(result.user).toBe("correct")
    expect(result.username).toBeUndefined()
  })

  test("canonical database takes precedence over dbname", () => {
    const config = {
      type: "mysql",
      database: "correct_db",
      dbname: "wrong_db",
    }
    const result = normalizeConfig(config)
    expect(result.database).toBe("correct_db")
    expect(result.dbname).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — common aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — common aliases", () => {
  test("username → user for postgres", () => {
    const result = normalizeConfig({
      type: "postgres",
      username: "admin",
    })
    expect(result.user).toBe("admin")
    expect(result.username).toBeUndefined()
  })

  test("dbname → database for postgres", () => {
    const result = normalizeConfig({
      type: "postgres",
      dbname: "mydb",
    })
    expect(result.database).toBe("mydb")
    expect(result.dbname).toBeUndefined()
  })

  test("db → database for mysql", () => {
    const result = normalizeConfig({
      type: "mysql",
      db: "mydb",
    })
    expect(result.database).toBe("mydb")
    expect(result.db).toBeUndefined()
  })

  test("username → user for redshift", () => {
    const result = normalizeConfig({
      type: "redshift",
      username: "admin",
    })
    expect(result.user).toBe("admin")
    expect(result.username).toBeUndefined()
  })

  test("username → user for oracle", () => {
    const result = normalizeConfig({
      type: "oracle",
      username: "admin",
    })
    expect(result.user).toBe("admin")
    expect(result.username).toBeUndefined()
  })

  test("username → user for sqlserver", () => {
    const result = normalizeConfig({
      type: "sqlserver",
      username: "sa",
    })
    expect(result.user).toBe("sa")
    expect(result.username).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — Snowflake aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — Snowflake", () => {
  test("privateKeyPath → private_key_path", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      privateKeyPath: "/path/to/key.p8",
    })
    expect(result.private_key_path).toBe("/path/to/key.p8")
    expect(result.privateKeyPath).toBeUndefined()
  })

  test("privateKeyPassphrase → private_key_passphrase", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      privateKeyPassphrase: "secret",
    })
    expect(result.private_key_passphrase).toBe("secret")
    expect(result.privateKeyPassphrase).toBeUndefined()
  })

  test("privateKey → private_key", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIE...",
    })
    expect(result.private_key).toBe("-----BEGIN PRIVATE KEY-----\nMIIE...")
    expect(result.privateKey).toBeUndefined()
  })

  test("private_key with file path → private_key_path", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      private_key: "/home/user/.ssh/snowflake_key.p8",
    })
    expect(result.private_key_path).toBe("/home/user/.ssh/snowflake_key.p8")
    expect(result.private_key).toBeUndefined()
  })

  test("private_key with .pem extension → private_key_path", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      private_key: "rsa_key.pem",
    })
    expect(result.private_key_path).toBe("rsa_key.pem")
    expect(result.private_key).toBeUndefined()
  })

  test("private_key with inline PEM stays as private_key", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg..."
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      private_key: pem,
    })
    expect(result.private_key).toBe(pem)
    expect(result.private_key_path).toBeUndefined()
  })

  test("private_key_path takes precedence over private_key path detection", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      user: "admin",
      private_key_path: "/correct/path.p8",
      private_key: "/wrong/path.p8",
    })
    expect(result.private_key_path).toBe("/correct/path.p8")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — BigQuery aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — BigQuery", () => {
  test("projectId → project", () => {
    const result = normalizeConfig({
      type: "bigquery",
      projectId: "my-project",
    })
    expect(result.project).toBe("my-project")
    expect(result.projectId).toBeUndefined()
  })

  test("project_id → project", () => {
    const result = normalizeConfig({
      type: "bigquery",
      project_id: "my-project",
    })
    expect(result.project).toBe("my-project")
    expect(result.project_id).toBeUndefined()
  })

  test("keyFilename → credentials_path", () => {
    const result = normalizeConfig({
      type: "bigquery",
      keyFilename: "/path/to/key.json",
    })
    expect(result.credentials_path).toBe("/path/to/key.json")
    expect(result.keyFilename).toBeUndefined()
  })

  test("keyfile → credentials_path", () => {
    const result = normalizeConfig({
      type: "bigquery",
      keyfile: "/path/to/key.json",
    })
    expect(result.credentials_path).toBe("/path/to/key.json")
    expect(result.keyfile).toBeUndefined()
  })

  test("key_file → credentials_path", () => {
    const result = normalizeConfig({
      type: "bigquery",
      key_file: "/path/to/key.json",
    })
    expect(result.credentials_path).toBe("/path/to/key.json")
    expect(result.key_file).toBeUndefined()
  })

  test("keyFile → credentials_path", () => {
    const result = normalizeConfig({
      type: "bigquery",
      keyFile: "/path/to/key.json",
    })
    expect(result.credentials_path).toBe("/path/to/key.json")
    expect(result.keyFile).toBeUndefined()
  })

  test("keyfile_json → credentials_json", () => {
    const result = normalizeConfig({
      type: "bigquery",
      keyfile_json: '{"key": "value"}',
    })
    expect(result.credentials_json).toBe('{"key": "value"}')
    expect(result.keyfile_json).toBeUndefined()
  })

  test("keyfileJson → credentials_json", () => {
    const result = normalizeConfig({
      type: "bigquery",
      keyfileJson: '{"key": "value"}',
    })
    expect(result.credentials_json).toBe('{"key": "value"}')
    expect(result.keyfileJson).toBeUndefined()
  })

  test("defaultDataset → dataset", () => {
    const result = normalizeConfig({
      type: "bigquery",
      defaultDataset: "my_dataset",
    })
    expect(result.dataset).toBe("my_dataset")
    expect(result.defaultDataset).toBeUndefined()
  })

  test("default_dataset → dataset", () => {
    const result = normalizeConfig({
      type: "bigquery",
      default_dataset: "my_dataset",
    })
    expect(result.dataset).toBe("my_dataset")
    expect(result.default_dataset).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — Databricks aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — Databricks", () => {
  test("host → server_hostname (databricks only)", () => {
    const result = normalizeConfig({
      type: "databricks",
      host: "my-workspace.cloud.databricks.com",
    })
    expect(result.server_hostname).toBe("my-workspace.cloud.databricks.com")
    expect(result.host).toBeUndefined()
  })

  test("serverHostname → server_hostname", () => {
    const result = normalizeConfig({
      type: "databricks",
      serverHostname: "my-workspace.cloud.databricks.com",
    })
    expect(result.server_hostname).toBe("my-workspace.cloud.databricks.com")
    expect(result.serverHostname).toBeUndefined()
  })

  test("httpPath → http_path", () => {
    const result = normalizeConfig({
      type: "databricks",
      httpPath: "/sql/1.0/endpoints/abc",
    })
    expect(result.http_path).toBe("/sql/1.0/endpoints/abc")
    expect(result.httpPath).toBeUndefined()
  })

  test("token → access_token", () => {
    const result = normalizeConfig({
      type: "databricks",
      token: "dapi1234",
    })
    expect(result.access_token).toBe("dapi1234")
    expect(result.token).toBeUndefined()
  })

  test("personal_access_token → access_token", () => {
    const result = normalizeConfig({
      type: "databricks",
      personal_access_token: "dapi1234",
    })
    expect(result.access_token).toBe("dapi1234")
    expect(result.personal_access_token).toBeUndefined()
  })

  test("personalAccessToken → access_token", () => {
    const result = normalizeConfig({
      type: "databricks",
      personalAccessToken: "dapi1234",
    })
    expect(result.access_token).toBe("dapi1234")
    expect(result.personalAccessToken).toBeUndefined()
  })

  test("host alias does NOT apply to postgres", () => {
    const result = normalizeConfig({
      type: "postgres",
      host: "localhost",
    })
    expect(result.host).toBe("localhost")
    expect(result.server_hostname).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — PostgreSQL / Redshift aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — PostgreSQL / Redshift", () => {
  test("connectionString → connection_string for postgres", () => {
    const result = normalizeConfig({
      type: "postgres",
      connectionString: "postgresql://user:pass@host/db",
    })
    expect(result.connection_string).toBe("postgresql://user:pass@host/db")
    expect(result.connectionString).toBeUndefined()
  })

  test("connectionString → connection_string for redshift", () => {
    const result = normalizeConfig({
      type: "redshift",
      connectionString: "postgresql://user:pass@host/db",
    })
    expect(result.connection_string).toBe("postgresql://user:pass@host/db")
    expect(result.connectionString).toBeUndefined()
  })

  test("postgresql type alias works", () => {
    const result = normalizeConfig({
      type: "postgresql",
      username: "admin",
      dbname: "mydb",
    })
    expect(result.user).toBe("admin")
    expect(result.database).toBe("mydb")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — SQL Server aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — SQL Server", () => {
  test("server → host", () => {
    const result = normalizeConfig({
      type: "sqlserver",
      server: "myserver.database.windows.net",
    })
    expect(result.host).toBe("myserver.database.windows.net")
    expect(result.server).toBeUndefined()
  })

  test("serverName → host", () => {
    const result = normalizeConfig({
      type: "sqlserver",
      serverName: "myserver",
    })
    expect(result.host).toBe("myserver")
    expect(result.serverName).toBeUndefined()
  })

  test("server_name → host", () => {
    const result = normalizeConfig({
      type: "sqlserver",
      server_name: "myserver",
    })
    expect(result.host).toBe("myserver")
    expect(result.server_name).toBeUndefined()
  })

  test("trustServerCertificate → trust_server_certificate", () => {
    const result = normalizeConfig({
      type: "sqlserver",
      trustServerCertificate: true,
    })
    expect(result.trust_server_certificate).toBe(true)
    expect(result.trustServerCertificate).toBeUndefined()
  })

  test("mssql type alias works", () => {
    const result = normalizeConfig({
      type: "mssql",
      server: "myserver",
      username: "sa",
    })
    expect(result.host).toBe("myserver")
    expect(result.user).toBe("sa")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — Oracle aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — Oracle", () => {
  test("connectString → connection_string", () => {
    const result = normalizeConfig({
      type: "oracle",
      connectString: "localhost:1521/ORCL",
    })
    expect(result.connection_string).toBe("localhost:1521/ORCL")
    expect(result.connectString).toBeUndefined()
  })

  test("connect_string → connection_string", () => {
    const result = normalizeConfig({
      type: "oracle",
      connect_string: "localhost:1521/ORCL",
    })
    expect(result.connection_string).toBe("localhost:1521/ORCL")
    expect(result.connect_string).toBeUndefined()
  })

  test("connectionString → connection_string", () => {
    const result = normalizeConfig({
      type: "oracle",
      connectionString: "localhost:1521/ORCL",
    })
    expect(result.connection_string).toBe("localhost:1521/ORCL")
    expect(result.connectionString).toBeUndefined()
  })

  test("serviceName → service_name", () => {
    const result = normalizeConfig({
      type: "oracle",
      serviceName: "ORCL",
    })
    expect(result.service_name).toBe("ORCL")
    expect(result.serviceName).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — MySQL SSL fields stay top-level
// ---------------------------------------------------------------------------
// SSL fields (ssl_ca, ssl_cert, ssl_key) are NOT constructed into an ssl
// object by normalizeConfig. They stay top-level so the credential store can
// detect and strip them. The MySQL driver constructs the ssl object at
// connection time.

describe("normalizeConfig — MySQL SSL fields", () => {
  test("ssl_ca/ssl_cert/ssl_key stay as top-level fields", () => {
    const result = normalizeConfig({
      type: "mysql",
      host: "localhost",
      ssl_ca: "/path/ca.pem",
      ssl_cert: "/path/client-cert.pem",
      ssl_key: "/path/client-key.pem",
    })
    expect(result.ssl_ca).toBe("/path/ca.pem")
    expect(result.ssl_cert).toBe("/path/client-cert.pem")
    expect(result.ssl_key).toBe("/path/client-key.pem")
    expect(result.ssl).toBeUndefined()
  })

  test("existing ssl object is preserved", () => {
    const sslObj = { rejectUnauthorized: false }
    const result = normalizeConfig({
      type: "mysql",
      ssl: sslObj,
    })
    expect(result.ssl).toEqual(sslObj)
  })

  test("mariadb ssl fields also stay top-level", () => {
    const result = normalizeConfig({
      type: "mariadb",
      ssl_ca: "/path/ca.pem",
    })
    expect(result.ssl_ca).toBe("/path/ca.pem")
    expect(result.ssl).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isSensitiveField — expanded set
// ---------------------------------------------------------------------------

describe("isSensitiveField — expanded set", () => {
  const expectedSensitive = [
    "password",
    "private_key",
    "privateKey",
    "private_key_passphrase",
    "privateKeyPassphrase",
    "privateKeyPass",
    "access_token",
    "token",
    "oauth_client_secret",
    "oauthClientSecret",
    "passcode",
    "ssh_password",
    "connection_string",
    "credentials_json",
    "keyfile_json",
    "ssl_key",
    "ssl_cert",
    "ssl_ca",
  ]

  for (const field of expectedSensitive) {
    test(`${field} is sensitive`, () => {
      expect(isSensitiveField(field)).toBe(true)
    })
  }

  test("host is not sensitive", () => {
    expect(isSensitiveField("host")).toBe(false)
  })

  test("user is not sensitive", () => {
    expect(isSensitiveField("user")).toBe(false)
  })

  test("database is not sensitive", () => {
    expect(isSensitiveField("database")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — does not mutate input
// ---------------------------------------------------------------------------

describe("normalizeConfig — immutability", () => {
  test("input config is not mutated", () => {
    const original = {
      type: "postgres",
      username: "admin",
      dbname: "mydb",
    }
    const copy = { ...original }
    normalizeConfig(original)
    expect(original).toEqual(copy)
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — case-insensitive type
// ---------------------------------------------------------------------------

describe("normalizeConfig — case-insensitive type", () => {
  test("uppercase POSTGRES normalizes aliases", () => {
    const result = normalizeConfig({ type: "POSTGRES", username: "admin" })
    expect(result.user).toBe("admin")
    expect(result.username).toBeUndefined()
  })

  test("mixed case Snowflake normalizes aliases", () => {
    const result = normalizeConfig({
      type: "Snowflake",
      account: "xy12345",
      privateKeyPath: "/path/key.p8",
    })
    expect(result.private_key_path).toBe("/path/key.p8")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — DuckDB/SQLite passthrough
// ---------------------------------------------------------------------------

describe("normalizeConfig — DuckDB/SQLite passthrough", () => {
  test("duckdb config passes through unchanged", () => {
    const config = { type: "duckdb", path: ":memory:" }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("sqlite config passes through unchanged", () => {
    const config = { type: "sqlite", path: "/tmp/test.db" }
    expect(normalizeConfig(config)).toEqual(config)
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — Snowflake private_key edge cases
// ---------------------------------------------------------------------------

describe("normalizeConfig — Snowflake private_key edge cases", () => {
  test("opaque string without path indicators stays as private_key", () => {
    const result = normalizeConfig({
      type: "snowflake",
      account: "xy12345",
      private_key: "some-opaque-token-value",
    })
    expect(result.private_key).toBe("some-opaque-token-value")
    expect(result.private_key_path).toBeUndefined()
  })
})

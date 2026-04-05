import { describe, expect, test } from "bun:test"
import { normalizeConfig, sanitizeConnectionString } from "@altimateai/drivers"
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

// ---------------------------------------------------------------------------
// normalizeConfig — MongoDB aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — MongoDB", () => {
  test("canonical mongodb config passes through unchanged", () => {
    const config = {
      type: "mongodb",
      host: "localhost",
      port: 27017,
      database: "mydb",
      user: "admin",
      password: "secret",
    }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("connectionString → connection_string", () => {
    const result = normalizeConfig({
      type: "mongodb",
      connectionString: "mongodb://admin:secret@localhost:27017/mydb",
    })
    expect(result.connection_string).toBe("mongodb://admin:secret@localhost:27017/mydb")
    expect(result.connectionString).toBeUndefined()
  })

  test("uri → connection_string", () => {
    const result = normalizeConfig({
      type: "mongodb",
      uri: "mongodb+srv://admin:secret@cluster0.example.net/mydb",
    })
    expect(result.connection_string).toBe("mongodb+srv://admin:secret@cluster0.example.net/mydb")
    expect(result.uri).toBeUndefined()
  })

  test("url → connection_string", () => {
    const result = normalizeConfig({
      type: "mongodb",
      url: "mongodb://localhost:27017/mydb",
    })
    expect(result.connection_string).toBe("mongodb://localhost:27017/mydb")
    expect(result.url).toBeUndefined()
  })

  test("connection_string takes precedence over uri alias", () => {
    const result = normalizeConfig({
      type: "mongodb",
      connection_string: "mongodb://correct:27017/db",
      uri: "mongodb://wrong:27017/db",
    })
    expect(result.connection_string).toBe("mongodb://correct:27017/db")
    expect(result.uri).toBeUndefined()
  })

  test("authSource → auth_source", () => {
    const result = normalizeConfig({
      type: "mongodb",
      authSource: "admin",
    })
    expect(result.auth_source).toBe("admin")
    expect(result.authSource).toBeUndefined()
  })

  test("replicaSet → replica_set", () => {
    const result = normalizeConfig({
      type: "mongodb",
      replicaSet: "rs0",
    })
    expect(result.replica_set).toBe("rs0")
    expect(result.replicaSet).toBeUndefined()
  })

  test("directConnection → direct_connection", () => {
    const result = normalizeConfig({
      type: "mongodb",
      directConnection: true,
    })
    expect(result.direct_connection).toBe(true)
    expect(result.directConnection).toBeUndefined()
  })

  test("connectTimeoutMS → connect_timeout", () => {
    const result = normalizeConfig({
      type: "mongodb",
      connectTimeoutMS: 5000,
    })
    expect(result.connect_timeout).toBe(5000)
    expect(result.connectTimeoutMS).toBeUndefined()
  })

  test("serverSelectionTimeoutMS → server_selection_timeout", () => {
    const result = normalizeConfig({
      type: "mongodb",
      serverSelectionTimeoutMS: 10000,
    })
    expect(result.server_selection_timeout).toBe(10000)
    expect(result.serverSelectionTimeoutMS).toBeUndefined()
  })

  test("username → user for mongodb", () => {
    const result = normalizeConfig({
      type: "mongodb",
      username: "admin",
    })
    expect(result.user).toBe("admin")
    expect(result.username).toBeUndefined()
  })

  test("dbname → database for mongodb", () => {
    const result = normalizeConfig({
      type: "mongodb",
      dbname: "mydb",
    })
    expect(result.database).toBe("mydb")
    expect(result.dbname).toBeUndefined()
  })

  test("mongo type alias works", () => {
    const result = normalizeConfig({
      type: "mongo",
      username: "admin",
      connectionString: "mongodb://localhost:27017/mydb",
      authSource: "admin",
    })
    expect(result.user).toBe("admin")
    expect(result.connection_string).toBe("mongodb://localhost:27017/mydb")
    expect(result.auth_source).toBe("admin")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — ClickHouse aliases
// ---------------------------------------------------------------------------

describe("normalizeConfig — ClickHouse", () => {
  test("canonical clickhouse config passes through unchanged", () => {
    const config = {
      type: "clickhouse",
      host: "localhost",
      port: 8123,
      database: "default",
      user: "default",
      password: "secret",
    }
    expect(normalizeConfig(config)).toEqual(config)
  })

  test("connectionString → connection_string", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      connectionString: "http://localhost:8123",
    })
    expect(result.connection_string).toBe("http://localhost:8123")
    expect(result.connectionString).toBeUndefined()
  })

  test("uri → connection_string", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      uri: "http://localhost:8123",
    })
    expect(result.connection_string).toBe("http://localhost:8123")
    expect(result.uri).toBeUndefined()
  })

  test("url → connection_string", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      url: "https://my-ch.cloud:8443",
    })
    expect(result.connection_string).toBe("https://my-ch.cloud:8443")
    expect(result.url).toBeUndefined()
  })

  test("connection_string takes precedence over url alias", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      connection_string: "http://correct:8123",
      url: "http://wrong:8123",
    })
    expect(result.connection_string).toBe("http://correct:8123")
    expect(result.url).toBeUndefined()
  })

  test("username → user", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      username: "analytics",
    })
    expect(result.user).toBe("analytics")
    expect(result.username).toBeUndefined()
  })

  test("dbname → database", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      dbname: "analytics",
    })
    expect(result.database).toBe("analytics")
    expect(result.dbname).toBeUndefined()
  })

  test("requestTimeout → request_timeout", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      requestTimeout: 60000,
    })
    expect(result.request_timeout).toBe(60000)
    expect(result.requestTimeout).toBeUndefined()
  })

  test("timeout → request_timeout", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      timeout: 30000,
    })
    expect(result.request_timeout).toBe(30000)
    expect(result.timeout).toBeUndefined()
  })

  test("tlsCaCert → tls_ca_cert", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      tlsCaCert: "/path/to/ca.pem",
    })
    expect(result.tls_ca_cert).toBe("/path/to/ca.pem")
    expect(result.tlsCaCert).toBeUndefined()
  })

  test("ssl_ca → tls_ca_cert", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      ssl_ca: "/path/to/ca.pem",
    })
    expect(result.tls_ca_cert).toBe("/path/to/ca.pem")
    expect(result.ssl_ca).toBeUndefined()
  })

  test("ca_cert → tls_ca_cert", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      ca_cert: "/path/to/ca.pem",
    })
    expect(result.tls_ca_cert).toBe("/path/to/ca.pem")
    expect(result.ca_cert).toBeUndefined()
  })

  test("ssl_cert → tls_cert", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      ssl_cert: "/path/to/cert.pem",
    })
    expect(result.tls_cert).toBe("/path/to/cert.pem")
    expect(result.ssl_cert).toBeUndefined()
  })

  test("tlsCert → tls_cert", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      tlsCert: "/path/to/cert.pem",
    })
    expect(result.tls_cert).toBe("/path/to/cert.pem")
    expect(result.tlsCert).toBeUndefined()
  })

  test("tlsKey → tls_key", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      tlsKey: "/path/to/key.pem",
    })
    expect(result.tls_key).toBe("/path/to/key.pem")
    expect(result.tlsKey).toBeUndefined()
  })

  test("ssl_key → tls_key", () => {
    const result = normalizeConfig({
      type: "clickhouse",
      ssl_key: "/path/to/key.pem",
    })
    expect(result.tls_key).toBe("/path/to/key.pem")
    expect(result.ssl_key).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sanitizeConnectionString — special character encoding
// ---------------------------------------------------------------------------

describe("sanitizeConnectionString", () => {
  test("encodes @ in password", () => {
    const input = "postgresql://testuser:t@st@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:t%40st@localhost:5432/testdb")
  })

  test("encodes # in password", () => {
    const input = "postgresql://testuser:test#val@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:test%23val@localhost:5432/testdb")
  })

  test("encodes : in password", () => {
    const input = "postgresql://testuser:test:val@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:test%3Aval@localhost:5432/testdb")
  })

  test("encodes multiple special characters", () => {
    const input = "postgresql://testuser:t@st#v:al@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:t%40st%23v%3Aal@localhost:5432/testdb")
  })

  test("encodes / in password", () => {
    const input = "postgresql://testuser:test/val@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:test%2Fval@localhost:5432/testdb")
  })

  test("encodes ? in password", () => {
    const input = "postgresql://testuser:test?val@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:test%3Fval@localhost:5432/testdb")
  })

  test("handles malformed percent sequence in username gracefully", () => {
    const input = "postgresql://bad%ZZuser:t@st@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    // Should not throw — falls back to encoding the raw username
    expect(result).toContain("@localhost:5432/testdb")
  })

  test("leaves already-encoded passwords untouched", () => {
    const input = "postgresql://testuser:t%40st%23val@localhost:5432/testdb"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("leaves passwords without special characters untouched", () => {
    const input = "postgresql://testuser:simpletestval@localhost:5432/testdb"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("leaves non-URI strings untouched", () => {
    const input = "host=localhost dbname=mydb"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("handles mongodb scheme", () => {
    const input = "mongodb://testuser:t@st@localhost:27017/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("mongodb://testuser:t%40st@localhost:27017/testdb")
  })

  test("handles mongodb+srv scheme", () => {
    const input = "mongodb+srv://testuser:t@st@cluster.example.com/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("mongodb+srv://testuser:t%40st@cluster.example.com/testdb")
  })

  test("leaves URIs without password untouched", () => {
    const input = "postgresql://testuser@localhost:5432/testdb"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("preserves @ in query string (does not misinterpret as userinfo)", () => {
    const input =
      "postgresql://testuser:simpleval@localhost:5432/testdb?contact=alice@example.com"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("bails on ambiguous URIs where both password and query contain @", () => {
    // When both the password and the query string contain unencoded '@',
    // there's no way to deterministically pick the userinfo separator.
    // We return the URI untouched and expect the caller to pre-encode.
    const input =
      "postgresql://testuser:p@ss@localhost:5432/testdb?contact=alice@example.com"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("encodes @ in username-only userinfo (no password)", () => {
    // Email-as-username with no password: the '@' in the email must be
    // encoded so the driver doesn't treat the domain as the host.
    const input = "postgresql://alice@example.com@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe(
      "postgresql://alice%40example.com@localhost:5432/testdb",
    )
  })

  test("encodes @ in partially-encoded password (not short-circuited by %XX)", () => {
    // Password contains an encoded space (%20) AND a raw '@'. Previous
    // logic short-circuited on seeing %XX and left '@' unencoded,
    // producing a broken URI.
    const input = "postgresql://testuser:p%20ss@word@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe(
      "postgresql://testuser:p%20ss%40word@localhost:5432/testdb",
    )
  })

  test("encodes # in partially-encoded password", () => {
    const input = "postgresql://testuser:pa%40ss#word@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    // %40 is preserved; raw '#' gets encoded to %23
    expect(result).toBe(
      "postgresql://testuser:pa%40ss%23word@localhost:5432/testdb",
    )
  })

  test("handles malformed percent sequence in password gracefully", () => {
    // '%ZZ' is not a valid percent-escape. Falls back to encoding raw.
    const input = "postgresql://testuser:bad%ZZpass@localhost:5432/testdb"
    const result = sanitizeConnectionString(input)
    // Raw-encoded password contains %25 (encoded '%') and ZZ literal
    expect(result).toBe(
      "postgresql://testuser:bad%25ZZpass@localhost:5432/testdb",
    )
  })

  test("preserves @ in path after authority", () => {
    // A path segment with '@' is unusual but valid and must not be
    // treated as userinfo.
    const input = "postgresql://testuser:simpleval@localhost:5432/db@archive"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("preserves @ in fragment", () => {
    const input = "postgresql://testuser:simpleval@localhost:5432/testdb#at@frag"
    expect(sanitizeConnectionString(input)).toBe(input)
  })

  test("handles scheme-only URI with no path", () => {
    const input = "postgresql://testuser:p@ss@localhost:5432"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:p%40ss@localhost:5432")
  })

  test("handles URI with no port", () => {
    const input = "postgresql://testuser:p@ss@localhost/testdb"
    const result = sanitizeConnectionString(input)
    expect(result).toBe("postgresql://testuser:p%40ss@localhost/testdb")
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — connection_string sanitization integration
// ---------------------------------------------------------------------------

describe("normalizeConfig — connection_string sanitization", () => {
  test("sanitizes connection_string with special chars in password", () => {
    const result = normalizeConfig({
      type: "postgres",
      connection_string: "postgresql://testuser:f@ke#PLACEHOLDER@localhost:5432/testdb",
    })
    expect(result.connection_string).toBe(
      "postgresql://testuser:f%40ke%23PLACEHOLDER@localhost:5432/testdb",
    )
  })

  test("sanitizes connectionString alias with special chars", () => {
    const result = normalizeConfig({
      type: "postgres",
      connectionString: "postgresql://testuser:t@st@localhost:5432/testdb",
    })
    // alias resolved to connection_string, then sanitized
    expect(result.connection_string).toBe(
      "postgresql://testuser:t%40st@localhost:5432/testdb",
    )
    expect(result.connectionString).toBeUndefined()
  })

  test("does not alter connection_string without special chars", () => {
    const result = normalizeConfig({
      type: "redshift",
      connection_string: "postgresql://testuser:testval@localhost:5439/testdb",
    })
    expect(result.connection_string).toBe(
      "postgresql://testuser:testval@localhost:5439/testdb",
    )
  })

  test("does not alter config without connection_string", () => {
    const result = normalizeConfig({
      type: "postgres",
      host: "localhost",
      password: "f@ke#PLACEHOLDER",
    })
    // Individual fields are NOT URI-encoded — drivers handle them natively
    expect(result.password).toBe("f@ke#PLACEHOLDER")
    expect(result.connection_string).toBeUndefined()
  })
})

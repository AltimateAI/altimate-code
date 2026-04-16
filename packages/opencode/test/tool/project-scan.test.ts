// @ts-nocheck
import { describe, expect, test, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import path from "path"
import os from "os"
import fsp from "fs/promises"

import {
  detectGit,
  detectDbtProject,
  detectEnvVars,
  detectDataTools,
  detectConfigFiles,
  parseToolVersion,
  DATA_TOOL_NAMES,
  type GitInfo,
  type DbtProjectInfo,
  type EnvVarConnection,
  type DataToolInfo,
  type ConfigFileInfo,
} from "../../src/altimate/tools/project-scan"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpRoot = path.join(
  os.tmpdir(),
  "project-scan-test-" + process.pid + "-" + Math.random().toString(36).slice(2),
)

let tmpCounter = 0
function nextTmpDir(): string {
  return path.join(tmpRoot, String(++tmpCounter))
}

async function createFile(filePath: string, content = "") {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, content)
}

// ---------------------------------------------------------------------------
// detectGit
// ---------------------------------------------------------------------------

describe("detectGit", () => {
  // Cache the result for tests that run against the current repo
  let currentRepoResult: GitInfo

  beforeAll(async () => {
    currentRepoResult = await detectGit()
  })

  test("detects a git repository in the current repo", () => {
    expect(currentRepoResult.isRepo).toBe(true)
  })

  test("branch is a non-empty string or undefined (detached HEAD)", () => {
    // In CI, GitHub Actions checks out in detached HEAD → branch is undefined
    // Locally, branch is a non-empty string
    if (currentRepoResult.branch !== undefined) {
      expect(typeof currentRepoResult.branch).toBe("string")
      expect(currentRepoResult.branch.length).toBeGreaterThan(0)
    }
  })

  test("returns a remote URL when origin exists", () => {
    // The altimate-code repo should have an origin remote
    expect(currentRepoResult.remoteUrl).toBeDefined()
    expect(currentRepoResult.remoteUrl!.length).toBeGreaterThan(0)
  })

  test("returns isRepo true for an initialized git directory", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })

    // Initialize a fresh git repo
    Bun.spawnSync(["git", "init", dir], { stdout: "pipe", stderr: "pipe" })

    // Save and change cwd so detectGit runs in the temp dir
    const originalCwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await detectGit()
      expect(result.isRepo).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("returns no remote for a fresh git repo with no origin", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })
    Bun.spawnSync(["git", "init", dir], { stdout: "pipe", stderr: "pipe" })

    const originalCwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await detectGit()
      expect(result.isRepo).toBe(true)
      expect(result.remoteUrl).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("returns isRepo false for a non-git directory", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })

    const originalCwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await detectGit()
      expect(result.isRepo).toBe(false)
      expect(result.branch).toBeUndefined()
      expect(result.remoteUrl).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
    }
  })

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// detectDbtProject
// ---------------------------------------------------------------------------

describe("detectDbtProject", () => {
  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("finds dbt_project.yml in the current directory", async () => {
    const dir = nextTmpDir()
    await createFile(
      path.join(dir, "dbt_project.yml"),
      "name: my_project\nprofile: my_profile\n",
    )

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.path).toBe(dir)
    expect(result.name).toBe("my_project")
    expect(result.profile).toBe("my_profile")
  })

  test("finds dbt_project.yml in a parent directory", async () => {
    const rootDir = nextTmpDir()
    const childDir = path.join(rootDir, "models", "staging")
    await fsp.mkdir(childDir, { recursive: true })
    await createFile(
      path.join(rootDir, "dbt_project.yml"),
      "name: parent_proj\nprofile: parent_prof\n",
    )

    const result = await detectDbtProject(childDir)
    expect(result.found).toBe(true)
    expect(result.path).toBe(rootDir)
    expect(result.name).toBe("parent_proj")
  })

  test("finds dbt_project.yml in a grandparent directory", async () => {
    const rootDir = nextTmpDir()
    const deepDir = path.join(rootDir, "a", "b", "c")
    await fsp.mkdir(deepDir, { recursive: true })
    await createFile(
      path.join(rootDir, "dbt_project.yml"),
      "name: deep_proj\nprofile: deep_prof\n",
    )

    const result = await detectDbtProject(deepDir)
    expect(result.found).toBe(true)
    expect(result.path).toBe(rootDir)
    expect(result.name).toBe("deep_proj")
  })

  test("does not search beyond 5 levels", async () => {
    const rootDir = nextTmpDir()
    // Create directory 6 levels deep
    const deepDir = path.join(rootDir, "a", "b", "c", "d", "e", "f")
    await fsp.mkdir(deepDir, { recursive: true })
    await createFile(
      path.join(rootDir, "dbt_project.yml"),
      "name: too_far\nprofile: too_far_prof\n",
    )

    const result = await detectDbtProject(deepDir)
    expect(result.found).toBe(false)
  })

  test("returns found false when no dbt_project.yml exists", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.name).toBeUndefined()
    expect(result.profile).toBeUndefined()
  })

  test("extracts name and profile from dbt_project.yml", async () => {
    const dir = nextTmpDir()
    await createFile(
      path.join(dir, "dbt_project.yml"),
      "name: 'analytics'\nversion: '1.0'\nprofile: 'warehouse_prod'\n",
    )

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.name).toBe("analytics")
    expect(result.profile).toBe("warehouse_prod")
  })

  test("handles quoted name and profile values", async () => {
    const dir = nextTmpDir()
    await createFile(
      path.join(dir, "dbt_project.yml"),
      'name: "quoted_name"\nprofile: "quoted_profile"\n',
    )

    const result = await detectDbtProject(dir)
    expect(result.name).toBe("quoted_name")
    expect(result.profile).toBe("quoted_profile")
  })

  test("detects manifest.json in target directory", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, "dbt_project.yml"), "name: proj\n")
    await createFile(path.join(dir, "target", "manifest.json"), "{}")

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.manifestPath).toBe(path.join(dir, "target", "manifest.json"))
  })

  test("manifestPath is undefined when no manifest exists", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, "dbt_project.yml"), "name: proj\n")

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.manifestPath).toBeUndefined()
  })

  test("detects packages.yml", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, "dbt_project.yml"), "name: proj\n")
    await createFile(path.join(dir, "packages.yml"), "packages:\n  - package: dbt-labs/dbt_utils\n")

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.hasPackages).toBe(true)
  })

  test("detects dependencies.yml as packages", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, "dbt_project.yml"), "name: proj\n")
    await createFile(path.join(dir, "dependencies.yml"), "packages:\n  - package: foo\n")

    const result = await detectDbtProject(dir)
    expect(result.hasPackages).toBe(true)
  })

  test("hasPackages is false when neither packages.yml nor dependencies.yml exist", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, "dbt_project.yml"), "name: proj\n")

    const result = await detectDbtProject(dir)
    expect(result.hasPackages).toBe(false)
  })

  test("handles malformed dbt_project.yml with no name or profile", async () => {
    const dir = nextTmpDir()
    await createFile(
      path.join(dir, "dbt_project.yml"),
      "version: 1.0\nconfig-version: 2\n",
    )

    const result = await detectDbtProject(dir)
    expect(result.found).toBe(true)
    expect(result.name).toBeUndefined()
    expect(result.profile).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectEnvVars
// ---------------------------------------------------------------------------

describe("detectEnvVars", () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = savedEnv
  })

  // Helper to clear all warehouse-related env vars
  function clearWarehouseEnvVars() {
    const vars = [
      "SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD",
      "SNOWFLAKE_WAREHOUSE", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA", "SNOWFLAKE_ROLE",
      "GOOGLE_APPLICATION_CREDENTIALS", "BIGQUERY_PROJECT", "GCP_PROJECT", "BIGQUERY_LOCATION",
      "DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME", "DATABRICKS_HTTP_PATH", "DATABRICKS_TOKEN",
      "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "DATABASE_URL",
      "MYSQL_HOST", "MYSQL_TCP_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD",
      "REDSHIFT_HOST", "REDSHIFT_PORT", "REDSHIFT_DATABASE", "REDSHIFT_USER", "REDSHIFT_PASSWORD",
      "CLICKHOUSE_HOST", "CLICKHOUSE_URL", "CLICKHOUSE_PORT", "CLICKHOUSE_DB",
      "CLICKHOUSE_DATABASE", "CLICKHOUSE_USER", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD",
    ]
    for (const v of vars) {
      delete process.env[v]
    }
  }

  test("returns empty array when no env vars are set", async () => {
    clearWarehouseEnvVars()
    const result = await detectEnvVars()
    expect(result).toEqual([])
  })

  test("detects Snowflake via SNOWFLAKE_ACCOUNT", async () => {
    clearWarehouseEnvVars()
    process.env.SNOWFLAKE_ACCOUNT = "my_account"
    process.env.SNOWFLAKE_USER = "admin"
    process.env.SNOWFLAKE_DATABASE = "analytics"

    const result = await detectEnvVars()
    const sf = result.find((r) => r.type === "snowflake")
    expect(sf).toBeDefined()
    expect(sf!.name).toBe("env_snowflake")
    expect(sf!.source).toBe("env-var")
    expect(sf!.signal).toBe("SNOWFLAKE_ACCOUNT")
    expect(sf!.config.account).toBe("my_account")
    expect(sf!.config.user).toBe("admin")
    expect(sf!.config.database).toBe("analytics")
  })

  test("detects BigQuery via GOOGLE_APPLICATION_CREDENTIALS", async () => {
    clearWarehouseEnvVars()
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/to/creds.json"

    const result = await detectEnvVars()
    const bq = result.find((r) => r.type === "bigquery")
    expect(bq).toBeDefined()
    expect(bq!.signal).toBe("GOOGLE_APPLICATION_CREDENTIALS")
    expect(bq!.config.credentials_path).toBe("/path/to/creds.json")
  })

  test("detects BigQuery via BIGQUERY_PROJECT", async () => {
    clearWarehouseEnvVars()
    process.env.BIGQUERY_PROJECT = "my-gcp-project"

    const result = await detectEnvVars()
    const bq = result.find((r) => r.type === "bigquery")
    expect(bq).toBeDefined()
    expect(bq!.signal).toBe("BIGQUERY_PROJECT")
    expect(bq!.config.project).toBe("my-gcp-project")
  })

  test("detects BigQuery via GCP_PROJECT when BIGQUERY_PROJECT is not set", async () => {
    clearWarehouseEnvVars()
    process.env.GCP_PROJECT = "fallback-project"

    const result = await detectEnvVars()
    const bq = result.find((r) => r.type === "bigquery")
    expect(bq).toBeDefined()
    expect(bq!.signal).toBe("GCP_PROJECT")
    expect(bq!.config.project).toBe("fallback-project")
  })

  test("detects Databricks via DATABRICKS_HOST", async () => {
    clearWarehouseEnvVars()
    process.env.DATABRICKS_HOST = "adb-1234.cloud.databricks.com"
    process.env.DATABRICKS_TOKEN = "dapi123456"
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/warehouses/abc"

    const result = await detectEnvVars()
    const db = result.find((r) => r.type === "databricks")
    expect(db).toBeDefined()
    expect(db!.signal).toBe("DATABRICKS_HOST")
    expect(db!.config.server_hostname).toBe("adb-1234.cloud.databricks.com")
    expect(db!.config.access_token).toBe("***")
    expect(db!.config.http_path).toBe("/sql/1.0/warehouses/abc")
  })

  test("prefers DATABRICKS_HOST over DATABRICKS_SERVER_HOSTNAME for signal", async () => {
    clearWarehouseEnvVars()
    process.env.DATABRICKS_HOST = "primary.databricks.com"
    process.env.DATABRICKS_SERVER_HOSTNAME = "secondary.databricks.com"

    const result = await detectEnvVars()
    const db = result.find((r) => r.type === "databricks")
    expect(db).toBeDefined()
    expect(db!.signal).toBe("DATABRICKS_HOST")
    // server_hostname configMap entry uses [DATABRICKS_HOST, DATABRICKS_SERVER_HOSTNAME],
    // so it should prefer DATABRICKS_HOST
    expect(db!.config.server_hostname).toBe("primary.databricks.com")
  })

  test("detects Databricks via DATABRICKS_SERVER_HOSTNAME when DATABRICKS_HOST is absent", async () => {
    clearWarehouseEnvVars()
    process.env.DATABRICKS_SERVER_HOSTNAME = "alt.databricks.com"

    const result = await detectEnvVars()
    const db = result.find((r) => r.type === "databricks")
    expect(db).toBeDefined()
    expect(db!.signal).toBe("DATABRICKS_SERVER_HOSTNAME")
    expect(db!.config.server_hostname).toBe("alt.databricks.com")
  })

  test("detects Postgres via PGHOST", async () => {
    clearWarehouseEnvVars()
    process.env.PGHOST = "localhost"
    process.env.PGPORT = "5432"
    process.env.PGDATABASE = "mydb"
    process.env.PGUSER = "pgadmin"

    const result = await detectEnvVars()
    const pg = result.find((r) => r.type === "postgres")
    expect(pg).toBeDefined()
    expect(pg!.signal).toBe("PGHOST")
    expect(pg!.config.host).toBe("localhost")
    expect(pg!.config.port).toBe("5432")
    expect(pg!.config.database).toBe("mydb")
    expect(pg!.config.user).toBe("pgadmin")
  })

  test("detects Postgres via DATABASE_URL scheme", async () => {
    clearWarehouseEnvVars()
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db"

    const result = await detectEnvVars()
    const pg = result.find((r) => r.type === "postgres")
    expect(pg).toBeDefined()
    expect(pg!.signal).toBe("DATABASE_URL")
    expect(pg!.config.connection_string).toBe("***")
  })

  test("detects MySQL via DATABASE_URL with mysql scheme", async () => {
    clearWarehouseEnvVars()
    process.env.DATABASE_URL = "mysql://user:pass@host:3306/db"

    const result = await detectEnvVars()
    const my = result.find((r) => r.type === "mysql")
    expect(my).toBeDefined()
    expect(my!.signal).toBe("DATABASE_URL")
  })

  test("DATABASE_URL does not duplicate when type already detected", async () => {
    clearWarehouseEnvVars()
    process.env.PGHOST = "localhost"
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db"

    const result = await detectEnvVars()
    const pgConns = result.filter((r) => r.type === "postgres")
    expect(pgConns.length).toBe(1)
    expect(pgConns[0].signal).toBe("PGHOST")
  })

  test("detects MySQL via MYSQL_HOST", async () => {
    clearWarehouseEnvVars()
    process.env.MYSQL_HOST = "mysql.example.com"
    process.env.MYSQL_DATABASE = "shop"

    const result = await detectEnvVars()
    const my = result.find((r) => r.type === "mysql")
    expect(my).toBeDefined()
    expect(my!.signal).toBe("MYSQL_HOST")
    expect(my!.config.host).toBe("mysql.example.com")
    expect(my!.config.database).toBe("shop")
  })

  test("detects MySQL via MYSQL_DATABASE alone", async () => {
    clearWarehouseEnvVars()
    process.env.MYSQL_DATABASE = "testdb"

    const result = await detectEnvVars()
    const my = result.find((r) => r.type === "mysql")
    expect(my).toBeDefined()
    expect(my!.signal).toBe("MYSQL_DATABASE")
    expect(my!.config.database).toBe("testdb")
  })

  test("detects Redshift via REDSHIFT_HOST", async () => {
    clearWarehouseEnvVars()
    process.env.REDSHIFT_HOST = "redshift-cluster.abc.us-east-1.redshift.amazonaws.com"
    process.env.REDSHIFT_DATABASE = "warehouse"
    process.env.REDSHIFT_USER = "admin"

    const result = await detectEnvVars()
    const rs = result.find((r) => r.type === "redshift")
    expect(rs).toBeDefined()
    expect(rs!.signal).toBe("REDSHIFT_HOST")
    expect(rs!.config.host).toBe("redshift-cluster.abc.us-east-1.redshift.amazonaws.com")
    expect(rs!.config.database).toBe("warehouse")
    expect(rs!.config.user).toBe("admin")
  })

  test("detects ClickHouse via CLICKHOUSE_HOST", async () => {
    clearWarehouseEnvVars()
    process.env.CLICKHOUSE_HOST = "clickhouse.example.com"
    process.env.CLICKHOUSE_PORT = "8443"
    process.env.CLICKHOUSE_DATABASE = "analytics"
    process.env.CLICKHOUSE_USER = "default"
    process.env.CLICKHOUSE_PASSWORD = "secret"

    const result = await detectEnvVars()
    const ch = result.find((r) => r.type === "clickhouse")
    expect(ch).toBeDefined()
    expect(ch!.name).toBe("env_clickhouse")
    expect(ch!.source).toBe("env-var")
    expect(ch!.signal).toBe("CLICKHOUSE_HOST")
    expect(ch!.config.host).toBe("clickhouse.example.com")
    expect(ch!.config.port).toBe("8443")
    expect(ch!.config.database).toBe("analytics")
    expect(ch!.config.user).toBe("default")
    expect(ch!.config.password).toBe("***")
  })

  test("detects ClickHouse via CLICKHOUSE_URL", async () => {
    clearWarehouseEnvVars()
    process.env.CLICKHOUSE_URL = "https://clickhouse.example.com:8443"

    const result = await detectEnvVars()
    const ch = result.find((r) => r.type === "clickhouse")
    expect(ch).toBeDefined()
    expect(ch!.signal).toBe("CLICKHOUSE_URL")
    expect(ch!.config.connection_string).toBe("***")
  })

  test("detects ClickHouse via DATABASE_URL with clickhouse scheme", async () => {
    clearWarehouseEnvVars()
    process.env.DATABASE_URL = "clickhouse://default:pass@clickhouse.example.com:8443/analytics"

    const result = await detectEnvVars()
    const ch = result.find((r) => r.type === "clickhouse")
    expect(ch).toBeDefined()
    expect(ch!.signal).toBe("DATABASE_URL")
    expect(ch!.config.connection_string).toBe("***")
  })

  test("detects ClickHouse via DATABASE_URL with clickhouse+http and clickhouse+https schemes", async () => {
    for (const scheme of ["clickhouse+http", "clickhouse+https"]) {
      clearWarehouseEnvVars()
      process.env.DATABASE_URL = `${scheme}://default:pass@clickhouse.example.com:8443/analytics`

      const result = await detectEnvVars()
      const ch = result.find((r) => r.type === "clickhouse")
      expect(ch).toBeDefined()
      expect(ch!.signal).toBe("DATABASE_URL")
      expect(ch!.type).toBe("clickhouse")
      expect(ch!.config.connection_string).toBe("***")
    }
  })

  test("detects multiple warehouses simultaneously", async () => {
    clearWarehouseEnvVars()
    process.env.SNOWFLAKE_ACCOUNT = "sf_account"
    process.env.PGHOST = "pg_host"
    process.env.MYSQL_HOST = "my_host"

    const result = await detectEnvVars()
    const types = result.map((r) => r.type)
    expect(types).toContain("snowflake")
    expect(types).toContain("postgres")
    expect(types).toContain("mysql")
    expect(result.length).toBe(3)
  })

  test("config only includes keys with actual values", async () => {
    clearWarehouseEnvVars()
    process.env.SNOWFLAKE_ACCOUNT = "my_account"
    // Do NOT set SNOWFLAKE_USER, SNOWFLAKE_PASSWORD, etc.

    const result = await detectEnvVars()
    const sf = result.find((r) => r.type === "snowflake")
    expect(sf).toBeDefined()
    expect(sf!.config.account).toBe("my_account")
    // Keys without env var values should not be present
    expect(sf!.config.user).toBeUndefined()
    expect(sf!.config.password).toBeUndefined()
    expect(sf!.config.warehouse).toBeUndefined()
  })

  test("all connections have source set to env-var", async () => {
    clearWarehouseEnvVars()
    process.env.SNOWFLAKE_ACCOUNT = "acct"
    process.env.PGHOST = "host"

    const result = await detectEnvVars()
    for (const conn of result) {
      expect(conn.source).toBe("env-var")
    }
  })

  test("connection names follow env_ prefix convention", async () => {
    clearWarehouseEnvVars()
    process.env.SNOWFLAKE_ACCOUNT = "acct"
    process.env.DATABRICKS_HOST = "host"
    process.env.REDSHIFT_HOST = "host"

    const result = await detectEnvVars()
    for (const conn of result) {
      expect(conn.name).toMatch(/^env_/)
      expect(conn.name).toBe(`env_${conn.type}`)
    }
  })
})

// ---------------------------------------------------------------------------
// parseToolVersion
// ---------------------------------------------------------------------------

describe("parseToolVersion", () => {
  test("parses standard semver (dbt core output)", () => {
    // dbt --version outputs "installed: 1.8.4" on first line in newer versions
    expect(parseToolVersion("dbt Core - 1.8.4")).toBe("1.8.4")
  })

  test("returns undefined when version is not on first line", () => {
    // parseToolVersion only reads the first line
    expect(parseToolVersion("Core:\n  - installed: 1.8.4")).toBeUndefined()
  })

  test("parses simple version (sqlfluff)", () => {
    expect(parseToolVersion("sqlfluff, version 3.1.0")).toBe("3.1.0")
  })

  test("parses version with prefix text (airflow)", () => {
    expect(parseToolVersion("apache-airflow==2.9.3")).toBe("2.9.3")
  })

  test("parses version at start of line", () => {
    expect(parseToolVersion("1.2.3")).toBe("1.2.3")
  })

  test("parses two-part version", () => {
    expect(parseToolVersion("dagster, version 1.7")).toBe("1.7")
  })

  test("parses four-part version", () => {
    expect(parseToolVersion("tool 1.2.3.4")).toBe("1.2.3.4")
  })

  test("takes first line only", () => {
    expect(parseToolVersion("0.19.2\nsome other output")).toBe("0.19.2")
  })

  test("returns undefined for non-version output", () => {
    expect(parseToolVersion("no version here")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseToolVersion("")).toBeUndefined()
  })

  test("returns undefined for whitespace only", () => {
    expect(parseToolVersion("   \n  ")).toBeUndefined()
  })

  test("handles version embedded in path-like string", () => {
    expect(parseToolVersion("/usr/local/lib/python3.11/site-packages (1.0.3)")).toBe("3.11")
  })

  test("parses great_expectations version output", () => {
    expect(parseToolVersion("great_expectations, version 1.0.3")).toBe("1.0.3")
  })

  test("parses sqlfmt version output", () => {
    expect(parseToolVersion("sqlfmt 0.19.2")).toBe("0.19.2")
  })
})

// ---------------------------------------------------------------------------
// DATA_TOOL_NAMES
// ---------------------------------------------------------------------------

describe("DATA_TOOL_NAMES", () => {
  test("contains all expected tools", () => {
    expect(DATA_TOOL_NAMES).toContain("dbt")
    expect(DATA_TOOL_NAMES).toContain("sqlfluff")
    expect(DATA_TOOL_NAMES).toContain("airflow")
    expect(DATA_TOOL_NAMES).toContain("dagster")
    expect(DATA_TOOL_NAMES).toContain("prefect")
    expect(DATA_TOOL_NAMES).toContain("soda")
    expect(DATA_TOOL_NAMES).toContain("sqlmesh")
    expect(DATA_TOOL_NAMES).toContain("great_expectations")
    expect(DATA_TOOL_NAMES).toContain("sqlfmt")
  })

  test("has exactly 9 tools", () => {
    expect(DATA_TOOL_NAMES.length).toBe(9)
  })

  test("contains no duplicates", () => {
    const unique = new Set(DATA_TOOL_NAMES)
    expect(unique.size).toBe(DATA_TOOL_NAMES.length)
  })
})

// ---------------------------------------------------------------------------
// detectDataTools
// ---------------------------------------------------------------------------

describe("detectDataTools", () => {
  // Cache the expensive detectDataTools(false) result - it spawns 9 subprocesses
  // and the result is deterministic for the duration of the test run
  let cachedResult: DataToolInfo[]

  beforeAll(async () => {
    cachedResult = await detectDataTools(false)
  })

  test("returns empty array when skip is true", async () => {
    const result = await detectDataTools(true)
    expect(result).toEqual([])
  })

  test("skip=true returns empty regardless of environment", async () => {
    const result1 = await detectDataTools(true)
    const result2 = await detectDataTools(true)
    expect(result1).toEqual([])
    expect(result2).toEqual([])
  })

  test("skip=false returns one entry per tool", () => {
    expect(cachedResult.length).toBe(DATA_TOOL_NAMES.length)
    const names = cachedResult.map((t) => t.name)
    for (const toolName of DATA_TOOL_NAMES) {
      expect(names).toContain(toolName)
    }
  })

  test("each entry has correct shape", () => {
    for (const tool of cachedResult) {
      expect(typeof tool.name).toBe("string")
      expect(typeof tool.installed).toBe("boolean")
      if (tool.installed) {
        expect(tool.version === undefined || typeof tool.version === "string").toBe(true)
      }
    }
  })

  test("marks missing tools as not installed", () => {
    // At least some tools should be not-installed on a typical dev machine
    const notInstalled = cachedResult.filter((t) => !t.installed)
    expect(notInstalled.length).toBeGreaterThan(0)
    for (const tool of notInstalled) {
      expect(tool.installed).toBe(false)
    }
  })

  test("installed tools have a parseable version", () => {
    const installed = cachedResult.filter((t) => t.installed)
    for (const tool of installed) {
      // version should be a string matching semver-like pattern
      if (tool.version) {
        expect(tool.version).toMatch(/^\d+\.\d+/)
      }
    }
  })

  test("handles ENOENT gracefully for missing executables", () => {
    // This is validated by the cached result not throwing
    expect(Array.isArray(cachedResult)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// detectConfigFiles
// ---------------------------------------------------------------------------

describe("detectConfigFiles", () => {
  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("returns all false when no config files exist", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })

    const result = await detectConfigFiles(dir)
    expect(result.altimateConfig).toBe(false)
    expect(result.sqlfluff).toBe(false)
    expect(result.preCommit).toBe(false)
  })

  test("detects .opencode/altimate-code.json", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, ".opencode", "altimate-code.json"), "{}")

    const result = await detectConfigFiles(dir)
    expect(result.altimateConfig).toBe(true)
    expect(result.sqlfluff).toBe(false)
    expect(result.preCommit).toBe(false)
  })

  test("detects .sqlfluff", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, ".sqlfluff"), "[sqlfluff]\n")

    const result = await detectConfigFiles(dir)
    expect(result.altimateConfig).toBe(false)
    expect(result.sqlfluff).toBe(true)
    expect(result.preCommit).toBe(false)
  })

  test("detects .pre-commit-config.yaml", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, ".pre-commit-config.yaml"), "repos:\n")

    const result = await detectConfigFiles(dir)
    expect(result.altimateConfig).toBe(false)
    expect(result.sqlfluff).toBe(false)
    expect(result.preCommit).toBe(true)
  })

  test("detects all config files when present", async () => {
    const dir = nextTmpDir()
    await createFile(path.join(dir, ".opencode", "altimate-code.json"), "{}")
    await createFile(path.join(dir, ".sqlfluff"), "")
    await createFile(path.join(dir, ".pre-commit-config.yaml"), "")

    const result = await detectConfigFiles(dir)
    expect(result.altimateConfig).toBe(true)
    expect(result.sqlfluff).toBe(true)
    expect(result.preCommit).toBe(true)
  })

  test("returns correct type shape", async () => {
    const dir = nextTmpDir()
    await fsp.mkdir(dir, { recursive: true })

    const result = await detectConfigFiles(dir)
    expect(typeof result.altimateConfig).toBe("boolean")
    expect(typeof result.sqlfluff).toBe("boolean")
    expect(typeof result.preCommit).toBe("boolean")
    // No extra keys
    const keys = Object.keys(result)
    expect(keys).toEqual(["altimateConfig", "sqlfluff", "preCommit"])
  })
})

// ---------------------------------------------------------------------------
// Integration-style type/shape tests
// ---------------------------------------------------------------------------

describe("return type contracts", () => {
  // Cache detectGit result - it spawns 3 git subprocesses
  let gitResult: GitInfo

  beforeAll(async () => {
    gitResult = await detectGit()
  })

  test("detectGit returns GitInfo shape", () => {
    expect(typeof gitResult.isRepo).toBe("boolean")
    if (gitResult.isRepo) {
      expect(gitResult.branch === undefined || typeof gitResult.branch === "string").toBe(true)
      expect(gitResult.remoteUrl === undefined || typeof gitResult.remoteUrl === "string").toBe(true)
    }
  })

  test("detectDbtProject returns DbtProjectInfo shape", async () => {
    const dir = os.tmpdir()
    const result: DbtProjectInfo = await detectDbtProject(dir)
    expect(typeof result.found).toBe("boolean")
    if (result.found) {
      expect(typeof result.path).toBe("string")
    }
  })

  test("detectEnvVars returns EnvVarConnection[] shape", async () => {
    const result: EnvVarConnection[] = await detectEnvVars()
    expect(Array.isArray(result)).toBe(true)
    for (const conn of result) {
      expect(typeof conn.name).toBe("string")
      expect(typeof conn.type).toBe("string")
      expect(conn.source).toBe("env-var")
      expect(typeof conn.signal).toBe("string")
      expect(typeof conn.config).toBe("object")
    }
  })

  test("detectDataTools returns DataToolInfo[] shape", async () => {
    const result: DataToolInfo[] = await detectDataTools(true)
    expect(Array.isArray(result)).toBe(true)
  })

  test("detectConfigFiles returns ConfigFileInfo shape", async () => {
    const result: ConfigFileInfo = await detectConfigFiles(os.tmpdir())
    expect(typeof result.altimateConfig).toBe("boolean")
    expect(typeof result.sqlfluff).toBe("boolean")
    expect(typeof result.preCommit).toBe("boolean")
  })
})

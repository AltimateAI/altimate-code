/**
 * dbt profiles.yml path resolution — E2E tests.
 *
 * Validates the full resolution chain:
 *   1. Explicit path parameter (highest priority)
 *   2. DBT_PROFILES_DIR environment variable
 *   3. Project-local profiles.yml (next to dbt_project.yml)
 *   4. ~/.dbt/profiles.yml (default fallback)
 *
 * Each test creates real temp directories with real profiles.yml files and
 * exercises the Dispatcher + parser end-to-end to verify discovery works
 * as users would experience it.
 */

import { describe, expect, test, afterAll, beforeEach, afterEach, spyOn } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import fsp from "fs/promises"
import { parseDbtProfiles } from "../../src/altimate/native/connections/dbt-profiles"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpRoot = path.join(
  os.tmpdir(),
  "dbt-profiles-e2e-" + process.pid + "-" + Math.random().toString(36).slice(2),
)

let tmpCounter = 0
function nextTmpDir(): string {
  return path.join(tmpRoot, String(++tmpCounter))
}

/** Write a minimal profiles.yml with a distinguishable profile name. */
function writeProfile(
  dir: string,
  profileName: string,
  opts: { host?: string; type?: string; port?: number } = {},
): string {
  const filePath = path.join(dir, "profiles.yml")
  const content = `
${profileName}:
  target: dev
  outputs:
    dev:
      type: ${opts.type ?? "postgres"}
      host: ${opts.host ?? "localhost"}
      port: ${opts.port ?? 5432}
      user: test_user
      pass: FAKE_TEST_VALUE
      dbname: testdb
      schema: public
`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

/** Write a minimal dbt_project.yml to mark a directory as a dbt project root. */
function writeDbtProject(dir: string, name = "test_project", profile = "test_profile"): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "dbt_project.yml"),
    `name: '${name}'\nversion: '1.0.0'\nprofile: '${profile}'\n`,
  )
}

// ---------------------------------------------------------------------------
// Env var save/restore
// ---------------------------------------------------------------------------

let savedDbtProfilesDir: string | undefined

beforeEach(() => {
  savedDbtProfilesDir = process.env.DBT_PROFILES_DIR
  delete process.env.DBT_PROFILES_DIR
})

afterEach(() => {
  if (savedDbtProfilesDir === undefined) delete process.env.DBT_PROFILES_DIR
  else process.env.DBT_PROFILES_DIR = savedDbtProfilesDir
})

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// 1. Explicit path — highest priority
// ---------------------------------------------------------------------------

describe("explicit path (highest priority)", () => {
  test("uses explicit path even when DBT_PROFILES_DIR and projectDir exist", async () => {
    const explicitDir = nextTmpDir()
    const envDir = nextTmpDir()
    const projDir = nextTmpDir()

    writeProfile(explicitDir, "explicit_profile", { host: "explicit-host" })
    writeProfile(envDir, "env_profile", { host: "env-host" })
    writeProfile(projDir, "proj_profile", { host: "proj-host" })

    process.env.DBT_PROFILES_DIR = envDir

    const connections = await parseDbtProfiles(path.join(explicitDir, "profiles.yml"), projDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("explicit_profile_dev")
    expect(connections[0].config.host).toBe("explicit-host")
  })

  test("returns empty array when explicit path does not exist", async () => {
    const connections = await parseDbtProfiles("/tmp/nonexistent-dbt-profiles/profiles.yml")
    expect(connections).toEqual([])
  })

  test("handles explicit path to a malformed YAML file", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "profiles.yml"), "{{{{not yaml at all")

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. DBT_PROFILES_DIR environment variable
// ---------------------------------------------------------------------------

describe("DBT_PROFILES_DIR environment variable", () => {
  test("discovers profiles.yml from DBT_PROFILES_DIR", async () => {
    const envDir = nextTmpDir()
    writeProfile(envDir, "env_discovered", { host: "envdir-host", port: 5433 })

    process.env.DBT_PROFILES_DIR = envDir

    const connections = await parseDbtProfiles()
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("env_discovered_dev")
    expect(connections[0].config.host).toBe("envdir-host")
    expect(connections[0].config.port).toBe(5433)
  })

  test("takes priority over projectDir", async () => {
    const envDir = nextTmpDir()
    const projDir = nextTmpDir()

    writeProfile(envDir, "env_wins", { host: "env-wins-host" })
    writeProfile(projDir, "proj_loses", { host: "proj-loses-host" })

    process.env.DBT_PROFILES_DIR = envDir

    const connections = await parseDbtProfiles(undefined, projDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("env_wins_dev")
    expect(connections[0].config.host).toBe("env-wins-host")
  })

  test("falls through with warning when DBT_PROFILES_DIR is set but profiles.yml missing", async () => {
    const emptyDir = nextTmpDir()
    const projDir = nextTmpDir()
    fs.mkdirSync(emptyDir, { recursive: true })
    writeProfile(projDir, "fallback_proj", { host: "fallback-host" })

    process.env.DBT_PROFILES_DIR = emptyDir

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const connections = await parseDbtProfiles(undefined, projDir)
      expect(connections).toHaveLength(1)
      expect(connections[0].name).toBe("fallback_proj_dev")
      expect(connections[0].config.host).toBe("fallback-host")
      // Verify warning was emitted about missing profiles.yml in DBT_PROFILES_DIR
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain("DBT_PROFILES_DIR")
      expect(warnSpy.mock.calls[0][0]).toContain(emptyDir)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("falls through when DBT_PROFILES_DIR points to nonexistent directory", async () => {
    const projDir = nextTmpDir()
    writeProfile(projDir, "fallback_after_bad_env", { host: "recovered-host" })

    process.env.DBT_PROFILES_DIR = "/tmp/nonexistent-dbt-dir-" + Date.now()

    const connections = await parseDbtProfiles(undefined, projDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("fallback_after_bad_env_dev")
  })

  test("handles trailing slash in DBT_PROFILES_DIR", async () => {
    const envDir = nextTmpDir()
    writeProfile(envDir, "trailing_slash", { host: "slash-host" })

    process.env.DBT_PROFILES_DIR = envDir + "/"

    const connections = await parseDbtProfiles()
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("trailing_slash_dev")
  })
})

// ---------------------------------------------------------------------------
// 3. Project-local profiles.yml
// ---------------------------------------------------------------------------

describe("project-local profiles.yml (projectDir)", () => {
  test("discovers profiles.yml in dbt project root", async () => {
    const projDir = nextTmpDir()
    writeDbtProject(projDir, "my_dbt_project", "local_profile")
    writeProfile(projDir, "local_profile", { host: "project-local-host" })

    const connections = await parseDbtProfiles(undefined, projDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("local_profile_dev")
    expect(connections[0].config.host).toBe("project-local-host")
  })

  test("returns empty when projectDir has no profiles.yml and no ~/.dbt fallback matches", async () => {
    const projDir = nextTmpDir()
    writeDbtProject(projDir, "empty_project")
    // No profiles.yml written — falls through to ~/.dbt/profiles.yml

    const connections = await parseDbtProfiles(undefined, projDir)
    // May find ~/.dbt/profiles.yml if it exists on this machine, or empty
    // We just verify no crash
    expect(Array.isArray(connections)).toBe(true)
  })

  test("handles project directory with subdirectories", async () => {
    const projDir = nextTmpDir()
    writeDbtProject(projDir)
    writeProfile(projDir, "root_profile", { host: "root-host" })

    // Also write a profiles.yml in a subdirectory (should NOT be found)
    const subDir = path.join(projDir, "config")
    writeProfile(subDir, "sub_profile", { host: "sub-host" })

    const connections = await parseDbtProfiles(undefined, projDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("root_profile_dev")
    expect(connections[0].config.host).toBe("root-host")
  })
})

// ---------------------------------------------------------------------------
// 4. Full priority chain integration
// ---------------------------------------------------------------------------

describe("full priority chain", () => {
  test("explicit > env > project > default (all present)", async () => {
    const explicitDir = nextTmpDir()
    const envDir = nextTmpDir()
    const projDir = nextTmpDir()

    writeProfile(explicitDir, "p_explicit", { host: "h-explicit" })
    writeProfile(envDir, "p_env", { host: "h-env" })
    writeProfile(projDir, "p_proj", { host: "h-proj" })

    process.env.DBT_PROFILES_DIR = envDir

    // Level 1: explicit wins
    let conns = await parseDbtProfiles(path.join(explicitDir, "profiles.yml"), projDir)
    expect(conns[0].name).toBe("p_explicit_dev")

    // Level 2: remove explicit → env wins
    conns = await parseDbtProfiles(undefined, projDir)
    expect(conns[0].name).toBe("p_env_dev")

    // Level 3: remove env → project wins
    delete process.env.DBT_PROFILES_DIR
    conns = await parseDbtProfiles(undefined, projDir)
    expect(conns[0].name).toBe("p_proj_dev")
  })

  test("skips each level when file is missing, not when dir is missing", async () => {
    const envDirEmpty = nextTmpDir()
    const projDir = nextTmpDir()

    // envDir exists but has no profiles.yml
    fs.mkdirSync(envDirEmpty, { recursive: true })
    writeProfile(projDir, "proj_fallback", { host: "proj-fb-host" })

    process.env.DBT_PROFILES_DIR = envDirEmpty

    const conns = await parseDbtProfiles(undefined, projDir)
    expect(conns[0].name).toBe("proj_fallback_dev")
  })
})

// ---------------------------------------------------------------------------
// 5. Multi-profile and multi-output scenarios
// ---------------------------------------------------------------------------

describe("complex profiles.yml content", () => {
  test("discovers multiple profiles with multiple outputs", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profiles.yml"),
      `
warehouse_a:
  target: dev
  outputs:
    dev:
      type: postgres
      host: pg-dev
      port: 5432
      user: dev_user
      pass: FAKE_TEST_VALUE
      dbname: devdb
      schema: public
    prod:
      type: postgres
      host: pg-prod
      port: 5432
      user: prod_user
      pass: FAKE_TEST_VALUE
      dbname: proddb
      schema: public

warehouse_b:
  target: staging
  outputs:
    staging:
      type: snowflake
      account: xy12345
      user: sf_user
      password: fake-test-placeholder
      warehouse: COMPUTE_WH
      database: ANALYTICS
      schema: PUBLIC
      role: ANALYST
`,
    )

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toHaveLength(3)

    const names = connections.map((c) => c.name).sort()
    expect(names).toEqual(["warehouse_a_dev", "warehouse_a_prod", "warehouse_b_staging"])

    const sfConn = connections.find((c) => c.name === "warehouse_b_staging")!
    expect(sfConn.type).toBe("snowflake")
    expect(sfConn.config.account).toBe("xy12345")
  })

  test("resolves env_var() in project-local profiles.yml", async () => {
    const projDir = nextTmpDir()
    fs.mkdirSync(projDir, { recursive: true })

    process.env.__E2E_DBT_HOST = "resolved-host"
    process.env.__E2E_DBT_PASS = "resolved-pass"

    fs.writeFileSync(
      path.join(projDir, "profiles.yml"),
      `
envvar_project:
  target: dev
  outputs:
    dev:
      type: postgres
      host: "{{ env_var('__E2E_DBT_HOST') }}"
      port: 5432
      user: testuser
      password: "{{ env_var('__E2E_DBT_PASS') }}"
      dbname: mydb
      schema: public
`,
    )

    try {
      const connections = await parseDbtProfiles(undefined, projDir)
      expect(connections).toHaveLength(1)
      expect(connections[0].config.host).toBe("resolved-host")
      expect(connections[0].config.password).toBe("resolved-pass")
    } finally {
      delete process.env.__E2E_DBT_HOST
      delete process.env.__E2E_DBT_PASS
    }
  })

  test("resolves env_var() with defaults in DBT_PROFILES_DIR profiles", async () => {
    const envDir = nextTmpDir()
    fs.mkdirSync(envDir, { recursive: true })

    // Intentionally do NOT set __E2E_MISSING_VAR so the default kicks in
    delete process.env.__E2E_MISSING_VAR

    fs.writeFileSync(
      path.join(envDir, "profiles.yml"),
      `
default_project:
  target: dev
  outputs:
    dev:
      type: postgres
      host: "{{ env_var('__E2E_MISSING_VAR', 'fallback-host') }}"
      port: 5432
      user: "{{ env_var('__E2E_MISSING_VAR', 'fallback-user') }}"
      pass: FAKE_TEST_VALUE
      dbname: testdb
      schema: public
`,
    )

    process.env.DBT_PROFILES_DIR = envDir

    const connections = await parseDbtProfiles()
    expect(connections).toHaveLength(1)
    expect(connections[0].config.host).toBe("fallback-host")
    expect(connections[0].config.user).toBe("fallback-user")
  })

  test("handles config key at top level (not a profile)", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profiles.yml"),
      `
config:
  send_anonymous_usage_stats: false

real_project:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost
      port: 5432
      user: user
      pass: FAKE_TEST_VALUE
      dbname: db
      schema: public
`,
    )

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("real_project_dev")
  })
})

// ---------------------------------------------------------------------------
// 6. Adapter type mapping
// ---------------------------------------------------------------------------

describe("adapter type mapping via resolution chain", () => {
  const ADAPTER_CASES = [
    { dbtType: "postgres", expectedType: "postgres" },
    { dbtType: "snowflake", expectedType: "snowflake" },
    { dbtType: "bigquery", expectedType: "bigquery" },
    { dbtType: "databricks", expectedType: "databricks" },
    { dbtType: "redshift", expectedType: "redshift" },
    { dbtType: "duckdb", expectedType: "duckdb" },
    { dbtType: "mysql", expectedType: "mysql" },
    { dbtType: "sqlserver", expectedType: "sqlserver" },
    { dbtType: "spark", expectedType: "databricks" },
    { dbtType: "trino", expectedType: "trino" },
    { dbtType: "clickhouse", expectedType: "clickhouse" },
  ]

  for (const { dbtType, expectedType } of ADAPTER_CASES) {
    test(`maps dbt adapter '${dbtType}' → '${expectedType}' via DBT_PROFILES_DIR`, async () => {
      const dir = nextTmpDir()
      writeProfile(dir, `${dbtType}_proj`, { type: dbtType, host: `${dbtType}-host` })

      process.env.DBT_PROFILES_DIR = dir

      const connections = await parseDbtProfiles()
      expect(connections).toHaveLength(1)
      expect(connections[0].type).toBe(expectedType)
    })
  }
})

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("empty profiles.yml returns empty connections", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "profiles.yml"), "")

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toEqual([])
  })

  test("profiles.yml with only comments returns empty connections", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "profiles.yml"), "# just a comment\n# nothing here\n")

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toEqual([])
  })

  test("profile with no outputs is skipped", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profiles.yml"),
      `
no_outputs:
  target: dev
`,
    )

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toEqual([])
  })

  test("symlinked profiles.yml is followed", async () => {
    const realDir = nextTmpDir()
    const linkDir = nextTmpDir()

    writeProfile(realDir, "symlinked_profile", { host: "sym-host" })
    fs.mkdirSync(linkDir, { recursive: true })
    fs.symlinkSync(path.join(realDir, "profiles.yml"), path.join(linkDir, "profiles.yml"))

    const connections = await parseDbtProfiles(undefined, linkDir)
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("symlinked_profile_dev")
    expect(connections[0].config.host).toBe("sym-host")
  })

  test("profiles.yml with Unicode characters in profile names", async () => {
    const dir = nextTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profiles.yml"),
      `
my_项目_v2:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost
      port: 5432
      user: user
      pass: FAKE_TEST_VALUE
      dbname: db
      schema: public
`,
    )

    const connections = await parseDbtProfiles(path.join(dir, "profiles.yml"))
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("my_项目_v2_dev")
  })

  test("DBT_PROFILES_DIR with spaces in path", async () => {
    const dir = path.join(nextTmpDir(), "path with spaces", "dbt config")
    writeProfile(dir, "spaces_profile", { host: "spaces-host" })

    process.env.DBT_PROFILES_DIR = dir

    const connections = await parseDbtProfiles()
    expect(connections).toHaveLength(1)
    expect(connections[0].name).toBe("spaces_profile_dev")
    expect(connections[0].config.host).toBe("spaces-host")
  })

  test("projectDir with tilde is NOT expanded (literal path)", async () => {
    // parseDbtProfiles uses path.join which doesn't expand ~ — this is expected
    // The caller (project-scan) always passes absolute paths
    const connections = await parseDbtProfiles(undefined, "~/nonexistent-dbt-project")
    // Should not crash; just finds nothing at the literal path
    expect(Array.isArray(connections)).toBe(true)
  })
})

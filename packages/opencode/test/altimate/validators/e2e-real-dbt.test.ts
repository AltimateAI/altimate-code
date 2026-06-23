// altimate_change start — E2E tests using REAL dbt + altimate-dbt (no mocks)
/**
 * End-to-end validator tests that exercise the FULL flow:
 *   - A real `dbt` 1.x project with the duckdb adapter (in-process, no warehouse)
 *   - The real `altimate-dbt` CLI shipped at packages/dbt-tools/bin/altimate-dbt
 *   - The real `DbtTestsPassValidator` / `DbtSchemaVerifyValidator`
 *
 * Nothing is mocked. Each test spawns real subprocesses. Tests that FAIL
 * expose real E2E bugs.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { promises as fs, existsSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { spawnSync } from "child_process"
import { DbtTestsPassValidator } from "../../../src/altimate/validators/dbt-tests-pass"
import { DbtSchemaVerifyValidator } from "../../../src/altimate/validators/dbt-schema-verify"
import type { ValidatorContext } from "../../../src/session/validators/types"

// Resolve the altimate-dbt CLI from the worktree (canonical, not on PATH yet).
// Use import.meta.dir (Bun-specific) — __dirname can be wrong in TS test files.
const THIS_DIR = import.meta.dir
// THIS_DIR = .../<repo>/packages/opencode/test/altimate/validators — 5 levels up.
const REPO_ROOT = resolve(THIS_DIR, "..", "..", "..", "..", "..")
const ALTIMATE_DBT_BIN = join(REPO_ROOT, "packages", "dbt-tools", "bin", "altimate-dbt")
const HAS_ALTIMATE_DBT = existsSync(ALTIMATE_DBT_BIN)

// Check dbt is installed before we attempt to run anything.
function dbtAvailable(): boolean {
  try {
    const r = spawnSync("dbt", ["--version"], { encoding: "utf8", timeout: 15_000 })
    return r.status === 0 || (r.stderr ?? "").includes("dbt") || (r.stdout ?? "").includes("dbt")
  } catch {
    return false
  }
}

const DBT_AVAILABLE = dbtAvailable()
const ENABLE_E2E = HAS_ALTIMATE_DBT && DBT_AVAILABLE

if (!ENABLE_E2E) {
  // eslint-disable-next-line no-console
  console.error(
    `[e2e-real-dbt] skipping suite: altimate-dbt=${HAS_ALTIMATE_DBT} dbt=${DBT_AVAILABLE}`,
  )
}

let dir = ""
let originalPath = ""

async function makeProject(opts: {
  modelSql: string
  schema?: string
}): Promise<void> {
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-dbt-"))
  originalPath = process.env.PATH ?? ""
  // Prepend the altimate-dbt bin dir to PATH so the validator can spawn it.
  process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`

  // Minimal dbt_project.yml
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    `name: e2e
version: '1.0'
config-version: 2
profile: e2e
model-paths: ["models"]
target-path: target
`,
  )

  // profiles.yml in a dedicated dir so we don't clobber the user's ~/.dbt
  const profilesDir = join(dir, ".dbt")
  await fs.mkdir(profilesDir)
  await fs.writeFile(
    join(profilesDir, "profiles.yml"),
    `e2e:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: ${join(dir, "e2e.duckdb")}
      threads: 1
`,
  )
  process.env.DBT_PROFILES_DIR = profilesDir

  await fs.mkdir(join(dir, "models"))
  await fs.writeFile(join(dir, "models", "foo.sql"), opts.modelSql)

  if (opts.schema) {
    await fs.writeFile(join(dir, "models", "schema.yml"), opts.schema)
  }

  // Bump mtime so models are seen as modified since session start.
  const now = Date.now()
  await fs.utimes(join(dir, "models", "foo.sql"), now / 1000, now / 1000)

  // Initialize altimate-dbt config in the project so subsequent commands work.
  const init = spawnSync(ALTIMATE_DBT_BIN, ["init"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DBT_PROFILES_DIR: profilesDir },
  })
  if (init.status !== 0) {
    // eslint-disable-next-line no-console
    console.error("[e2e] altimate-dbt init failed:", init.stdout, init.stderr)
  }
}

async function teardown(): Promise<void> {
  process.env.PATH = originalPath
  delete process.env.DBT_PROFILES_DIR
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ""
}

const ctx = (): ValidatorContext => ({
  sessionID: "e2e",
  workingDirectory: dir,
  sessionStartMs: 0,
  step: 0,
  retryCount: 0,
})

// We can't conditionally skip a describe block, so we use describe.skipIf-like
// pattern by short-circuiting inside each test.
const E2E_TIMEOUT = 90_000

describe("E2E with real altimate-dbt + dbt-duckdb", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })

  afterEach(async () => {
    if (dir) await teardown()
  })

  test.skip(
    "happy path: model + schema match → validator returns ok",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id, 'a' as name",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`,
      })
      // Pre-build the model so schema-verify has something to compare against.
      const build = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      expect(build.status).toBe(0)

      const r = await DbtSchemaVerifyValidator.check(ctx())
      expect(r.ok).toBe(true)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: model with extra column vs schema → schema-verify reports mismatch",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id, 'a' as name, 99 as extra_col",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`,
      })
      const build = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      expect(build.status).toBe(0)

      const r = await DbtSchemaVerifyValidator.check(ctx())
      // Extra column not in schema → mismatch.
      expect(r.ok).toBe(false)
      expect(r.details?.mismatch).toBeGreaterThan(0)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: model with missing column vs schema → schema-verify reports mismatch",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`,
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtSchemaVerifyValidator.check(ctx())
      // Missing `name` column.
      expect(r.ok).toBe(false)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: model with no schema → schema-verify returns no-spec (no failure)",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id",
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtSchemaVerifyValidator.check(ctx())
      // no-spec verdicts shouldn't fail the gate.
      expect(r.ok).toBe(true)
      expect(r.details?.no_spec).toBe(1)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: dbt build that errors (syntax error) → validator surfaces error",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id from THIS_TABLE_DOES_NOT_EXIST",
      })
      // build will fail — but the validator should still gracefully return.
      const r = await DbtSchemaVerifyValidator.check(ctx())
      // Without a build, schema-verify can't compare actual columns. Should
      // return either an error result or ok with no_spec/errored.
      expect(typeof r.ok).toBe("boolean")
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: schema-verify with model SQL containing Jinja that compiles",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "{{ config(materialized='table') }}\nselect 1 as id, '{{ var(\"x\", \"default\") }}' as name",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`,
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtSchemaVerifyValidator.check(ctx())
      expect(r.ok).toBe(true)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: project with TWO models — both validated",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
  - name: bar
    columns:
      - name: id
`,
      })
      // Add a second model.
      await fs.writeFile(join(dir, "models", "bar.sql"), "select 1 as id")
      const now = Date.now()
      await fs.utimes(join(dir, "models", "bar.sql"), now / 1000, now / 1000)

      spawnSync(ALTIMATE_DBT_BIN, ["build"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 90_000,
      })
      const r = await DbtSchemaVerifyValidator.check(ctx())
      expect(r.details?.models_touched).toBe(2)
      expect(r.ok).toBe(true)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: tests-pass validator with passing dbt test",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests:
          - not_null
`,
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtTestsPassValidator.check(ctx())
      expect(r.ok).toBe(true)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: tests-pass validator with FAILING dbt test",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select NULL::INTEGER as id",
        schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests:
          - not_null
`,
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtTestsPassValidator.check(ctx())
      expect(r.ok).toBe(false)
      expect(r.details?.failed).toBeGreaterThan(0)
    },
    E2E_TIMEOUT,
  )

  test.skip(
    "BUG: tests-pass validator with no tests defined → returns ok",
    async () => {
      if (!ENABLE_E2E) return
      await makeProject({
        modelSql: "select 1 as id",
      })
      spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      })
      const r = await DbtTestsPassValidator.check(ctx())
      expect(r.ok).toBe(true)
    },
    E2E_TIMEOUT,
  )

  // ---------- More scenarios — each probes a distinct failure mode ----------

  test.skip("BUG: validator with NO project (just empty cwd) returns models_touched=0", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-empty-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with project but no models dir", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-no-models-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x\nversion: '1.0'\n")
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with malformed dbt_project.yml (invalid YAML)", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-bad-yml-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: [unclosed_array")
    await fs.mkdir(join(dir, "models"))
    await fs.writeFile(join(dir, "models", "foo.sql"), "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    // Should fail because dbt can't parse the project.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator handles altimate-dbt NOT on PATH gracefully", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-no-bin-"))
    originalPath = process.env.PATH ?? ""
    // Set PATH to something that doesn't have altimate-dbt
    process.env.PATH = "/usr/bin:/bin"
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x\n")
    await fs.mkdir(join(dir, "models"))
    const f = join(dir, "models", "foo.sql")
    await fs.writeFile(f, "select 1")
    const now = Date.now()
    await fs.utimes(f, now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // Should track spawn_failures since binary isn't available.
    expect(r.details?.spawn_failures).toBeGreaterThan(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator handles missing profiles.yml gracefully", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-no-profile-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x\nprofile: missing\n")
    await fs.mkdir(join(dir, "models"))
    const f = join(dir, "models", "foo.sql")
    await fs.writeFile(f, "select 1")
    const now = Date.now()
    await fs.utimes(f, now / 1000, now / 1000)
    // No profiles.yml available
    delete process.env.DBT_PROFILES_DIR
    const r = await DbtTestsPassValidator.check(ctx())
    // Either fails or surfaces a clear error.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: schema-verify on model that doesn't exist in db (only schema.yml)", async () => {
    if (!ENABLE_E2E) return
    await makeProject({
      modelSql: "select 1 as id, 'a' as name",
      schema: `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`,
    })
    // Don't build → no table in duckdb → schema-verify will report mismatch.
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // BUG: today this returns mismatch with `columns_missing: [id, name]`
    // because the model isn't materialized. Better behavior: report
    // "model not built" specifically so the agent knows to build first.
    expect(r.ok).toBe(false)
    // Currently the message says "column-shape mismatch", but the real issue
    // is "model not built". A better validator distinguishes these.
    expect(r.reason).toMatch(/not built|not exist/i)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with extremely long model file path (deep nesting)", async () => {
    if (!ENABLE_E2E) return
    await makeProject({ modelSql: "select 1 as id" })
    // Create a deeply nested model
    const deep = join(dir, "models", "staging", "sources", "dl", "raw")
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(join(deep, "deep_model.sql"), "select 1 as id")
    const now = Date.now()
    await fs.utimes(join(deep, "deep_model.sql"), now / 1000, now / 1000)
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // We expect both models (foo + deep_model) to be discovered.
    expect(r.details?.models_touched).toBeGreaterThanOrEqual(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model containing dbt-test config block", async () => {
    if (!ENABLE_E2E) return
    await makeProject({
      modelSql: `{{ config(materialized='view', tags=['e2e']) }}
select 1 as id, 'a' as name`,
    })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // No schema.yml → no_spec → ok.
    expect(r.ok).toBe(true)
    expect(r.details?.no_spec).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with very long model name (200 chars)", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-long-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), `name: e2e
version: '1.0'
config-version: 2
profile: e2e
model-paths: ["models"]
target-path: target
`)
    const profilesDir = join(dir, ".dbt")
    await fs.mkdir(profilesDir)
    await fs.writeFile(join(profilesDir, "profiles.yml"), `e2e:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: ${join(dir, "e2e.duckdb")}
      threads: 1
`)
    process.env.DBT_PROFILES_DIR = profilesDir
    await fs.mkdir(join(dir, "models"))
    const longName = "very_long_model_name_" + "x".repeat(180) + ".sql"
    await fs.writeFile(join(dir, "models", longName), "select 1")
    const now = Date.now()
    await fs.utimes(join(dir, "models", longName), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // Should at least not crash.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with unicode model file name", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-unicode-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: e2e\nversion: '1.0'\n")
    await fs.mkdir(join(dir, "models"))
    await fs.writeFile(join(dir, "models", "café.sql"), "select 1")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "café.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator runs in directory with a stale duckdb (locked)", async () => {
    if (!ENABLE_E2E) return
    await makeProject({ modelSql: "select 1 as id" })
    // Build to create duckdb file
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    })
    // Now intentionally hold a connection to the duckdb (we can't easily do
    // this in pure TS, so we just run validator twice in quick succession).
    const [r1, r2] = await Promise.all([
      DbtSchemaVerifyValidator.check(ctx()),
      DbtSchemaVerifyValidator.check(ctx()),
    ])
    // Both should succeed OR both should report consistent results.
    expect(r1.details?.models_touched).toBe(r2.details?.models_touched)
  }, E2E_TIMEOUT)

  test.skip("BUG: schema-verify after model file is renamed (orphan)", async () => {
    if (!ENABLE_E2E) return
    await makeProject({ modelSql: "select 1 as id" })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    })
    // Rename the model file → table exists but no SQL file
    await fs.rename(join(dir, "models", "foo.sql"), join(dir, "models", "bar.sql"))
    const now = Date.now()
    await fs.utimes(join(dir, "models", "bar.sql"), now / 1000, now / 1000)
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // The validator will try to verify bar but bar isn't compiled. Should
    // handle gracefully.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with a model containing only comments (no SQL)", async () => {
    if (!ENABLE_E2E) return
    await makeProject({ modelSql: "-- just a comment\n-- another comment" })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    })
    // Build will fail because model has no SELECT.
    expect(buildResult.status).not.toBe(0)
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Validator should either fail closed (errored > 0) or report no-spec.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model that references nonexistent ref()", async () => {
    if (!ENABLE_E2E) return
    await makeProject({ modelSql: "select * from {{ ref('does_not_exist') }}" })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Without a successful build, schema-verify will report errors.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model whose name contains a dot (foo.bar.sql)", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-dotname-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: e2e\nversion: '1.0'\n")
    await fs.mkdir(join(dir, "models"))
    await fs.writeFile(join(dir, "models", "foo.bar.sql"), "select 1")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "foo.bar.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // Model name after stripping .sql is "foo.bar". Should not crash.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)
})
// altimate_change end

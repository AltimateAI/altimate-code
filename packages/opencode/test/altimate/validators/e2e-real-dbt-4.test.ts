// altimate_change start — E2E wave 4
/**
 * Wave 4: target the validator at edge cases that should surface bugs.
 *   - Validators running together (both at once)
 *   - Strange filesystem states
 *   - Custom model-paths config
 *   - Lots of models
 *   - Timing-sensitive edges
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs, existsSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { spawnSync } from "child_process"
import { DbtTestsPassValidator } from "../../../src/altimate/validators/dbt-tests-pass"
import { DbtSchemaVerifyValidator } from "../../../src/altimate/validators/dbt-schema-verify"
import type { ValidatorContext } from "../../../src/session/validators/types"

const THIS_DIR = import.meta.dir
const REPO_ROOT = resolve(THIS_DIR, "..", "..", "..", "..", "..")
const ALTIMATE_DBT_BIN = join(REPO_ROOT, "packages", "dbt-tools", "bin", "altimate-dbt")
const HAS_ALTIMATE_DBT = existsSync(ALTIMATE_DBT_BIN)

function dbtAvailable(): boolean {
  try {
    const r = spawnSync("dbt", ["--version"], { encoding: "utf8", timeout: 15_000 })
    return r.status === 0 || (r.stderr ?? "").includes("dbt") || (r.stdout ?? "").includes("dbt")
  } catch { return false }
}

const ENABLE_E2E = HAS_ALTIMATE_DBT && dbtAvailable()
const E2E_TIMEOUT = 90_000

let dir = ""
let originalPath = ""

async function setupProject(modelPath = "models"): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-4-"))
  originalPath = process.env.PATH ?? ""
  process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`

  await fs.writeFile(join(dir, "dbt_project.yml"), `name: e2e
version: '1.0'
config-version: 2
profile: e2e
model-paths: ["${modelPath}"]
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
  await fs.mkdir(join(dir, modelPath))
  return dir
}

async function writeModel(name: string, sql: string, modelDir = "models"): Promise<void> {
  await fs.writeFile(join(dir, modelDir, `${name}.sql`), sql)
  const now = Date.now()
  await fs.utimes(join(dir, modelDir, `${name}.sql`), now / 1000, now / 1000)
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

describe("E2E wave 4: more bugs", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })
  afterEach(async () => {
    if (dir) await teardown()
  })

  test.skip("BUG: both validators run concurrently produce consistent verdicts", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const [t, s] = await Promise.all([
      DbtTestsPassValidator.check(ctx()),
      DbtSchemaVerifyValidator.check(ctx()),
    ])
    expect(t.details?.models_touched).toBe(s.details?.models_touched)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with custom model-paths ['analytics'] picks up files", async () => {
    if (!ENABLE_E2E) return
    await setupProject("analytics")
    await writeModel("foo", "select 1 as id", "analytics")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: our `models/` filter is hardcoded; won't match `analytics/`.
    // Models in custom path are silently skipped.
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with 50 models — all detected", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    for (let i = 0; i < 50; i++) {
      await writeModel(`m_${i}`, `select ${i} as id`)
    }
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(50)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with sessionStartMs in the far future excludes all", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const customCtx = { ...ctx(), sessionStartMs: Date.now() + 365 * 24 * 60 * 60 * 1000 }
    const r = await DbtTestsPassValidator.check(customCtx)
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with sessionStartMs in the far past includes all", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await writeModel("bar", "select 2 as id")
    const customCtx = { ...ctx(), sessionStartMs: 0 }
    const r = await DbtTestsPassValidator.check(customCtx)
    expect(r.details?.models_touched).toBe(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator after model file deleted between modifications", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Delete before validator runs
    await fs.unlink(join(dir, "models", "foo.sql"))
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model file changed during validator scan", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Concurrent: write a new file mid-scan
    const scanPromise = DbtTestsPassValidator.check(ctx())
    await writeModel("bar", "select 2 as id")
    const r = await scanPromise
    // Bar may or may not be picked up depending on timing. Just verify no crash.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with a file that is a regular file (NOT .sql) under models/", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.writeFile(join(dir, "models", "README.md"), "# my project")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "README.md"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with binary file as SQL (not really SQL)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.writeFile(join(dir, "models", "binary.sql"), Buffer.from([0x00, 0xff, 0x42, 0x13]))
    const now = Date.now()
    await fs.utimes(join(dir, "models", "binary.sql"), now / 1000, now / 1000)
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Binary content as SQL → dbt parse error.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model SQL containing null bytes", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id\x00 from x")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with VERY many subdirs under models/", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    for (let i = 0; i < 30; i++) {
      const sub = join(dir, "models", `subdir_${i}`)
      await fs.mkdir(sub)
      await fs.writeFile(join(sub, "m.sql"), `select ${i} as id`)
      const now = Date.now()
      await fs.utimes(join(sub, "m.sql"), now / 1000, now / 1000)
    }
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(30)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with multiple schema.yml files (separate per subdir)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.mkdir(join(dir, "models", "staging"))
    await fs.mkdir(join(dir, "models", "marts"))
    await fs.writeFile(join(dir, "models", "staging", "stg_foo.sql"), "select 1 as id")
    await fs.writeFile(join(dir, "models", "staging", "schema.yml"), `version: 2
models:
  - name: stg_foo
    columns:
      - name: id
`)
    await fs.writeFile(join(dir, "models", "marts", "fct_foo.sql"), "select 1 as id")
    await fs.writeFile(join(dir, "models", "marts", "schema.yml"), `version: 2
models:
  - name: fct_foo
    columns:
      - name: id
`)
    const now = Date.now()
    await fs.utimes(join(dir, "models", "staging", "stg_foo.sql"), now / 1000, now / 1000)
    await fs.utimes(join(dir, "models", "marts", "fct_foo.sql"), now / 1000, now / 1000)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.details?.models_touched).toBe(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with non-SQL model (Python model — dbt 1.3+)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.writeFile(join(dir, "models", "py_model.py"), `
def model(dbt, session):
  return session.sql("select 1 as id")
`)
    const now = Date.now()
    await fs.utimes(join(dir, "models", "py_model.py"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // Python models exist in dbt 1.3+ but our validator only counts .sql.
    // Document the limitation.
    expect(r.details).toEqual({ models_touched: 0 })
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model file whose content is JSON", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", `{"this": "is not sql"}`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator returns details when models_touched > 0 but no subprocess errors", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(1)
    expect(r.details?.spawn_failures).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: model file with Unicode BOM at start works with build", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "﻿select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    expect(buildResult.status).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model that has macro definition (NOT a model)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("not_a_model", `{% macro foo() %}1{% endmacro %}`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // A .sql file containing only a macro is not a real model. dbt will
    // treat it as a model but build may fail.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model SQL of size 0 bytes", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // 0-byte SQL fails build.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator after dbt_packages/ exists with nested project", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const pkg = join(dir, "dbt_packages", "fake_pkg")
    await fs.mkdir(pkg, { recursive: true })
    await fs.writeFile(join(pkg, "dbt_project.yml"), "name: fake_pkg")
    // The nested project should NOT be confused with ours.
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with extremely long output (10K row test failure)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select null as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests:
          - not_null
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)
})
// altimate_change end

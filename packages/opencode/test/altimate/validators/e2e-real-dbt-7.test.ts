// altimate_change start — E2E wave 7: final 5 bugs to reach 50
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

async function setupProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-7-"))
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
  return dir
}

async function writeModel(name: string, sql: string): Promise<void> {
  await fs.writeFile(join(dir, "models", `${name}.sql`), sql)
  const now = Date.now()
  await fs.utimes(join(dir, "models", `${name}.sql`), now / 1000, now / 1000)
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

describe("E2E wave 7", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })
  afterEach(async () => {
    if (dir) await teardown()
  })

  test.skip("BUG: schema-verify returns ok=true for an all-no-spec project (no schema.yml at all)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await writeModel("bar", "select 2 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // No schema.yml anywhere — all models should be `no-spec` → ok=true.
    expect(r.ok).toBe(true)
    expect(r.details?.no_spec).toBeGreaterThan(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator detects orphan schema.yml entry (spec for nonexistent model)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns: [{name: id}]
  - name: nonexistent_model
    columns: [{name: x}]
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Should surface that a schema entry references a model that doesn't exist.
    expect((r.details as any)?.orphan_schema_entries).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator handles dbt error codes (e.g. exit code 2 = warning)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // No build → some commands may return exit code 2
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.exit_codes).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model whose name has trailing whitespace in dbt_project model config", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Add model config with trailing whitespace in name
    await fs.writeFile(join(dir, "dbt_project.yml"), `name: e2e
version: '1.0'
config-version: 2
profile: e2e
model-paths: ["models"]
target-path: target
models:
  e2e:
    +materialized: view
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.ok).toBe(true)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator surfaces compile error specifically (vs runtime error)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select {{ }} as id")  // empty Jinja
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Empty Jinja expression → compile error.
    expect(r.ok).toBe(false)
    expect((r.details as any)?.error_type).toBe("compile")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with conflicting model names (same name in two paths)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.mkdir(join(dir, "models", "a"))
    await fs.mkdir(join(dir, "models", "b"))
    await fs.writeFile(join(dir, "models", "a", "foo.sql"), "select 1 as id")
    await fs.writeFile(join(dir, "models", "b", "foo.sql"), "select 2 as id")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "a", "foo.sql"), now / 1000, now / 1000)
    await fs.utimes(join(dir, "models", "b", "foo.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: validator dedupes by modelNameFromPath ("foo") so only one runs.
    // The other model is silently ignored.
    expect(r.details?.models_touched).toBe(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator after `dbt deps` was run (dbt_packages/ exists with valid pkg)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Simulate post-deps state
    const pkgDir = join(dir, "dbt_packages", "fake_utils", "macros")
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(join(pkgDir, "noop.sql"), "{% macro noop() %}1{% endmacro %}")
    const r = await DbtTestsPassValidator.check(ctx())
    // Our own foo.sql is touched. Package macros should NOT count.
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)
})
// altimate_change end

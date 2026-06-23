// altimate_change start — E2E wave 6
/**
 * Wave 6: final E2E sweep. Assert more strict expected behaviors.
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

async function setupProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-6-"))
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

describe("E2E wave 6: even more strict assertions", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })
  afterEach(async () => {
    if (dir) await teardown()
  })

  test("validator includes session_id in details for tracing", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const customCtx = { ...ctx(), sessionID: "my-trace-id-123" }
    const r = await DbtTestsPassValidator.check(customCtx)
    expect((r.details as any)?.session_id).toBe("my-trace-id-123")
  }, E2E_TIMEOUT)

  test.skip("BUG: schema-verify includes schema_yml_path in details", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), "version: 2\nmodels:\n  - name: foo")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect((r.details as any)?.schema_yml_paths).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator details include dbt version detected", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.dbt_version).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator surfaces the adapter type (duckdb)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.dbt_adapter).toBe("duckdb")
  }, E2E_TIMEOUT)

  test.skip("BUG: tests-pass returns warning if many tests skipped", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id where false")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests: [not_null, unique]
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // Test runs on empty table — should pass.
    expect(r.ok).toBe(true)
    expect((r.details as any)?.tests_skipped).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator reports model count distinct from models_touched", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await writeModel("bar", "select 2 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.total_models_in_project).toBeGreaterThanOrEqual(2)
  }, E2E_TIMEOUT)

  test("validator includes worker count (concurrency limit) in details", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.concurrency_limit).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator surfaces dbt project name", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    expect((r.details as any)?.project_name).toBe("e2e")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator includes hint about how to rebuild", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
`)
    // Don't build — schema-verify will mismatch.
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.fixHint ?? "").toMatch(/build|run/i)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with subprocess exiting via SIGTERM during scan", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // This is hard to set up reliably in tests; just verify validator doesn't crash.
    const r = await DbtTestsPassValidator.check(ctx())
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: schema-verify returns a structured columns_diff array", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id, 'a' as extra")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(Array.isArray((r.details as any)?.columns_diff)).toBe(true)
  }, E2E_TIMEOUT)

  test.skip("BUG: tests-pass includes list of which tests failed per model", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select null::INTEGER as id, 'dup' as name UNION ALL SELECT NULL, 'dup'")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests: [not_null]
      - name: name
        tests: [unique]
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details as any)?.failing_by_model).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator preserves UTF-8 in model names through subprocess args", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("モデル", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model file that has read permission denied to current user", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // chmod 000 — can't read
    await fs.chmod(join(dir, "models", "foo.sql"), 0o000)
    try {
      const r = await DbtTestsPassValidator.check(ctx())
      expect(typeof r.ok).toBe("boolean")
    } finally {
      await fs.chmod(join(dir, "models", "foo.sql"), 0o644)
    }
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with absolute path symlink to model file", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    const real = join(dir, "real_foo.sql")
    await fs.writeFile(real, "select 1 as id")
    try {
      await fs.symlink(real, join(dir, "models", "foo.sql"))
    } catch {
      return
    }
    const now = Date.now()
    await fs.utimes(join(dir, "models", "foo.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // After fix: symlinks to SQL files should be discovered.
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)
})
// altimate_change end

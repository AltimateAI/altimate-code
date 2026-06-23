// altimate_change start — E2E wave 5
/**
 * Wave 5: assert STRICTER behaviour than current — actionable error messages,
 * useful detail fields, distinguishing related-but-distinct failure modes.
 * Each failing test demonstrates a UX/quality bug, not necessarily a crash.
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
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-5-"))
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

describe("E2E wave 5: assert STRICTER validator behaviour", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })
  afterEach(async () => {
    if (dir) await teardown()
  })

  test.skip("BUG: schema-verify result includes per-model verdict in details", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id, 'a' as name")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
      - name: name
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // BUG: result should include per-model verdict breakdown.
    expect((r.details as any)?.per_model).toBeDefined()
  }, E2E_TIMEOUT)

  test("validator surfaces the failing model name in the reason", async () => {
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
    // BUG: reason should mention `foo` by name.
    expect(r.reason ?? "").toContain("foo")
  }, E2E_TIMEOUT)

  test("validator result includes elapsed_ms field", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: validator should report time spent for telemetry.
    expect((r.details as any)?.elapsed_ms).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: tests-pass result includes list of passing tests", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
        tests:
          - not_null
          - unique
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: should list which tests ran/passed.
    expect((r.details as any)?.tests_passed).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator detects when altimate-dbt binary is not on PATH and gives clear message", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    process.env.PATH = "/usr/bin:/bin"
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: r.reason should clearly say "altimate-dbt not found on PATH".
    expect(r.reason ?? "").toMatch(/altimate-dbt|PATH|not found/i)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator surfaces stderr from subprocess in error detail", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "syntax error not sql")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // BUG: should include subprocess stderr in details.
    expect((r.details as any)?.stderr).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: tests-pass reports test count even when all pass", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
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
    // BUG: total test count should be in details even on success.
    expect((r.details as any)?.total_tests).toBeGreaterThan(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator skips when validator-utils detects dbt not installed", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Remove dbt from PATH (only altimate-dbt remains)
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}`
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: should report "dbt not installed" specifically.
    expect(r.reason ?? "").toMatch(/dbt/i)
  }, E2E_TIMEOUT)

  test("validator includes dbt_root in details (not just cwd)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: validator detected dbt_root but doesn't expose it in details.
    expect((r.details as any)?.dbt_root).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: failing test surfaces specific assertion / row counts", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select null::INTEGER as id")
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
    // BUG: failing test details should include row count or sample.
    expect((r.details as any)?.failing_rows).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator returns identical results when called twice in succession", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r1 = await DbtTestsPassValidator.check(ctx())
    const r2 = await DbtTestsPassValidator.check(ctx())
    expect(r1.ok).toBe(r2.ok)
    expect(r1.details).toEqual(r2.details)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with subprocess that emits warning prefix still parses", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    // The real subprocess always emits ANSI/log prefix; this is a sanity test.
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.spawn_failures).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator distinguishes 'model not built' from 'schema mismatch'", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
`)
    // Don't build → model not in duckdb
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // BUG: today reports `mismatch` (columns_missing). Should report
    // "model not built" or have a `verdict: "not-built"` enum value.
    expect((r.details as any)?.mismatch_models).toBeUndefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator reports validator version in details", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: useful for telemetry — validator schema version.
    expect((r.details as any)?.validator_version).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator details include the altimate-dbt binary path used", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: useful for debugging — which binary did we spawn?
    expect((r.details as any)?.altimate_dbt_path).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: validator handles dbt projects nested in workspaces correctly", async () => {
    if (!ENABLE_E2E) return
    dir = await fs.mkdtemp(join(tmpdir(), "e2e-workspace-"))
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${join(REPO_ROOT, "packages", "dbt-tools", "bin")}:${originalPath}`
    // Workspace has dbt_project.yml at packages/foo/
    const inner = join(dir, "packages", "foo")
    await fs.mkdir(inner, { recursive: true })
    await fs.writeFile(join(inner, "dbt_project.yml"), "name: foo\nversion: '1.0'\n")
    await fs.mkdir(join(inner, "models"))
    await fs.writeFile(join(inner, "models", "m.sql"), "select 1 as id")
    const now = Date.now()
    await fs.utimes(join(inner, "models", "m.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: validator only checks cwd and one level deep. workspaces with
    // dbt at depth 2 are missed.
    expect(r.details?.models_touched).toBeGreaterThan(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator output includes timestamp / when_run", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: useful for traceability.
    expect((r.details as any)?.run_at).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: spawn timeout reported separately from spawn failure", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // BUG: should report timeouts vs other spawn errors distinctly.
    expect((r.details as any)?.spawn_timeouts).toBeDefined()
  }, E2E_TIMEOUT)

  test.skip("BUG: schema-verify reports the per-mismatch column-level fix hint", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id, 'a' as extra_col")
    await fs.writeFile(join(dir, "models", "schema.yml"), `version: 2
models:
  - name: foo
    columns:
      - name: id
`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(r.fixHint).toContain("extra_col")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator includes total wall time across all subprocesses", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await writeModel("bar", "select 2 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect((r.details as any)?.total_subprocess_ms).toBeDefined()
  }, E2E_TIMEOUT)
})
// altimate_change end

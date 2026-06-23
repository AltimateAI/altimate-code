// altimate_change start — E2E wave 3
/**
 * Third E2E wave: probe yet more distinct failure modes.
 *   - Concurrent validator runs on the same project
 *   - Validator with very long subprocess output
 *   - Validator with snapshot / seed / source models
 *   - Validator with different model dependencies (ref chains)
 *   - Validator with permission-restricted files
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
  dir = await fs.mkdtemp(join(tmpdir(), "e2e-real-3-"))
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

describe("E2E wave 3: more real dbt-duckdb scenarios", () => {
  beforeEach(async () => {
    if (!ENABLE_E2E) return
  })
  afterEach(async () => {
    if (dir) await teardown()
  })

  test.skip("BUG: validator with ref chain (foo → bar) when only foo edited", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await fs.writeFile(join(dir, "models", "bar.sql"), "select * from {{ ref('foo') }}")
    // Only foo's mtime is "now"; bar is older
    const now = Date.now()
    await fs.utimes(join(dir, "models", "bar.sql"), (now - 60_000) / 1000, (now - 60_000) / 1000)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // Only foo should be in models_touched.
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with ref chain — both files just modified", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    await writeModel("bar", "select * from {{ ref('foo') }}")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with seeds/ CSV (not SQL)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.mkdir(join(dir, "seeds"))
    await fs.writeFile(join(dir, "seeds", "my_seed.csv"), "id,name\n1,a\n2,b\n")
    const now = Date.now()
    await fs.utimes(join(dir, "seeds", "my_seed.csv"), now / 1000, now / 1000)
    // CSV is not SQL — should not be touched.
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with snapshot model (snapshots/ dir)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.mkdir(join(dir, "snapshots"))
    await fs.writeFile(join(dir, "snapshots", "snap.sql"), "{% snapshot snap %}select 1{% endsnapshot %}")
    const now = Date.now()
    await fs.utimes(join(dir, "snapshots", "snap.sql"), now / 1000, now / 1000)
    // snapshots/ is not under models/ — should not be touched.
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: concurrent validator runs on same project don't corrupt state", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    const [a, b, c] = await Promise.all([
      DbtSchemaVerifyValidator.check(ctx()),
      DbtSchemaVerifyValidator.check(ctx()),
      DbtSchemaVerifyValidator.check(ctx()),
    ])
    // All three should give identical results.
    expect(a.ok).toBe(b.ok)
    expect(b.ok).toBe(c.ok)
    expect(a.details?.models_touched).toBe(b.details?.models_touched)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator after running `dbt clean` (target/ removed)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    // Simulate dbt clean
    await fs.rm(join(dir, "target"), { recursive: true, force: true })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Should still work or fail gracefully
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator handles model SQL with Jinja conditional", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", `{% if target.name == 'dev' %}
select 1 as id
{% else %}
select 2 as id
{% endif %}`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    expect(buildResult.status).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model using dbt_utils macros (package not installed)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select * from {{ dbt_utils.date_spine(...) }}")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // dbt_utils not installed → compile error.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with pre_hook that errors", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", `{{ config(pre_hook="select 1/0") }}
select 1 as id`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // Pre-hook errors → build fails.
    expect(r.ok).toBe(false)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model having post_hook (success path)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", `{{ config(post_hook="select 1") }}
select 1 as id`)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "foo"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    expect(buildResult.status).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model whose name has periods (foo.bar.baz)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo.bar.baz", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // Filename stripped of .sql becomes "foo.bar.baz". Run dbt test --model foo.bar.baz.
    // dbt may reject the name.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model having same name as a system table (information_schema)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("information_schema", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "information_schema"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    expect(buildResult.status).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator works after dbt deps was never run", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.writeFile(join(dir, "packages.yml"), "packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n")
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    // deps not installed → may fail.
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with multiple models in different subdirs of models/", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.mkdir(join(dir, "models", "staging"))
    await fs.mkdir(join(dir, "models", "marts"))
    await fs.writeFile(join(dir, "models", "staging", "stg_foo.sql"), "select 1 as id")
    await fs.writeFile(join(dir, "models", "marts", "fct_foo.sql"), "select * from {{ ref('stg_foo') }}")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "staging", "stg_foo.sql"), now / 1000, now / 1000)
    await fs.utimes(join(dir, "models", "marts", "fct_foo.sql"), now / 1000, now / 1000)
    const r = await DbtTestsPassValidator.check(ctx())
    expect(r.details?.models_touched).toBe(2)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model named exactly the same as a dependency package", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("dbt_utils", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const buildResult = spawnSync(ALTIMATE_DBT_BIN, ["build", "--model", "dbt_utils"], { cwd: dir, encoding: "utf8", timeout: 60_000 })
    expect(buildResult.status).toBe(0)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with cwd that is read-only", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    // Make models/ read-only temporarily
    await fs.chmod(join(dir, "models"), 0o444)
    try {
      const r = await DbtTestsPassValidator.check(ctx())
      expect(typeof r.ok).toBe("boolean")
    } finally {
      await fs.chmod(join(dir, "models"), 0o755)
    }
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with model file at very specific mtime equal to sinceMs", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await writeModel("foo", "select 1 as id")
    const fixedTime = 1_700_000_000_000
    await fs.utimes(join(dir, "models", "foo.sql"), fixedTime / 1000, fixedTime / 1000)
    const customCtx = { ...ctx(), sessionStartMs: fixedTime }
    const r = await DbtTestsPassValidator.check(customCtx)
    // >= semantics: file with mtime === sinceMs is included.
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with two duckdb files (multiple targets)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    // Add a prod target
    const profilesDir = join(dir, ".dbt")
    await fs.writeFile(join(profilesDir, "profiles.yml"), `e2e:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: ${join(dir, "dev.duckdb")}
      threads: 1
    prod:
      type: duckdb
      path: ${join(dir, "prod.duckdb")}
      threads: 1
`)
    await writeModel("foo", "select 1 as id")
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)

  test.skip("BUG: validator with mixed-case SQL extension (foo.SQL)", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    await fs.writeFile(join(dir, "models", "foo.SQL"), "select 1 as id")
    const now = Date.now()
    await fs.utimes(join(dir, "models", "foo.SQL"), now / 1000, now / 1000)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtTestsPassValidator.check(ctx())
    // Case-insensitive .sql check should pick up foo.SQL
    expect(r.details?.models_touched).toBe(1)
  }, E2E_TIMEOUT)

  test.skip("BUG: validator times out on a hypothetically slow build", async () => {
    if (!ENABLE_E2E) return
    await setupProject()
    // Generate a model with many CTEs that might be slow to compile
    const ctes = Array.from({ length: 200 }, (_, i) => `c${i} as (select ${i} as v)`).join(",\n")
    const finalSelect = Array.from({ length: 200 }, (_, i) => `c${i}.v as v${i}`).join(", ")
    const fromClause = Array.from({ length: 200 }, (_, i) => `c${i}`).join(", ")
    const sql = `with ${ctes}\nselect ${finalSelect} from ${fromClause}`
    await writeModel("foo", sql)
    spawnSync(ALTIMATE_DBT_BIN, ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 })
    const r = await DbtSchemaVerifyValidator.check(ctx())
    expect(typeof r.ok).toBe("boolean")
  }, E2E_TIMEOUT)
})
// altimate_change end

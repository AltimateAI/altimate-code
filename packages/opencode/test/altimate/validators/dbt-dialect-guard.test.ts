// altimate_change start — tests for the dialect-guard lint
import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtDialectGuardValidator } from "../../../src/altimate/validators/dbt-dialect-guard"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "dialect-guard-"))
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n",
  )
  await fs.mkdir(join(dir, "models"), { recursive: true })
  return dir
}

/** Establish the project convention: an existing guard under macros/. */
async function addProjectGuardConvention(): Promise<void> {
  await fs.mkdir(join(dir, "macros"), { recursive: true })
  await fs.writeFile(
    join(dir, "macros", "portable.sql"),
    "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% else %}current_timestamp{% endif %}{% endmacro %}",
  )
}

async function writeModel(name: string, sql: string): Promise<void> {
  await fs.writeFile(join(dir, "models", `${name}.sql`), sql)
}

const ctx = (overrides: Partial<ValidatorContext> = {}): ValidatorContext => ({
  sessionID: "s",
  workingDirectory: dir,
  sessionStartMs: 0,
  step: 1,
  retryCount: 0,
  ...overrides,
})

afterEach(async () => {
  delete process.env.ALTIMATE_VALIDATORS_DIALECT_GUARD
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ""
})

describe("DbtDialectGuardValidator — appliesTo needs the project convention", () => {
  test("does not apply outside a dbt project", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "dialect-guard-nodbt-"))
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(false)
  })

  test("does not apply to a single-warehouse project with no guards", async () => {
    await makeProject()
    await writeModel("stg_orders", "select iff(x > 0, 1, 0) as flag from t")
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(false)
  })

  test("applies once the project guards on target.type in a macro", async () => {
    await makeProject()
    await addProjectGuardConvention()
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })

  test("applies once the project guards on target.type in a model", async () => {
    await makeProject()
    await writeModel(
      "portable",
      "select {% if target.type == 'duckdb' %}1{% else %}2{% endif %} as x",
    )
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })

  test("applies under the explicit opt-in", async () => {
    await makeProject()
    process.env.ALTIMATE_VALIDATORS_DIALECT_GUARD = "1"
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })
})

describe("DbtDialectGuardValidator — check", () => {
  test("flags an unguarded Snowflake function", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("fct_orders", "select iff(amount > 0, 1, 0) as is_positive from {{ ref('src') }}")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("fct_orders")
    expect(r.fixHint).toContain("iff()")
    expect(r.fixHint).toContain("target.type")
  })

  test("flags an unguarded BigQuery function", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("fct_orders", "select safe_divide(a, b) as ratio from {{ ref('src') }}")
    expect((await DbtDialectGuardValidator.check(ctx())).ok).toBe(false)
  })

  test("flags an unguarded DuckDB function", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("raw_load", "select * from read_csv_auto('x.csv')")
    expect((await DbtDialectGuardValidator.check(ctx())).ok).toBe(false)
  })

  test("accepts the same function inside a target.type guard", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel(
      "fct_orders",
      [
        "select",
        "{% if target.type == 'snowflake' %}",
        "  iff(amount > 0, 1, 0) as is_positive",
        "{% else %}",
        "  case when amount > 0 then 1 else 0 end as is_positive",
        "{% endif %}",
        "from {{ ref('src') }}",
      ].join("\n"),
    )
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["findings"]).toEqual([])
  })

  test("accepts portable SQL", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel(
      "fct_orders",
      "select coalesce(a, 0) as a, case when b > 0 then 1 else 0 end as f from {{ ref('src') }}",
    )
    expect((await DbtDialectGuardValidator.check(ctx())).ok).toBe(true)
  })

  test("ignores a dialect function that only appears in a comment", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("fct_orders", "-- was iff(a, 1, 0)\nselect 1 as id")
    expect((await DbtDialectGuardValidator.check(ctx())).ok).toBe(true)
  })

  test("does not fire on a same-named column reference", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("fct_orders", "select iff as legacy_flag, getdate as d from {{ ref('src') }}")
    expect((await DbtDialectGuardValidator.check(ctx())).ok).toBe(true)
  })

  test("passes when the session touched nothing", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("fct_orders", "select iff(a, 1, 0) as f from t")
    const r = await DbtDialectGuardValidator.check(ctx({ sessionStartMs: Date.now() + 60_000 }))
    expect(r.ok).toBe(true)
    expect(r.details!["models_touched"]).toBe(0)
  })

  test("aggregates findings across models", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("a", "select zeroifnull(x) as x from t")
    await writeModel("b", "select safe_cast(x as int64) as x from t")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details!["findings"] as unknown[]).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Regression tests for false positives observed against real dbt projects.
// Each is ordinary dbt practice, and each blocked a session before these fixes.
// ---------------------------------------------------------------------------

describe("DbtDialectGuardValidator — known-good states must not fire", () => {
  test("a nested {% if %} inside a target.type guard does not end the guard early", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel(
      "nested_guard",
      [
        "{% if target.type == 'snowflake' %}",
        "  {% if var('wide', false) %}",
        "  select 1 as narrow",
        "  {% endif %}",
        "  select listagg(name, ',') as names from {{ ref('x') }}",
        "{% else %}",
        "  select string_agg(name, ',') as names from {{ ref('x') }}",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["findings"]).toEqual([])
  })

  test("a dialect function name inside a string literal is a value, not a call", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("literal_only", "select 'listagg(' as never_executed, 1 as id")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["findings"]).toEqual([])
  })

  test("a project macro invoked through Jinja is not a warehouse builtin", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("macro_call", "select {{ safe_cast('a', 'int') }} as v from {{ ref('x') }}")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["findings"]).toEqual([])
  })

  test("a dialect function name in a comment is not a call", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("commented", "-- we used to call listagg(name, ',') here\nselect 1 as id")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

describe("DbtDialectGuardValidator — activation needs a real guard", () => {
  test("a bare `target.type` mention in a comment does not establish the convention", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "notes.sql"),
      "-- one day we should branch on target.type here\n{% macro noop() %}{% endmacro %}",
    )
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(false)
  })

  test("an actual `{% if target.type %}` guard does establish it", async () => {
    await makeProject()
    await addProjectGuardConvention()
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })
})

describe("DbtDialectGuardValidator — reported construct names", () => {
  test("names the construct that actually matched, not its alternation head", async () => {
    await makeProject()
    await addProjectGuardConvention()
    await writeModel("t", "select try_to_date(x) as d from {{ ref('y') }}")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["findings"]).toEqual([
      { model: "t", function: "try_to_date()", dialects: "Snowflake" },
    ])
  })
})
// altimate_change end

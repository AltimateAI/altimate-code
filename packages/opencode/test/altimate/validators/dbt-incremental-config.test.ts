// altimate_change start — tests for the incremental-config consistency lint
import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtIncrementalConfigValidator } from "../../../src/altimate/validators/dbt-incremental-config"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "incremental-config-"))
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n",
  )
  await fs.mkdir(join(dir, "models"), { recursive: true })
  return dir
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
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ""
})

describe("DbtIncrementalConfigValidator — scope", () => {
  test("applies inside a dbt project only", async () => {
    await makeProject()
    expect(await DbtIncrementalConfigValidator.appliesTo(ctx())).toBe(true)
    const outside = await fs.mkdtemp(join(tmpdir(), "incremental-config-nodbt-"))
    expect(
      await DbtIncrementalConfigValidator.appliesTo(ctx({ workingDirectory: outside })),
    ).toBe(false)
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("ignores non-incremental models entirely", async () => {
    await makeProject()
    await writeModel(
      "stg_orders",
      "{{ config(materialized='table') }}\nselect current_timestamp as loaded_at, 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["incremental_models"]).toBe(0)
  })

  test("passes when the session touched nothing", async () => {
    await makeProject()
    await writeModel("stg_orders", "{{ config(materialized='incremental') }} select 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx({ sessionStartMs: Date.now() + 60_000 }))
    expect(r.ok).toBe(true)
    expect(r.details!["models_touched"]).toBe(0)
  })
})

describe("DbtIncrementalConfigValidator — upsert without a key", () => {
  test("flags merge strategy with no unique_key", async () => {
    await makeProject()
    await writeModel(
      "fct_orders",
      "{{ config(materialized='incremental', incremental_strategy='merge') }}\nselect 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.fixHint).toContain("unique_key")
    expect((r.details!["findings"] as Array<{ kind: string }>)[0]!.kind).toBe(
      "upsert-without-unique-key",
    )
  })

  test("flags delete+insert with no unique_key", async () => {
    await makeProject()
    await writeModel(
      "fct_orders",
      "{{ config(materialized='incremental', incremental_strategy='delete+insert') }}\nselect 1 as id",
    )
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(false)
  })

  test("accepts merge with a unique_key", async () => {
    await makeProject()
    await writeModel(
      "fct_orders",
      "{{ config(materialized='incremental', incremental_strategy='merge', unique_key='order_id') }}\nselect 1 as order_id",
    )
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })

  test("accepts an explicit keyless append strategy", async () => {
    await makeProject()
    await writeModel(
      "events",
      "{{ config(materialized='incremental', incremental_strategy='append') }}\nselect 1 as id",
    )
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })

  test("accepts an incremental model that declares no strategy at all", async () => {
    await makeProject()
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })

  test("ignores a strategy that only appears in a comment", async () => {
    await makeProject()
    await writeModel(
      "events",
      "-- incremental_strategy='merge' was considered\n{{ config(materialized='incremental') }}\nselect 1 as id",
    )
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })
})

describe("DbtIncrementalConfigValidator — is_incremental guard", () => {
  test("stays quiet about a missing guard when the task says nothing about idempotency", async () => {
    await makeProject()
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })

  test("flags a missing guard when the task demands idempotent re-runs", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "The model must be idempotent across re-runs.")
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details!["findings"] as Array<{ kind: string }>)[0]!.kind).toBe(
      "missing-is-incremental-guard",
    )
  })

  test("accepts a guarded model when idempotency is demanded", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "The model must be idempotent across re-runs.")
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where loaded_at > (select max(loaded_at) from {{ this }})",
        "{% endif %}",
      ].join("\n"),
    )
    expect((await DbtIncrementalConfigValidator.check(ctx())).ok).toBe(true)
  })
})

describe("DbtIncrementalConfigValidator — non-determinism", () => {
  test("flags a clock call inside the incremental predicate", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where loaded_at > current_timestamp - interval '1 day'",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details!["findings"] as Array<{ kind: string }>)[0]!.kind).toBe(
      "nondeterministic-predicate",
    )
    expect(r.fixHint).toContain("max(col)")
  })

  test("records but does not block on a clock call in a projected column", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select id, current_timestamp as dbt_loaded_at from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where loaded_at > (select max(loaded_at) from {{ this }})",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["advisories"]).toEqual([
      { model: "events", functions: ["current_timestamp"] },
    ])
  })
})

describe("DbtIncrementalConfigValidator — robustness", () => {
  test("aggregates findings across several models", async () => {
    await makeProject()
    await writeModel(
      "a",
      "{{ config(materialized='incremental', incremental_strategy='merge') }} select 1 as id",
    )
    await writeModel(
      "b",
      "{{ config(materialized='incremental', incremental_strategy='delete+insert') }} select 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details!["findings"] as unknown[]).length).toBe(2)
    expect(r.reason).toContain("a")
    expect(r.reason).toContain("b")
  })

  test("tolerates a directory named like a model without throwing", async () => {
    await makeProject()
    await writeModel("ok_model", "{{ config(materialized='table') }} select 1 as id")
    await fs.mkdir(join(dir, "models", "weird.sql"))
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Known-good states: ordinary incremental models this lint must stay quiet on.
// ---------------------------------------------------------------------------

describe("DbtIncrementalConfigValidator — known-good states must not fire", () => {
  test("a column named `random` in the predicate is not a random() call", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where random < 0.5 and now_flag = 1",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a clock in the full-refresh `{% else %}` arm is not the incremental predicate", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where loaded_at > (select max(loaded_at) from {{ this }})",
        "{% else %}",
        "  where loaded_at > current_date - 30",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a clock projected inside the guard is advisory, not a predicate finding", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select id",
        "{% if is_incremental() %}",
        "  , current_timestamp as loaded_at",
        "{% endif %}",
        "from {{ ref('src') }}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a literal `'now'` in a projected string is not a clock call", async () => {
    await makeProject()
    await writeModel(
      "events",
      [
        "{{ config(materialized='incremental') }}",
        "select id, 'now' as label from {{ ref('src') }}",
        "{% if is_incremental() %}",
        "  where id > (select max(id) from {{ this }})",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["advisories"]).toEqual([])
  })

  test("a `unique_key` inherited from dbt_project.yml suppresses the keyless finding", async () => {
    await makeProject()
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\nmodels:\n  t:\n    +unique_key: id\n",
    )
    await writeModel(
      "events",
      "{{ config(materialized='incremental', incremental_strategy='merge') }} select 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["project_unique_key"]).toBe(true)
  })

  test("a keyed upsert re-runs idempotently, so no guard is demanded of it", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Re-runs must be idempotent.")
    await writeModel(
      "events",
      "{{ config(materialized='incremental', incremental_strategy='merge', unique_key='id') }} select 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a task that disclaims idempotency does not switch the guard check on", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Idempotency is not required for this backfill.")
    await writeModel("events", "{{ config(materialized='incremental') }} select 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["idempotency_demanded"]).toBe(false)
  })
})

describe("DbtIncrementalConfigValidator — contract wording", () => {
  test("`idempotence` reads as a demand for repeatable re-runs", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Reruns must provide idempotence.")
    await writeModel("events", "{{ config(materialized='incremental') }} select 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["idempotency_demanded"]).toBe(true)
  })

  test("`unique_key=None` is a spelled assignment with no usable key", async () => {
    await makeProject()
    await writeModel(
      "events",
      "{{ config(materialized='incremental', incremental_strategy='merge', unique_key=None) }} select 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("events")
  })
})
// altimate_change end

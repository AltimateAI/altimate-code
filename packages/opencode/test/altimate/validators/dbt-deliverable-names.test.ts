// altimate_change start — tests for the literal deliverable / spec-name gate
import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtDeliverableNamesValidator } from "../../../src/altimate/validators/dbt-deliverable-names"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "deliverable-names-"))
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n",
  )
  await fs.mkdir(join(dir, "models"), { recursive: true })
  return dir
}

async function writeTask(text: string): Promise<void> {
  await fs.writeFile(join(dir, "TASK.md"), text)
}

async function writeModel(relative: string, sql = "select 1 as id"): Promise<void> {
  const path = join(dir, "models", relative)
  await fs.mkdir(join(path, ".."), { recursive: true })
  await fs.writeFile(path, sql)
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

describe("DbtDeliverableNamesValidator — appliesTo is silent without a contract", () => {
  test("does not apply outside a dbt project", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "deliverable-names-nodbt-"))
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    expect(await DbtDeliverableNamesValidator.appliesTo(ctx())).toBe(false)
  })

  test("does not apply with no task document", async () => {
    await makeProject()
    await writeModel("stg_orders.sql")
    expect(await DbtDeliverableNamesValidator.appliesTo(ctx())).toBe(false)
  })

  test("does not apply when the task document names nothing literally", async () => {
    await makeProject()
    await writeTask("Build a daily orders summary that the finance team can use.")
    expect(await DbtDeliverableNamesValidator.appliesTo(ctx())).toBe(false)
  })

  test("applies once the task names a deliverable", async () => {
    await makeProject()
    await writeTask("Create the model `fct_orders`.")
    expect(await DbtDeliverableNamesValidator.appliesTo(ctx())).toBe(true)
  })
})

describe("DbtDeliverableNamesValidator — check", () => {
  test("passes when every required name exists", async () => {
    await makeProject()
    await writeTask("## Required deliverables\n- `stg_orders`\n- `fct_orders`\n")
    await writeModel("stg_orders.sql")
    await writeModel("marts/fct_orders.sql")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["missing_models"]).toEqual([])
  })

  test("required names match regardless of directory nesting", async () => {
    await makeProject()
    await writeTask("Create the model `fct_orders`.")
    await writeModel("marts/finance/deep/fct_orders.sql")
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("fails on a renamed deliverable and names the likely substitute", async () => {
    await makeProject()
    await writeTask("Create the model `fct_orders`.")
    await writeModel("fct_orders_v2.sql")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["missing_models"]).toEqual(["fct_orders"])
    expect(r.fixHint).toContain("fct_orders_v2")
  })

  test("does not list an unrequested model the session did not author", async () => {
    await makeProject()
    await writeTask("Create the model `fct_orders`.")
    await writeModel("pre_existing.sql")
    const old = (Date.now() - 600_000) / 1000
    await fs.utimes(join(dir, "models", "pre_existing.sql"), old, old)
    const r = await DbtDeliverableNamesValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
    expect(r.details!["unrequested_models"]).toEqual([])
  })

  test("an alias recorded in manifest.json satisfies the required name", async () => {
    await makeProject()
    await writeTask("Create the model `fct_orders`.")
    await writeModel("orders_fact.sql")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({ nodes: { "model.t.orders_fact": { name: "orders_fact", alias: "fct_orders" } } }),
    )
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("a seed satisfies a required name", async () => {
    await makeProject()
    await writeTask("## Deliverables\n- `country_codes`\n")
    await fs.mkdir(join(dir, "seeds"))
    await fs.writeFile(join(dir, "seeds", "country_codes.csv"), "a,b\n")
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("required literal file paths are checked as paths", async () => {
    await makeProject()
    await writeTask("Create the model `models/marts/fct_orders.sql`.")
    // Right model name, wrong path.
    await writeModel("fct_orders.sql")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["missing_files"]).toEqual(["models/marts/fct_orders.sql"])
    expect(r.details!["missing_models"]).toEqual([])
  })

  test("passes when the required literal path exists", async () => {
    await makeProject()
    await writeTask("Create the model `models/marts/fct_orders.sql`.")
    await writeModel("marts/fct_orders.sql")
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("matching is case-insensitive", async () => {
    await makeProject()
    await writeTask("## Required\n- `FCT_Orders`\n")
    await writeModel("fct_orders.sql")
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("declaration marker drives the contract when present", async () => {
    await makeProject()
    await writeTask("<!-- altimate:required-models: fct_orders -->\nDo whatever you like.")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["required_source"]).toBe("declaration")
  })

  test("check soft-passes when the workspace disappears", async () => {
    await makeProject()
    const r = await DbtDeliverableNamesValidator.check(
      ctx({ workingDirectory: join(dir, "gone") }),
    )
    expect(r.ok).toBe(true)
  })
})

// A code span in a requirement line is only a model when nothing marks it as
// something else. These cases are the shapes found in real benchmark requests
// (column lists, "column called", dbt variables) plus the shapes that must
// keep speaking.
describe("DbtDeliverableNamesValidator — code spans that are not models", () => {
  async function requiredModels(task: string): Promise<string[]> {
    await makeProject()
    await writeTask(task)
    const r = await DbtDeliverableNamesValidator.check(ctx())
    return r.details!["required_models"] as string[]
  }

  test("a column list after 'should have' is not required as models", async () => {
    const models = await requiredModels(
      "Create a `dim_superhost_evolution` model. It should have `is_currently_superhost`, `status_change_count` and `last_status_change_at`.\n",
    )
    expect(models).toEqual(["dim_superhost_evolution"])
  })

  test("a column list with parenthetical notes is still all columns", async () => {
    const models = await requiredModels(
      "Create a `dim_superhost_evolution` model. It should have `is_currently_superhost`, `acct_age_before_achieving_superhost` (for first time), `status_change_count`, `last_status_change_at`.\n",
    )
    expect(models).toEqual(["dim_superhost_evolution"])
  })

  test("passes when the model exists and only its columns are in backticks", async () => {
    await makeProject()
    await writeTask("Create a model `dim_superhost_evolution` that has `is_currently_superhost`, `status_change_count`.\n")
    await writeModel("dim_superhost_evolution.sql")
    expect((await DbtDeliverableNamesValidator.check(ctx())).ok).toBe(true)
  })

  test("'a `x` column to the model `m`' requires the model and not the column", async () => {
    expect(await requiredModels("Add a `department` column to the model `int_workspace_roster`.\n")).toEqual([
      "int_workspace_roster",
    ])
  })

  test("'column called `x`' is not a model", async () => {
    expect(
      await requiredModels("Create a dbt model called `analysis__answer` that has one column called `answer`.\n"),
    ).toEqual(["analysis__answer"])
  })

  test("'columns `a`, `b` and `c`' are all columns", async () => {
    expect(
      await requiredModels("Add the columns `order_id`, `order_total` and `placed_at` to the model `fct_orders`.\n"),
    ).toEqual(["fct_orders"])
  })

  test("a renamed column is not a model, the model it lives in still is", async () => {
    expect(
      await requiredModels("Rename the `old_status` column to `new_status` in the model `stg_accounts`.\n"),
    ).toEqual(["stg_accounts"])
  })

  test("a dbt variable is not a model", async () => {
    expect(
      await requiredModels(
        "Fix the model: add a global variable in dbt_project.yml called `surrogate_key_treat_nulls_as_empty_strings` to the `monthly_agg_reviews` model.\n",
      ),
    ).toEqual(["monthly_agg_reviews"])
  })

  test("still requires every model in a list of models", async () => {
    expect(await requiredModels("Create the models `stg_orders` and `stg_customers`.\n")).toEqual([
      "stg_orders",
      "stg_customers",
    ])
  })

  test("a model that merely follows the word 'include' is still required", async () => {
    expect(await requiredModels("Build the marts to include the model `fct_orders`.\n")).toEqual(["fct_orders"])
  })

  test("still fails when the model is missing even though its columns are listed", async () => {
    await makeProject()
    await writeTask("Create a `dim_superhost_evolution` model. It should have `is_currently_superhost`.\n")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["missing_models"]).toEqual(["dim_superhost_evolution"])
    expect(r.reason).not.toContain("is_currently_superhost")
  })
})
// altimate_change end

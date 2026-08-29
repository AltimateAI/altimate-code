// altimate_change start — tests for the nothing-built inverse completion gate
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtNothingBuiltValidator } from "../../../src/altimate/validators/dbt-nothing-built"
import {
  extractRequiredDeliverables,
  findTaskInstructionFile,
  readRunResults,
  resolveDbtTargetPath,
  isFailedRunStatus,
  collectProducedNodeNames,
  stripSqlComments,
} from "../../../src/altimate/validators/validator-utils"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "nothing-built-"))
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n",
  )
  await fs.mkdir(join(dir, "models"), { recursive: true })
  return dir
}

async function writeModel(name: string, sql = "select 1 as id"): Promise<void> {
  await fs.writeFile(join(dir, "models", `${name}.sql`), sql)
}

async function writeRunResults(nodes: Array<{ id: string; status: string }>): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  await fs.writeFile(
    join(dir, "target", "run_results.json"),
    JSON.stringify({
      metadata: { dbt_schema_version: "v5" },
      results: nodes.map((n) => ({ unique_id: n.id, status: n.status, message: null })),
    }),
  )
}

/** Context whose session start is in the past — files on disk count as authored. */
const ctxPast = (): ValidatorContext => ({
  sessionID: "s",
  workingDirectory: dir,
  sessionStartMs: 0,
  step: 1,
  retryCount: 0,
})

/** Context whose session start is in the future — nothing on disk counts as authored. */
const ctxFuture = (): ValidatorContext => ({
  sessionID: "s",
  workingDirectory: dir,
  sessionStartMs: Date.now() + 60_000,
  step: 1,
  retryCount: 0,
})

afterEach(async () => {
  delete process.env.ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS
  delete process.env.ALTIMATE_VALIDATORS_TASK_FILE
  delete process.env.DBT_TARGET_PATH
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ""
})

// ---------------------------------------------------------------------------
// extractRequiredDeliverables
// ---------------------------------------------------------------------------

describe("extractRequiredDeliverables", () => {
  test("returns null for empty input", () => {
    expect(extractRequiredDeliverables("")).toBeNull()
  })

  test("returns null for prose that names nothing in code spans", () => {
    expect(
      extractRequiredDeliverables("Please build some models that summarise the orders data."),
    ).toBeNull()
  })

  test("returns null when code spans hold only generic modelling words", () => {
    expect(extractRequiredDeliverables("Create the `model` in the `models` folder.")).toBeNull()
  })

  test("declaration block wins and parses a comma list", () => {
    const r = extractRequiredDeliverables("<!-- altimate:required-models: orders_daily, cust_dim -->")
    expect(r).not.toBeNull()
    expect(r!.source).toBe("declaration")
    expect(r!.models).toEqual(["orders_daily", "cust_dim"])
  })

  test("declaration block is honoured without the HTML comment wrapper", () => {
    const r = extractRequiredDeliverables("altimate:required_models: fct_sales")
    expect(r!.models).toEqual(["fct_sales"])
  })

  test("deliverables section collects code spans under the heading", () => {
    const doc = [
      "# Task",
      "Some background about `ignored_here`.",
      "## Required deliverables",
      "- `stg_orders`",
      "- `fct_orders`",
      "## Notes",
      "- `not_a_deliverable`",
    ].join("\n")
    const r = extractRequiredDeliverables(doc)
    expect(r!.source).toBe("deliverables-section")
    expect(r!.models).toEqual(["stg_orders", "fct_orders"])
  })

  test("requirement lines need both a verb and a data-artifact noun", () => {
    const withBoth = extractRequiredDeliverables("Create a model named `dim_customer`.")
    expect(withBoth!.source).toBe("requirement-lines")
    expect(withBoth!.models).toEqual(["dim_customer"])
    // Verb but no artifact noun.
    expect(extractRequiredDeliverables("Create a report called `dim_customer`.")).toBeNull()
    // Artifact noun but no requirement verb.
    expect(extractRequiredDeliverables("The model `dim_customer` is interesting.")).toBeNull()
  })

  test("literal file paths are captured and also imply the bare model name", () => {
    const r = extractRequiredDeliverables("Create the model `models/marts/fct_orders.sql`.")
    expect(r!.files).toEqual(["models/marts/fct_orders.sql"])
    expect(r!.models).toEqual(["fct_orders"])
  })

  test("names are lowercased and de-duplicated", () => {
    const r = extractRequiredDeliverables(
      "## Deliverables\n- `Fct_Orders`\n- `fct_orders`\n- `FCT_ORDERS`\n",
    )
    expect(r!.models).toEqual(["fct_orders"])
  })

  test("rejects tokens that are not identifier shaped", () => {
    const r = extractRequiredDeliverables(
      "## Required\n- `select * from x`\n- `ok_name`\n- `a`\n",
    )
    expect(r!.models).toEqual(["ok_name"])
  })
})

// ---------------------------------------------------------------------------
// findTaskInstructionFile
// ---------------------------------------------------------------------------

describe("findTaskInstructionFile", () => {
  test("returns null when no task document exists", async () => {
    await makeProject()
    expect(await findTaskInstructionFile(dir, dir)).toBeNull()
  })

  test("does not treat README.md as a task document", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "README.md"), "Create the model `fct_orders`.")
    expect(await findTaskInstructionFile(dir, dir)).toBeNull()
  })

  test("finds TASK.md at the workspace root", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "hello")
    const found = await findTaskInstructionFile(dir, dir)
    expect(found!.path).toBe(join(dir, "TASK.md"))
    expect(found!.content).toBe("hello")
  })

  test("finds a task document under .altimate/", async () => {
    await makeProject()
    await fs.mkdir(join(dir, ".altimate"))
    await fs.writeFile(join(dir, ".altimate", "task.md"), "hello")
    const found = await findTaskInstructionFile(dir, dir)
    // Path case is not asserted: case-insensitive volumes resolve the `TASK.md`
    // candidate onto the `task.md` file that exists.
    expect(found!.path.toLowerCase()).toBe(join(dir, ".altimate", "task.md").toLowerCase())
    expect(found!.content).toBe("hello")
  })

  test("honours ALTIMATE_VALIDATORS_TASK_FILE ahead of the candidates", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "candidate")
    await fs.writeFile(join(dir, "custom-brief.md"), "explicit")
    process.env.ALTIMATE_VALIDATORS_TASK_FILE = "custom-brief.md"
    expect((await findTaskInstructionFile(dir, dir))!.content).toBe("explicit")
  })

  test("skips an empty task document", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "   \n\n")
    expect(await findTaskInstructionFile(dir, dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// run_results / target-path / inventory helpers
// ---------------------------------------------------------------------------

describe("run_results and inventory helpers", () => {
  test("resolveDbtTargetPath defaults to target/", async () => {
    await makeProject()
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "target"))
  })

  test("resolveDbtTargetPath honours target-path in dbt_project.yml", async () => {
    await makeProject()
    await fs.appendFile(join(dir, "dbt_project.yml"), 'target-path: "build_out"\n')
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "build_out"))
  })

  test("resolveDbtTargetPath honours DBT_TARGET_PATH", async () => {
    await makeProject()
    process.env.DBT_TARGET_PATH = "alt_target"
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "alt_target"))
  })

  test("readRunResults returns null when the artifact is missing", async () => {
    await makeProject()
    expect(await readRunResults(dir)).toBeNull()
  })

  test("readRunResults returns null on malformed JSON rather than throwing", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "target"))
    await fs.writeFile(join(dir, "target", "run_results.json"), "{not json")
    expect(await readRunResults(dir)).toBeNull()
  })

  test("readRunResults parses node names and statuses", async () => {
    await makeProject()
    await writeRunResults([
      { id: "model.t.stg_orders", status: "success" },
      { id: "model.t.fct_orders", status: "ERROR" },
    ])
    const rr = await readRunResults(dir)
    expect(rr!.results.map((r) => r.name)).toEqual(["stg_orders", "fct_orders"])
    expect(rr!.results.map((r) => r.status)).toEqual(["success", "error"])
  })

  test("isFailedRunStatus treats warn as clean and skipped as failed", () => {
    expect(isFailedRunStatus("success")).toBe(false)
    expect(isFailedRunStatus("PASS")).toBe(false)
    expect(isFailedRunStatus("warn")).toBe(false)
    expect(isFailedRunStatus("skipped")).toBe(true)
    expect(isFailedRunStatus("error")).toBe(true)
    expect(isFailedRunStatus("")).toBe(true)
  })

  test("collectProducedNodeNames unions filesystem names and manifest aliases", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await fs.mkdir(join(dir, "seeds"))
    await fs.writeFile(join(dir, "seeds", "country_codes.csv"), "a,b\n")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({ nodes: { "model.t.x": { name: "x", alias: "renamed_relation" } } }),
    )
    const names = await collectProducedNodeNames(dir)
    expect(names.has("stg_orders")).toBe(true)
    expect(names.has("country_codes")).toBe(true)
    expect(names.has("renamed_relation")).toBe(true)
  })

  test("stripSqlComments blanks line, block and Jinja comments", () => {
    const out = stripSqlComments("select 1 -- a / b\n/* x / y */ {# z / w #} select 2")
    expect(out).not.toContain("a / b")
    expect(out).not.toContain("x / y")
    expect(out).not.toContain("z / w")
    expect(out).toContain("select 2")
  })
})

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

describe("DbtNothingBuiltValidator — appliesTo is conservative", () => {
  test("does not apply outside a dbt project", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "nothing-built-nodbt-"))
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    expect(await DbtNothingBuiltValidator.appliesTo(ctxFuture())).toBe(false)
  })

  test("does not apply to a read-only session with no task document", async () => {
    await makeProject()
    expect(await DbtNothingBuiltValidator.appliesTo(ctxFuture())).toBe(false)
  })

  test("does not apply when the task document names no deliverables", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Investigate why the nightly run is slow.")
    expect(await DbtNothingBuiltValidator.appliesTo(ctxFuture())).toBe(false)
  })

  test("applies when the task document names deliverables", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    expect(await DbtNothingBuiltValidator.appliesTo(ctxFuture())).toBe(true)
  })

  test("applies under the explicit opt-in even without a task document", async () => {
    await makeProject()
    process.env.ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS = "1"
    expect(await DbtNothingBuiltValidator.appliesTo(ctxFuture())).toBe(true)
  })
})

describe("DbtNothingBuiltValidator — check", () => {
  test("fails a session that authored nothing and built nothing", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    const r = await DbtNothingBuiltValidator.check(ctxFuture())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("fct_orders")
    expect(r.fixHint).toContain("fct_orders")
    expect(r.details!["authored_files"]).toBe(false)
    expect(r.details!["fresh_run_results"]).toBe(false)
  })

  test("passes when the session authored a model file", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    await writeModel("fct_orders")
    const r = await DbtNothingBuiltValidator.check(ctxPast())
    expect(r.ok).toBe(true)
    expect(r.details!["authored_files"]).toBe(true)
  })

  test("passes when the session authored a macro rather than a model", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    await fs.mkdir(join(dir, "macros"))
    await fs.writeFile(join(dir, "macros", "helper.sql"), "{% macro h() %}{% endmacro %}")
    const r = await DbtNothingBuiltValidator.check(ctxPast())
    expect(r.ok).toBe(true)
  })

  test("passes on a fresh successful run artifact even with no file writes", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    await writeRunResults([{ id: "model.t.fct_orders", status: "success" }])
    const r = await DbtNothingBuiltValidator.check(ctxPast())
    expect(r.ok).toBe(true)
    expect(r.details!["fresh_run_results"]).toBe(true)
  })

  test("a stale run artifact does not rescue a session that wrote nothing", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    await writeRunResults([{ id: "model.t.fct_orders", status: "success" }])
    const r = await DbtNothingBuiltValidator.check(ctxFuture())
    expect(r.ok).toBe(false)
    expect(r.details!["fresh_run_results"]).toBe(false)
  })

  test("an all-failed fresh run artifact does not count as a build", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.")
    await writeRunResults([{ id: "model.t.fct_orders", status: "error" }])
    const r = await DbtNothingBuiltValidator.check(ctxFuture())
    expect(r.ok).toBe(false)
  })

  test("opt-in path reports the opt-in expectation and still fails an empty session", async () => {
    await makeProject()
    process.env.ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS = "1"
    const r = await DbtNothingBuiltValidator.check(ctxFuture())
    expect(r.ok).toBe(false)
    expect(r.details!["expectation"]).toBe("opt-in")
  })

  test("check soft-passes (no throw) when the project disappears mid-run", async () => {
    await makeProject()
    const gone = join(dir, "does-not-exist")
    const r = await DbtNothingBuiltValidator.check({ ...ctxFuture(), workingDirectory: gone })
    expect(r.ok).toBe(true)
  })
})
// altimate_change end

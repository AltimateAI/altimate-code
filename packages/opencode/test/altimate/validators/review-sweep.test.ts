// altimate_change start — regression tests for the PR-1175 review sweep
/**
 * One test per defect closed while clearing the review backlog on the
 * deterministic completion gates, plus the vacuous-pass audit.
 *
 * The vacuous-pass block is the important half. The known failure mode for
 * this feature is a gate that returns `ok: true` having checked nothing —
 * `dbt-build-green` once passed with zero models inspected. Every validator in
 * the lane must therefore either check something or say, in its own details,
 * exactly why it did not. These tests assert that the "did not check anything"
 * path is always explicitly labelled, so a silent vacuous pass shows up as a
 * failing test rather than as a green session.
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtBuildGreenValidator } from "../../../src/altimate/validators/dbt-build-green"
import { DbtNothingBuiltValidator } from "../../../src/altimate/validators/dbt-nothing-built"
import { DbtDeliverableNamesValidator } from "../../../src/altimate/validators/dbt-deliverable-names"
import { DbtIncrementalConfigValidator } from "../../../src/altimate/validators/dbt-incremental-config"
import { DbtDialectGuardValidator } from "../../../src/altimate/validators/dbt-dialect-guard"
import {
  modelsModifiedSince,
  extractRequiredDeliverables,
  collectProducedNodeNames,
  collectExecutedModelNames,
  sourceExemptsFromRunResults,
  sourceDeclaresNonEphemeral,
  sourceDeclaresEnabled,
  resolveDbtTargetPath,
  maskJinjaExpressions,
  extractJinjaIfBlocks,
  jinjaIfBranchHead,
  stripJinjaIfBlocks,
  findTaskInstructionFiles,
} from "../../../src/altimate/validators/validator-utils"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(prefix = "review-sweep-"): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), prefix))
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

async function writeRunResults(
  nodes: Array<{ id: string; status: string }>,
  mtimeOffsetMs = 0,
): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  const path = join(dir, "target", "run_results.json")
  await fs.writeFile(
    path,
    JSON.stringify({
      metadata: { dbt_schema_version: "v5" },
      results: nodes.map((n) => ({ unique_id: n.id, status: n.status, message: null })),
    }),
  )
  if (mtimeOffsetMs !== 0) {
    const t = (Date.now() + mtimeOffsetMs) / 1000
    await fs.utimes(path, t, t)
  }
}

/** Write the model DDL dbt leaves under `<target>/run/`, at a chosen mtime. */
async function writeRunDdl(name: string, mtimeOffsetMs = 0): Promise<void> {
  const runDir = join(dir, "target", "run", "t", "models")
  await fs.mkdir(runDir, { recursive: true })
  const path = join(runDir, `${name}.sql`)
  await fs.writeFile(path, "create table x as select 1")
  if (mtimeOffsetMs !== 0) {
    const t = (Date.now() + mtimeOffsetMs) / 1000
    await fs.utimes(path, t, t)
  }
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

// ---------------------------------------------------------------------------
// The vacuous-pass audit
// ---------------------------------------------------------------------------

describe("vacuous-pass audit — every gate that passes without checking says so", () => {
  test("all five gates refuse to apply outside a dbt project", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-nodbt-"))
    for (const v of [
      DbtBuildGreenValidator,
      DbtNothingBuiltValidator,
      DbtDeliverableNamesValidator,
      DbtIncrementalConfigValidator,
      DbtDialectGuardValidator,
    ]) {
      expect(await v.appliesTo(ctx())).toBe(false)
    }
  })

  test("all five gates re-gate on findDbtProjectRoot inside check(), not just appliesTo", async () => {
    // appliesTo and check can be called independently. A gate that only
    // guards in appliesTo would scan an arbitrary directory when check() is
    // invoked directly.
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-nodbt-"))
    for (const v of [
      DbtBuildGreenValidator,
      DbtNothingBuiltValidator,
      DbtDeliverableNamesValidator,
      DbtIncrementalConfigValidator,
      DbtDialectGuardValidator,
    ]) {
      const r = await v.check(ctx())
      expect(r.ok).toBe(true)
      expect(r.details!["skipped"]).toBe("no dbt project")
    }
  })

  test("build-green: nothing edited and no fresh build is labelled nothing-to-gate", async () => {
    await makeProject()
    const r = await DbtBuildGreenValidator.check(ctx({ sessionStartMs: Date.now() + 60_000 }))
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("nothing-to-gate")
    expect(r.details!["models_touched"]).toBe(0)
  })

  test("build-green: a pass with no evidence source is labelled coverage-inconclusive", async () => {
    // The exact historical bug: an edited model, a fresh artifact carrying no
    // model rows and no run DDL. The gate cannot assert coverage — it must not
    // report this as a clean `fresh-build`.
    await makeProject()
    await writeModel("orders")
    await writeRunResults([{ id: "test.t.not_null_orders_id", status: "pass" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.details!["verdict"]).toBe("coverage-inconclusive")
    expect(r.details!["coverage_assertable"]).toBe(false)
    expect(r.details!["models_touched"]).toBe(1)
  })

  test("build-green: a real pass is labelled fresh-build with a non-zero model count", async () => {
    // The counterpart assertion — a green verdict must be able to show what it
    // actually inspected, so "passed having checked nothing" and "passed
    // having checked something" are distinguishable in telemetry.
    await makeProject()
    await writeModel("orders")
    await writeRunResults([{ id: "model.t.orders", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("fresh-build")
    expect(r.details!["coverage_assertable"]).toBe(true)
    expect(r.details!["model_nodes_in_artifact"]).toBe(1)
  })

  test("nothing-built: a pass with no artifact expectation is labelled", async () => {
    await makeProject()
    const r = await DbtNothingBuiltValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["skipped"]).toBe("no artifact expectation")
  })

  test("deliverable-names: a pass with no literal contract is labelled", async () => {
    await makeProject()
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["skipped"]).toBe("no literal contract")
  })

  test("incremental-config and dialect-guard report the count they inspected", async () => {
    await makeProject()
    const start = Date.now() + 60_000
    const inc = await DbtIncrementalConfigValidator.check(ctx({ sessionStartMs: start }))
    expect(inc.ok).toBe(true)
    expect(inc.details!["models_touched"]).toBe(0)
    const dg = await DbtDialectGuardValidator.check(ctx({ sessionStartMs: start }))
    expect(dg.ok).toBe(true)
    expect(dg.details!["models_touched"]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Discovery scope
// ---------------------------------------------------------------------------

describe("installed dbt packages are not session work", () => {
  test("dbt deps refreshing dbt_packages/ does not make the gate demand a build", async () => {
    await makeProject()
    const pkgModels = join(dir, "dbt_packages", "dbt_utils", "models")
    await fs.mkdir(pkgModels, { recursive: true })
    await fs.writeFile(join(pkgModels, "vendored.sql"), "select 1")
    const touched = await modelsModifiedSince(dir, 0)
    expect(touched.length).toBe(0)

    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("nothing-to-gate")
  })
})

// ---------------------------------------------------------------------------
// Exemptions must come from config(), and current source beats a stale manifest
// ---------------------------------------------------------------------------

describe("run-results exemptions are scoped to config() arguments", () => {
  test("a `where enabled = false` predicate does not exempt a model", () => {
    expect(sourceExemptsFromRunResults("select 1 as id from t where enabled = false")).toBe(false)
  })

  test("a `materialized = 'ephemeral'` string comparison does not exempt a model", () => {
    expect(
      sourceExemptsFromRunResults("select * from meta where materialized = 'ephemeral'"),
    ).toBe(false)
  })

  test("a real config() call still exempts", () => {
    expect(sourceExemptsFromRunResults("{{ config(materialized='ephemeral') }}\nselect 1")).toBe(
      true,
    )
    expect(sourceExemptsFromRunResults("{{ config(enabled=false) }}\nselect 1")).toBe(true)
  })

  test("an unbuilt model cannot hide behind a SQL predicate", async () => {
    await makeProject()
    await writeModel("orders", "select 1 as id from raw where enabled = false")
    await writeRunResults([{ id: "model.t.other", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
  })

  test("current source overrides a stale manifest exemption", async () => {
    await makeProject()
    // The manifest still says ephemeral; the model has since been made a table.
    await writeModel("orders", "{{ config(materialized='table') }}\nselect 1 as id")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {
          "model.t.orders": {
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "ephemeral" },
          },
        },
      }),
    )
    await writeRunResults([{ id: "model.t.other", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
    expect(r.details!["exempt_models"]).toEqual([])
  })

  test("the contradiction probes only read config() arguments", () => {
    expect(sourceDeclaresNonEphemeral("{{ config(materialized='table') }}\nselect 1")).toBe(true)
    expect(sourceDeclaresNonEphemeral("{{ config(materialized='ephemeral') }}\nselect 1")).toBe(
      false,
    )
    expect(sourceDeclaresNonEphemeral("select * from t where materialized = 'table'")).toBe(false)
    expect(sourceDeclaresEnabled("{{ config(enabled=true) }}\nselect 1")).toBe(true)
    expect(sourceDeclaresEnabled("select 1 from t where enabled = true")).toBe(false)
  })

  test("a manifest exemption is only discarded on the axis the source contradicts", async () => {
    // Disabled in `dbt_project.yml`, so the manifest is the only place that
    // knows. The model sets `materialized` in its own config, which says
    // nothing about whether it is enabled — demanding a `run_results` row for
    // it would be a gate the session can never clear.
    await makeProject()
    await writeModel("retired", "{{ config(materialized='table') }}\nselect 1 as id")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {},
        disabled: {
          "model.t.retired": [
            { name: "retired", original_file_path: "models/retired.sql", config: {} },
          ],
        },
      }),
    )
    await writeRunResults([{ id: "model.t.other", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["exempt_models"]).toEqual(["retired"])
  })

  test("an ephemeral manifest entry survives an unrelated enabled=true in the source", async () => {
    await makeProject()
    await writeModel("interim", "{{ config(enabled=true) }}\nselect 1 as id")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {
          "model.t.interim": {
            name: "interim",
            original_file_path: "models/interim.sql",
            config: { materialized: "ephemeral" },
          },
        },
      }),
    )
    await writeRunResults([{ id: "model.t.other", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["exempt_models"]).toEqual(["interim"])
  })

  test("re-enabling a disabled model does discard the disabled exemption", async () => {
    await makeProject()
    await writeModel("revived", "{{ config(enabled=true) }}\nselect 1 as id")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {},
        disabled: {
          "model.t.revived": [
            { name: "revived", original_file_path: "models/revived.sql", config: {} },
          ],
        },
      }),
    )
    await writeRunResults([{ id: "model.t.other", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["revived"])
  })
})

// ---------------------------------------------------------------------------
// Staleness is measured against the artifact that covered the model
// ---------------------------------------------------------------------------

describe("post-build edits are dated from the build that covered the model", () => {
  test("collectExecutedModelNames reports the DDL mtime per model", async () => {
    await makeProject()
    await writeRunDdl("orders", -30_000)
    const executed = await collectExecutedModelNames(dir, 0)
    expect(executed.has("orders")).toBe(true)
    expect(executed.get("orders")!).toBeLessThan(Date.now())
  })

  test("an edit between the build and a later dbt test is caught as stale", async () => {
    await makeProject()
    // dbt run wrote the DDL five minutes ago; the model was edited since; a
    // later dbt test rewrote run_results.json just now. Dating the build from
    // run_results would forgive the edit.
    await writeRunDdl("orders", -300_000)
    await writeModel("orders")
    await writeRunResults([{ id: "test.t.not_null_orders_id", status: "pass" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["stale_build"]).toEqual(["orders"])
  })

  test("a model built and left alone is not reported stale", async () => {
    await makeProject()
    await writeModel("orders")
    await writeRunDdl("orders")
    await writeRunResults([{ id: "test.t.not_null_orders_id", status: "pass" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["stale_build"]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Project inventory
// ---------------------------------------------------------------------------

describe("a stale manifest cannot satisfy a required deliverable", () => {
  test("names whose defining file is gone are dropped from the inventory", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {
          "model.t.deleted": {
            name: "deleted",
            original_file_path: "models/deleted.sql",
            config: {},
          },
          "model.t.kept": { name: "kept", original_file_path: "models/kept.sql", config: {} },
        },
      }),
    )
    await writeModel("kept")
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("kept")).toBe(true)
    expect(produced.has("deleted")).toBe(false)
  })

  test("an aliased node whose file still exists is still honoured", async () => {
    await makeProject()
    await writeModel("orders")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(
      join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: {
          "model.t.orders": {
            name: "orders",
            alias: "fct_orders",
            original_file_path: "models/orders.sql",
            config: {},
          },
        },
      }),
    )
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("fct_orders")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Target-path resolution
// ---------------------------------------------------------------------------

describe("a Jinja target-path does not become a literal directory name", () => {
  test("a resolvable env_var() is rendered", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-target-"))
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\ntarget-path: \"{{ env_var('ALTIMATE_TEST_ARTIFACT_DIR') }}\"\n",
    )
    const prior = process.env.ALTIMATE_TEST_ARTIFACT_DIR
    process.env.ALTIMATE_TEST_ARTIFACT_DIR = "build-out"
    try {
      expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "build-out"))
    } finally {
      if (prior === undefined) delete process.env.ALTIMATE_TEST_ARTIFACT_DIR
      else process.env.ALTIMATE_TEST_ARTIFACT_DIR = prior
    }
  })

  test("an env_var() default is used when the variable is unset", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-target-"))
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\ntarget-path: \"{{ env_var('ALTIMATE_TEST_UNSET_DIR', 'fallback-target') }}\"\n",
    )
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "fallback-target"))
  })

  test("an unrenderable expression falls back to target/ rather than blocking a green build", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-target-"))
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\ntarget-path: \"{{ var('artifact_dir') }}\"\n",
    )
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "target"))
  })

  test("a plain literal path is unaffected", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-target-"))
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: t\ntarget-path: custom_target\n")
    expect(await resolveDbtTargetPath(dir)).toBe(join(dir, "custom_target"))
  })
})

// ---------------------------------------------------------------------------
// Task-contract discovery
// ---------------------------------------------------------------------------

describe("a contract-free task document does not mask a real contract", () => {
  test("findTaskInstructionFiles returns every candidate in precedence order", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-task-"))
    await fs.writeFile(join(dir, "TASK.md"), "Some background about this repository.\n")
    await fs.writeFile(join(dir, "REQUIREMENTS.md"), "Create the model `fct_orders`.\n")
    const found = await findTaskInstructionFiles(dir, null)
    expect(found.length).toBe(2)
    expect(found[0]!.path.endsWith("TASK.md")).toBe(true)
  })

  test("an informational TASK.md no longer hides a REQUIREMENTS.md contract", async () => {
    await makeProject("review-sweep-task-")
    await fs.writeFile(join(dir, "TASK.md"), "Some background about this repository.\n")
    await fs.writeFile(join(dir, "REQUIREMENTS.md"), "Create the model `fct_orders`.\n")
    expect(await DbtNothingBuiltValidator.appliesTo(ctx())).toBe(true)
    expect(await DbtDeliverableNamesValidator.appliesTo(ctx())).toBe(true)
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["missing_models"]).toEqual(["fct_orders"])
    expect(String(r.details!["task_file"]).endsWith("REQUIREMENTS.md")).toBe(true)
  })

  test("the explicit task-file override still wins outright", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "review-sweep-task-"))
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `from_task`.\n")
    await fs.writeFile(join(dir, "PINNED.md"), "Create the model `from_pinned`.\n")
    const prior = process.env.ALTIMATE_VALIDATORS_TASK_FILE
    process.env.ALTIMATE_VALIDATORS_TASK_FILE = "PINNED.md"
    try {
      const found = await findTaskInstructionFiles(dir, null)
      expect(found.length).toBe(1)
      expect(found[0]!.path.endsWith("PINNED.md")).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.ALTIMATE_VALIDATORS_TASK_FILE
      else process.env.ALTIMATE_VALIDATORS_TASK_FILE = prior
    }
  })
})

describe("a leading qualifier does not erase the deliverable", () => {
  test("`Using dbt, create the model X` still yields a contract", () => {
    const r = extractRequiredDeliverables("Using dbt, create the model `orders`.\n")
    expect(r!.models).toEqual(["orders"])
  })

  test("`With the supplied source, build the model X` still yields a contract", () => {
    const r = extractRequiredDeliverables(
      "With the supplied source, build the model `fct_orders`.\n",
    )
    expect(r!.models).toEqual(["fct_orders"])
  })

  test("a qualifier after the name still stops attribute collection", () => {
    // `order_id` is a column, not a second required model.
    const r = extractRequiredDeliverables(
      "Create the model `fct_orders` with unique key `order_id`.\n",
    )
    expect(r!.models).toEqual(["fct_orders"])
  })
})

describe("a prohibition is not a requirement", () => {
  test("`Do not create the model X` does not make X required", () => {
    const r = extractRequiredDeliverables(
      "Do not create the model `legacy_orders`.\nCreate the model `fct_orders`.\n",
    )
    expect(r!.models).toEqual(["fct_orders"])
  })

  test("`never rename the model X` is likewise not a requirement", () => {
    expect(extractRequiredDeliverables("You should never rename the model `orders`.\n")).toBe(null)
  })

  test("an ordinary requirement line is unaffected", () => {
    const r = extractRequiredDeliverables("Create the model `fct_orders`.\n")
    expect(r!.models).toEqual(["fct_orders"])
  })
})

// ---------------------------------------------------------------------------
// Jinja handling
// ---------------------------------------------------------------------------

describe("Jinja statement tags are not raw SQL", () => {
  test("maskJinjaExpressions blanks {% … %} as well as {{ … }}", () => {
    const masked = maskJinjaExpressions("{% set v = safe_cast(a, b) %}\nselect {{ iff(a, b, c) }}")
    expect(masked).not.toContain("safe_cast")
    expect(masked).not.toContain("iff(")
    // Offsets are preserved so line numbers stay meaningful.
    expect(masked.split("\n").length).toBe(2)
  })

  test("a macro called from a set tag no longer produces a dialect finding", async () => {
    await makeProject("review-sweep-dialect-")
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "portable.sql"),
      "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% endif %}{% endmacro %}",
    )
    await writeModel("stg_orders", "{% set v = safe_cast(a, b) %}\nselect 1 as id")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["findings"]).toEqual([])
  })
})

describe("a guard chain's own elif counts as a guard", () => {
  test("the convention probe recognises an elif branch", async () => {
    await makeProject("review-sweep-dialect-")
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "portable.sql"),
      "{% macro ts() %}{% if false %}x{% elif target.type == 'bigquery' %}y{% endif %}{% endmacro %}",
    )
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })

  test("stripJinjaIfBlocks blanks a chain whose elif carries the condition", () => {
    const sql = "{% if a %}\nsafe_cast(x)\n{% elif target.type == 'bq' %}\nsafe_cast(y)\n{% endif %}"
    expect(stripJinjaIfBlocks(sql, /target\.type/i)).not.toContain("safe_cast")
  })

  test("a nested guard does not blank an outer block full of unguarded SQL", () => {
    const sql =
      "{% if a %}\nsafe_cast(outer)\n{% if target.type == 'bq' %}\nsafe_cast(inner)\n{% endif %}\n{% endif %}"
    const out = stripJinjaIfBlocks(sql, /target\.type/i)
    expect(out).toContain("safe_cast(outer)")
    expect(out).not.toContain("safe_cast(inner)")
  })
})

describe("is_incremental() blocks are matched by nesting, not by the first endif", () => {
  test("a compound condition is recognised", () => {
    const blocks = extractJinjaIfBlocks(
      "{% if is_incremental() and not is_full_refresh() %}\nwhere a > b\n{% endif %}",
      /is_incremental\s*\(\s*\)/i,
    )
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.body).toContain("where a > b")
  })

  test("a nested if does not truncate the block body", () => {
    const blocks = extractJinjaIfBlocks(
      "{% if is_incremental() %}\n{% if x %}a{% endif %}\nwhere loaded_at < current_timestamp\n{% endif %}",
      /is_incremental\s*\(\s*\)/i,
    )
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.body).toContain("current_timestamp")
  })

  test("jinjaIfBranchHead splits on the chain's own else, not a nested one", () => {
    const head = jinjaIfBranchHead("{% if x %}a{% else %}b{% endif %}\nwhere c\n{% else %}\nd")
    expect(head).toContain("where c")
    expect(head).not.toContain("\nd")
  })

  test("a nondeterministic predicate inside a compound guard now blocks", async () => {
    await makeProject("review-sweep-inc-")
    await writeModel(
      "fct_events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from src",
        "{% if is_incremental() and not is_full_refresh() %}",
        "  {% if var('x', false) %}-- note{% endif %}",
        "  where loaded_at > current_timestamp",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    const kinds = (r.details!["findings"] as Array<{ kind: string }>).map((f) => f.kind)
    expect(kinds).toContain("nondeterministic-predicate")
  })
})

describe("a qualified column is not the clock", () => {
  test("src.current_timestamp in the predicate does not block", async () => {
    await makeProject("review-sweep-inc-")
    await writeModel(
      "fct_events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from src",
        "{% if is_incremental() %}",
        "  where src.current_timestamp > (select max(loaded_at) from {{ this }})",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a bare current_timestamp in the predicate still blocks", async () => {
    await makeProject("review-sweep-inc-")
    await writeModel(
      "fct_events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from src",
        "{% if is_incremental() %}",
        "  where loaded_at > current_timestamp",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
  })
})

describe("idempotency negation is scoped to the idempotency clause", () => {
  beforeEach(async () => {
    await makeProject("review-sweep-idem-")
  })

  const model = [
    "{{ config(materialized='incremental') }}",
    "select * from src",
  ].join("\n")

  test("an unrelated negation on the demand line no longer disables the check", async () => {
    await writeModel("fct_events", model)
    await fs.writeFile(
      join(dir, "TASK.md"),
      "The model must be idempotent and must not depend on the current time.\n",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    const kinds = (r.details!["findings"] as Array<{ kind: string }>).map((f) => f.kind)
    expect(kinds).toContain("missing-is-incremental-guard")
  })

  test("an explicit disclaimer still switches the check off", async () => {
    await writeModel("fct_events", model)
    await fs.writeFile(join(dir, "TASK.md"), "Idempotency is not required for this model.\n")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.details!["idempotency_demanded"]).toBe(false)
  })

  test("a pre-word disclaimer still switches the check off", async () => {
    await writeModel("fct_events", model)
    await fs.writeFile(join(dir, "TASK.md"), "The model need not be idempotent.\n")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.details!["idempotency_demanded"]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// nothing-built evidence
// ---------------------------------------------------------------------------

describe("an operation row is not a built deliverable", () => {
  test("a successful operation row alone does not clear the gate", async () => {
    await makeProject("review-sweep-nb-")
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    await writeRunResults([{ id: "operation.t.on-run-end-0", status: "success" }])
    // Written before the session started, so the task file is not "authored".
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() + 60_000 }))
    expect(r.ok).toBe(false)
    expect(r.details!["fresh_run_results"]).toBe(false)
  })

  test("a successful model row still clears the gate", async () => {
    await makeProject("review-sweep-nb-")
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    await writeRunResults([{ id: "model.t.fct_orders", status: "success" }])
    const r = await DbtNothingBuiltValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})
// ---------------------------------------------------------------------------
// Second review wave — findings raised against the sweep commit itself
// ---------------------------------------------------------------------------

describe("a lowercase task filename stays reachable on a case-sensitive volume", () => {
  test("a workspace whose only task document is task.md still yields a contract", async () => {
    await makeProject("review-sweep-case-")
    await fs.writeFile(join(dir, "task.md"), "Create the model `fct_orders`.\n")
    const found = await findTaskInstructionFiles(dir, null)
    expect(found.length).toBeGreaterThan(0)
    expect(await DbtNothingBuiltValidator.appliesTo(ctx())).toBe(true)
  })

  test("one file reachable under two spellings is reported once", async () => {
    // On APFS/NTFS `TASK.md` and `task.md` are the same file; dedup is by
    // resolved identity, so it appears once rather than twice.
    await makeProject("review-sweep-case-")
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    const found = await findTaskInstructionFiles(dir, null)
    const bases = found.map((f) => f.path.toLowerCase())
    expect(new Set(bases).size).toBe(bases.length)
  })
})

describe("a null unique_key does not pass, spaced or unspaced", () => {
  const spellings = [
    "unique_key=None",
    "unique_key = None",
    "unique_key= null",
    "unique_key = null",
    "unique_key = ''",
    "unique_key = []",
  ]
  for (const spelling of spellings) {
    test(`\`${spelling}\` is treated as no key`, async () => {
      await makeProject("review-sweep-key-")
      await writeModel(
        "fct_events",
        `{{ config(materialized='incremental', incremental_strategy='merge', ${spelling}) }}\nselect 1 as id`,
      )
      const r = await DbtIncrementalConfigValidator.check(ctx())
      expect(r.ok).toBe(false)
      const kinds = (r.details!["findings"] as Array<{ kind: string }>).map((f) => f.kind)
      expect(kinds).toContain("upsert-without-unique-key")
    })
  }

  test("a real key still passes", async () => {
    await makeProject("review-sweep-key-")
    await writeModel(
      "fct_events",
      "{{ config(materialized='incremental', incremental_strategy='merge', unique_key = 'id') }}\nselect 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

describe("a projected boolean is not the row-selection predicate", () => {
  test("random() in a projection before a deterministic where does not block", async () => {
    await makeProject("review-sweep-pred-")
    await writeModel(
      "fct_events",
      [
        "{{ config(materialized='incremental') }}",
        "select *, (is_active and random() > 0.5) as sampled from src",
        "{% if is_incremental() %}",
        "  where loaded_at > (select max(loaded_at) from {{ this }})",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })

  test("a bare `and` fragment guard is still inspected", async () => {
    await makeProject("review-sweep-pred-")
    await writeModel(
      "fct_events",
      [
        "{{ config(materialized='incremental') }}",
        "select * from src",
        "{% if is_incremental() %}",
        "  and loaded_at > current_timestamp",
        "{% endif %}",
      ].join("\n"),
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
  })
})

describe("the idempotency demand is read from every task document", () => {
  test("an informational TASK.md no longer hides a REQUIREMENTS.md demand", async () => {
    await makeProject("review-sweep-idem2-")
    await fs.writeFile(join(dir, "TASK.md"), "Background about this repository.\n")
    await fs.writeFile(join(dir, "REQUIREMENTS.md"), "Reruns must be idempotent.\n")
    await writeModel("fct_events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.details!["idempotency_demanded"]).toBe(true)
    const kinds = (r.details!["findings"] as Array<{ kind: string }>).map((f) => f.kind)
    expect(kinds).toContain("missing-is-incremental-guard")
  })
})

describe("Jinja modulo in a guard condition does not defeat the guard", () => {
  test("stripJinjaIfBlocks matches an opener containing `%`", () => {
    const sql = "{% if target.type == 'snowflake' and n % 2 == 0 %}\niff(a, b, c)\n{% endif %}"
    expect(stripJinjaIfBlocks(sql, /target\.type/i)).not.toContain("iff(")
  })

  test("a guarded call in such a block is not reported", async () => {
    await makeProject("review-sweep-mod-")
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "portable.sql"),
      "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% endif %}{% endmacro %}",
    )
    await writeModel(
      "stg_orders",
      "{% if target.type == 'snowflake' and 4 % 2 == 0 %}\nselect iff(a, b, c) as x\n{% endif %}",
    )
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.details!["findings"]).toEqual([])
  })
})

describe("the guard-convention probe ignores text inside string literals", () => {
  test("a target.type mention inside a literal does not activate the lint", async () => {
    await makeProject("review-sweep-probe-")
    await writeModel(
      "stg_orders",
      "select '{% if target.type == ''snowflake'' %}' as note, iff(a, b, c) as flag from t",
    )
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(false)
  })

  test("a real guard still activates it", async () => {
    await makeProject("review-sweep-probe-")
    await writeModel(
      "stg_orders",
      "{% if target.type == 'snowflake' %}select 1{% else %}select 2{% endif %}",
    )
    expect(await DbtDialectGuardValidator.appliesTo(ctx())).toBe(true)
  })
})
// altimate_change end

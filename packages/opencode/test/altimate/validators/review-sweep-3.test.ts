// altimate_change start — regression tests for the third PR-1175 review sweep
/**
 * One test per defect closed in the third review sweep on the deterministic
 * completion gates (the P1/P2 threads raised after `review-sweep-2`).
 *
 * Same house rule as the earlier sweeps: every test here is checked to FAIL
 * against the pre-fix code before being counted as done. Fixtures, not
 * mocks — each test builds a real dbt project on disk.
 */

import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtBuildGreenValidator } from "../../../src/altimate/validators/dbt-build-green"
import { DbtNothingBuiltValidator } from "../../../src/altimate/validators/dbt-nothing-built"
import { DbtDeliverableNamesValidator } from "../../../src/altimate/validators/dbt-deliverable-names"
import { DbtDialectGuardValidator } from "../../../src/altimate/validators/dbt-dialect-guard"
import {
  extractRequiredDeliverables,
  collectProducedNodeNames,
  collectRunResultExemptModels,
  resolveDbtSourcePaths,
  stripInactiveJinja,
  sourceExemptsFromRunResults,
  maskSqlStringLiterals,
  stripJinjaIfBlocks,
  isUnderAnyDir,
  resolveWithinRoot,
  sanitizeTelemetryDetails,
} from "../../../src/altimate/validators/validator-utils"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(prefix = "review-sweep-3-"): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), prefix))
  await fs.writeFile(
    join(dir, "dbt_project.yml"),
    "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n",
  )
  await fs.mkdir(join(dir, "models"), { recursive: true })
  return dir
}

async function writeModel(name: string, sql = "select 1 as id"): Promise<void> {
  await fs.mkdir(join(dir, "models"), { recursive: true })
  await fs.writeFile(join(dir, "models", `${name}.sql`), sql)
}

async function writeRunResults(
  nodes: Array<{ id: string; status: string }>,
  which: string | null = "build",
  mtimeOffsetMs = 0,
): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  const path = join(dir, "target", "run_results.json")
  await fs.writeFile(
    path,
    JSON.stringify({
      metadata: { dbt_schema_version: "v5" },
      args: which === null ? {} : { which },
      results: nodes.map((n) => ({ unique_id: n.id, status: n.status, message: null })),
    }),
  )
  const t = (Date.now() + mtimeOffsetMs) / 1000
  await fs.utimes(path, t, t)
}

async function writeManifest(
  nodes: Record<string, Record<string, unknown>>,
  disabled: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  await fs.writeFile(
    join(dir, "target", "manifest.json"),
    JSON.stringify({ nodes, disabled }),
  )
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
// Thread: reject stale manifest entries before granting exemptions
// ---------------------------------------------------------------------------

describe("a stale manifest entry cannot exempt a fresh model from coverage", () => {
  test("an exemption whose original_file_path no longer exists is not honoured", async () => {
    await makeProject()
    // The manifest survives from BEFORE a branch switch: it marks `orders`
    // disabled, but the file it says defines that node is gone.
    await writeManifest({
      "model.dep.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/gone_orders.sql",
        config: { enabled: false },
      },
    })
    // The session then writes an ordinary, ENABLED `orders.sql` — a brand new
    // model that happens to share the stale entry's bare name.
    await writeModel("orders", "select 1 as id")
    // A fresh `build` artifact that says nothing about `orders` at all.
    await writeRunResults([{ id: "model.t.other", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
  })

  test("collectRunResultExemptModels ignores a disabled node whose file is gone", async () => {
    await makeProject()
    await writeManifest({
      "model.dep.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/gone_orders.sql",
        config: { enabled: false, materialized: "ephemeral" },
      },
      "model.dep.still_here": {
        name: "still_here",
        resource_type: "model",
        original_file_path: "models/still_here.sql",
        config: { enabled: false },
      },
    })
    await writeModel("still_here", "select 1")
    const exempt = await collectRunResultExemptModels(dir)
    expect(exempt.disabled.has("orders")).toBe(false)
    expect(exempt.ephemeral.has("orders")).toBe(false)
    expect(exempt.disabled.has("still_here")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: match node extensions to their dbt source directories
// ---------------------------------------------------------------------------

describe("node inventory only counts files under the matching source-path kind", () => {
  test("a .csv under models/ does not read as a produced model node", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "models", "orders.csv"), "id\n1\n")
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("orders")).toBe(false)
  })

  test("a .sql under seeds/ does not read as a produced seed node", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "seeds"), { recursive: true })
    await fs.writeFile(join(dir, "seeds", "orders.sql"), "select 1")
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("orders")).toBe(false)
  })

  test("a .csv under seeds/ still counts", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "seeds"), { recursive: true })
    await fs.writeFile(join(dir, "seeds", "orders.csv"), "id\n1\n")
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("orders")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: strip other literal-false Jinja arms before reading config
// ---------------------------------------------------------------------------

describe("every literal-false Jinja arm is dead, not just the bare word", () => {
  test("{% if 0 %} is recognised as dead", () => {
    const sql = "{% if 0 %}{{ config(enabled=false) }}{% endif %}\nselect 1"
    expect(stripInactiveJinja(sql)).not.toContain("enabled=false")
  })

  test("a live enabled model is not exempted because of a dead {% if 0 %} arm", async () => {
    await makeProject()
    const sql =
      "{% if 0 %}{{ config(enabled=false) }}{% endif %}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
    await writeModel("orders", sql)
    await writeRunResults([{ id: "model.t.other", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
  })
})

// ---------------------------------------------------------------------------
// Thread: treat empty model-executing artifacts as failed coverage
// ---------------------------------------------------------------------------

describe("an empty selection from a build/run command is failed coverage, not inconclusive", () => {
  test("a fresh `dbt build` with zero model rows blocks an edited model", async () => {
    await makeProject()
    await writeModel("orders", "select 1 as id")
    // Command WAS `build` (model-executing), but the selection matched
    // nothing — zero model rows, and no DDL under target/run/ either.
    await writeRunResults([], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["verdict"]).not.toBe("coverage-inconclusive")
    expect(r.details!["not_built"]).toEqual(["orders"])
  })
})

// ---------------------------------------------------------------------------
// Thread: parse top-level config keys before granting exemptions
// ---------------------------------------------------------------------------

describe("exemptions are read from top-level config keys, not any matching substring", () => {
  test("`enabled=false` inside an unrelated hook string does not exempt the model", async () => {
    await makeProject()
    const sql =
      "{{ config(pre_hook=\"insert into audit_log values ('enabled=false')\") }}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
    await writeModel("orders", sql)
    await writeRunResults([{ id: "model.t.other", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
  })

  test("a real top-level enabled=false still exempts", () => {
    const sql = "{{ config(materialized='table', enabled=false) }}\nselect 1"
    expect(sourceExemptsFromRunResults(sql)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: match run results by full model identity
// ---------------------------------------------------------------------------

describe("run-result rows are matched to the touched model's OWN manifest node", () => {
  test("a dependency's success under the same bare name does not cover the root model", async () => {
    await makeProject()
    await writeManifest({
      "model.rootproj.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/orders.sql",
        config: {},
      },
      "model.some_dep.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "dbt_packages/some_dep/models/orders.sql",
        config: {},
      },
    })
    await writeModel("orders", "select 1 as id")
    // Only the DEPENDENCY's node succeeded; the root project's own `orders`
    // was never selected or executed.
    await writeRunResults([{ id: "model.some_dep.orders", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["orders"])
  })

  test("the root model's own success is still recognised", async () => {
    await makeProject()
    await writeManifest({
      "model.rootproj.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/orders.sql",
        config: {},
      },
    })
    await writeModel("orders", "select 1 as id")
    // Backdate the model file well outside the build-freshness tolerance so
    // this asserts a clean `fresh-build`, not the unrelated (and legitimate)
    // `build-unproven` a model edited within the grace window would also get.
    await fs.utimes(
      join(dir, "models", "orders.sql"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await writeRunResults([{ id: "model.rootproj.orders", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("fresh-build")
  })
})

// ---------------------------------------------------------------------------
// Thread: sanitize unrequested names / merge requirements from every document
// ---------------------------------------------------------------------------

describe("dbt-deliverable-names merges the contract across every task document", () => {
  test("a REQUIREMENTS.md deliverable is required even when TASK.md also has one", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    await fs.writeFile(join(dir, "REQUIREMENTS.md"), "Create the model `dim_customers`.\n")
    await writeModel("fct_orders")
    // dim_customers is NOT created.
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["missing_models"]).toEqual(["dim_customers"])
  })

  test("both documents' contracts are satisfied when both are delivered", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    await fs.writeFile(join(dir, "REQUIREMENTS.md"), "Create the model `dim_customers`.\n")
    await writeModel("fct_orders")
    await writeModel("dim_customers")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: require session work for update and fix contracts
// ---------------------------------------------------------------------------

describe("an update/fix contract cannot be satisfied by pre-existing presence alone", () => {
  test("a pre-existing, untouched `orders` does not satisfy 'update the model `orders`'", async () => {
    await makeProject()
    await writeModel("orders", "select 1 as id")
    // The model already existed BEFORE the session started, and the session
    // touches nothing.
    await fs.utimes(
      join(dir, "models", "orders.sql"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await fs.writeFile(join(dir, "TASK.md"), "Update the model `orders` to add a column.\n")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
  })

  test("a create contract IS satisfied by pre-existing presence (unaffected)", async () => {
    await makeProject()
    await writeModel("orders", "select 1 as id")
    await fs.utimes(
      join(dir, "models", "orders.sql"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `orders`.\n")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(true)
  })

  test("actually updating (touching) the model satisfies the contract", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Update the model `orders` to add a column.\n")
    await writeModel("orders", "select 1 as id, 2 as new_col")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: keep unguarded arms visible when only an elif is guarded
// ---------------------------------------------------------------------------

describe("stripJinjaIfBlocks only blanks the arm whose OWN condition matches", () => {
  test("an unguarded if-arm survives when only its elif carries the guard", () => {
    const sql =
      "{% if execute %}\niff(a, b, c)\n{% elif target.type == 'snowflake' %}\niff(d, e, f)\n{% endif %}"
    const out = stripJinjaIfBlocks(sql, /target\.type/i)
    expect(out).toContain("iff(a, b, c)")
    expect(out).not.toContain("iff(d, e, f)")
  })

  test("dbt-dialect-guard flags the genuinely unguarded call in the if-arm", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "portable.sql"),
      "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% endif %}{% endmacro %}",
    )
    await writeModel(
      "stg_orders",
      "{% if execute %}\nselect iff(a, b, c) as x\n{% elif target.type == 'snowflake' %}\nselect 1\n{% endif %}",
    )
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect((r.details!["findings"] as unknown[]).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Thread: require only the destination of a rename
// ---------------------------------------------------------------------------

describe("a rename requirement only demands the destination name", () => {
  test("the source name is not required to still exist", async () => {
    await makeProject()
    await fs.writeFile(
      join(dir, "TASK.md"),
      "Rename the model `old_orders` to `new_orders`.\n",
    )
    await writeModel("new_orders")
    // old_orders does NOT exist — the rename correctly removed it.
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: detect guard conventions before edits can erase them (packages exclusion)
// ---------------------------------------------------------------------------

describe("the guard-convention probe does not treat a package's own guard as this project's convention", () => {
  test("a target.type guard that only exists under the packages install dir does not switch the lint on", async () => {
    await makeProject()
    // An unusual but real configuration: the packages install path nests
    // under the default `macros/` source path, so scanning `macros/`
    // recursively without excluding `sourcePaths.packages` walks straight
    // into the installed dependency's own macros.
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\npackages-install-path: macros/dbt_packages\n",
    )
    await fs.mkdir(join(dir, "macros", "dbt_packages", "some_dep", "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "dbt_packages", "some_dep", "macros", "portable.sql"),
      "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% endif %}{% endmacro %}",
    )
    // The ROOT project itself establishes no target.type convention anywhere.
    // `check()` itself does not re-verify the convention — only `appliesTo`
    // decides whether the gate runs at all — so the relevant assertion is on
    // `appliesTo`, matching how the dispatch framework actually uses it.
    await writeModel("stg_orders", "select iff(a, b, c) as x")
    const applies = await DbtDialectGuardValidator.appliesTo(ctx())
    expect(applies).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Thread: mask dollar-quoted SQL literals before dialect matching
// ---------------------------------------------------------------------------

describe("a dollar-quoted literal is masked like any other string literal", () => {
  test("maskSqlStringLiterals blanks the body of a $$ ... $$ literal", () => {
    const sql = "select $$ iff(a, b, c) $$ as note"
    expect(maskSqlStringLiterals(sql)).not.toContain("iff(")
  })

  test("dbt-dialect-guard does not flag a dialect call quoted inside $$ $$", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "macros", "portable.sql"),
      "{% macro ts() %}{% if target.type == 'duckdb' %}now(){% endif %}{% endmacro %}",
    )
    await writeModel("stg_orders", "select $$ this is not iff(a, b, c) call $$ as note")
    const r = await DbtDialectGuardValidator.check(ctx())
    expect(r.details!["findings"]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Thread: bound creation verbs to actual requirement inflections
// ---------------------------------------------------------------------------

describe("REQUIREMENT_VERB_RE only matches real inflections of its verbs", () => {
  test("'production model' does not match the 'produce' verb stem", () => {
    const parsed = extractRequiredDeliverables(
      "Background: the production model `legacy_orders` was retired last quarter.\n",
    )
    expect(parsed).toBeNull()
  })

  test("'produced' still matches", () => {
    const parsed = extractRequiredDeliverables("Produce the model `fct_orders`.\n")
    expect(parsed?.models).toEqual(["fct_orders"])
  })
})

// ---------------------------------------------------------------------------
// Thread: normalize Windows separators before classifying file paths
// ---------------------------------------------------------------------------

describe("a Windows-spelled path is still classified as a required file", () => {
  test("models\\marts\\orders.sql yields a file and model requirement", () => {
    const parsed = extractRequiredDeliverables("Create `models\\marts\\orders.sql`.\n")
    expect(parsed).not.toBeNull()
    expect(parsed!.files).toEqual(["models/marts/orders.sql"])
    expect(parsed!.models).toEqual(["orders"])
  })
})

// ---------------------------------------------------------------------------
// Thread: derive relation names only from relation-producing paths
// ---------------------------------------------------------------------------

describe("a macro-only file path does not derive a required model", () => {
  test("`macros/generate_schema_name.sql` requires the file but not a model", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "macros"), { recursive: true })
    await fs.writeFile(
      join(dir, "TASK.md"),
      "Create the file `macros/generate_schema_name.sql`.\n",
    )
    await fs.writeFile(join(dir, "macros", "generate_schema_name.sql"), "{% macro x() %}{% endmacro %}")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["required_models"]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Thread: split inline YAML path lists without breaking Jinja arguments
// ---------------------------------------------------------------------------

describe("readDbtProjectPathList handles Jinja commas and multi-line flow sequences", () => {
  test("a Jinja env_var() with a default value is not split on its internal comma", async () => {
    await makeProject()
    process.env["ALTIMATE_TEST_MODEL_DIR"] = "transform"
    try {
      await fs.writeFile(
        join(dir, "dbt_project.yml"),
        "name: t\nmodel-paths: [\"{{ env_var('ALTIMATE_TEST_MODEL_DIR', 'fallback') }}\"]\n",
      )
      const paths = await resolveDbtSourcePaths(dir)
      expect(paths.models).toEqual([join(dir, "transform")])
    } finally {
      delete process.env["ALTIMATE_TEST_MODEL_DIR"]
    }
  })

  test("a flow sequence spanning multiple lines is read through its closing bracket", async () => {
    await makeProject()
    await fs.writeFile(
      join(dir, "dbt_project.yml"),
      "name: t\nmodel-paths: [\n  \"transform\",\n  \"more_models\"\n]\n",
    )
    const paths = await resolveDbtSourcePaths(dir)
    expect(paths.models.sort()).toEqual([join(dir, "more_models"), join(dir, "transform")].sort())
  })
})

// ---------------------------------------------------------------------------
// Thread: preserve case-sensitive source-directory boundaries
// ---------------------------------------------------------------------------

describe("isUnderAnyDir respects the platform's filesystem case sensitivity", () => {
  test("case folding only happens on a case-insensitive-by-default platform", () => {
    const caseInsensitivePlatform = process.platform === "darwin" || process.platform === "win32"
    const result = isUnderAnyDir("/proj/Models/orders.sql", ["/proj/models"])
    expect(result).toBe(caseInsensitivePlatform)
  })

  test("an exact-case match always matches regardless of platform", () => {
    expect(isUnderAnyDir("/proj/models/orders.sql", ["/proj/models"])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thread: reject a required file path that escapes the workspace
// ---------------------------------------------------------------------------

describe("a required file path cannot escape the workspace root", () => {
  test("resolveWithinRoot refuses a ../ escape", async () => {
    expect(await resolveWithinRoot("/workspace/proj", "../../etc/passwd")).toBeNull()
  })

  test("resolveWithinRoot accepts an ordinary relative path", async () => {
    expect(await resolveWithinRoot("/workspace/proj", "models/orders.sql")).toBe(
      "/workspace/proj/models/orders.sql",
    )
  })

  test("resolveWithinRoot refuses a symlinked directory that escapes the root", async () => {
    await makeProject()
    const outsideDir = await fs.mkdtemp(join(tmpdir(), "review-sweep-3-symlink-outside-"))
    await fs.writeFile(join(outsideDir, "secret.yml"), "x: 1\n")
    // `models/` inside the workspace is a symlink pointing OUTSIDE it. The
    // candidate resolves lexically inside `root` but its real parent does not.
    await fs.rm(join(dir, "models"), { recursive: true, force: true })
    await fs.symlink(outsideDir, join(dir, "models"))
    try {
      expect(await resolveWithinRoot(dir, "models/secret.yml")).toBeNull()
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test("dbt-nothing-built cannot be satisfied by a file outside the workspace", async () => {
    await makeProject()
    // A real file exists OUTSIDE the project, at the path the traversal would
    // resolve to.
    const outsideDir = await fs.mkdtemp(join(tmpdir(), "review-sweep-3-outside-"))
    await fs.writeFile(join(outsideDir, "secret.yml"), "x: 1\n")
    const relative = "../" + outsideDir.split("/").pop() + "/secret.yml"
    await fs.writeFile(
      join(dir, "TASK.md"),
      `Create the file \`${relative}\`.\n`,
    )
    try {
      const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
      expect(r.ok).toBe(false)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Thread: remove absolute paths from validator telemetry
// ---------------------------------------------------------------------------

describe("sanitizeTelemetryDetails hashes absolute paths and leaves everything else", () => {
  test("an absolute dbt_root is replaced with a hash", () => {
    const out = sanitizeTelemetryDetails({ dbt_root: "/Users/alice/repos/my-project", verdict: "fresh-build" })
    expect(out["dbt_root"]).not.toBe("/Users/alice/repos/my-project")
    expect(String(out["dbt_root"])).toMatch(/^path:[0-9a-f]{12}$/)
    expect(String(out["dbt_root"])).not.toContain("alice")
    expect(out["verdict"]).toBe("fresh-build")
  })

  test("a Windows absolute path is also redacted", () => {
    const out = sanitizeTelemetryDetails({ run_results_path: "C:\\Users\\alice\\project\\target\\run_results.json" })
    expect(String(out["run_results_path"])).toMatch(/^path:[0-9a-f]{12}$/)
  })

  test("relative and identifier-shaped strings pass through unchanged", () => {
    const out = sanitizeTelemetryDetails({
      required_models: ["orders", "fct_orders"],
      not_built: ["orders"],
      nested: { still_a_model_name: "orders" },
    })
    expect(out["required_models"]).toEqual(["orders", "fct_orders"])
    expect(out["not_built"]).toEqual(["orders"])
    expect((out["nested"] as Record<string, unknown>)["still_a_model_name"]).toBe("orders")
  })

  test("the same path hashes identically across calls (stable for dedup)", () => {
    const a = sanitizeTelemetryDetails({ dbt_root: "/tmp/proj" })
    const b = sanitizeTelemetryDetails({ dbt_root: "/tmp/proj" })
    expect(a["dbt_root"]).toBe(b["dbt_root"])
  })
})
// altimate_change end

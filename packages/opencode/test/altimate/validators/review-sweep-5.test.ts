// altimate_change start — regression tests for the fifth PR-1175 review sweep
/**
 * One test per defect the bot reviewers found on the fourth-sweep fix commit
 * (677b00bb19). Same house rule: every test here is checked to FAIL against
 * the code as it stood immediately after that commit.
 */

import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtBuildGreenValidator } from "../../../src/altimate/validators/dbt-build-green"
import { DbtDeliverableNamesValidator } from "../../../src/altimate/validators/dbt-deliverable-names"
import { DbtNothingBuiltValidator } from "../../../src/altimate/validators/dbt-nothing-built"
import { DbtIncrementalConfigValidator } from "../../../src/altimate/validators/dbt-incremental-config"
import {
  collectProducedNodeNames,
  sourceExemptsFromRunResults,
  resolveWithinRoot,
} from "../../../src/altimate/validators/validator-utils"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(prefix = "review-sweep-5-"): Promise<string> {
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
  const t = Date.now() / 1000
  await fs.utimes(path, t, t)
}

async function writeManifest(nodes: Record<string, Record<string, unknown>>): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  await fs.writeFile(join(dir, "target", "manifest.json"), JSON.stringify({ nodes, disabled: {} }))
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
// Exclude dependency nodes from deliverable inventory
// ---------------------------------------------------------------------------

describe("collectProducedNodeNames excludes manifest nodes that belong to a dependency package", () => {
  test("an installed package's own `orders` model does not satisfy a required root `orders`", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "dbt_packages", "some_dep", "models"), { recursive: true })
    await fs.writeFile(join(dir, "dbt_packages", "some_dep", "models", "orders.sql"), "select 1")
    await writeManifest({
      "model.some_dep.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "dbt_packages/some_dep/models/orders.sql",
        config: {},
      },
    })
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("orders")).toBe(false)
  })

  test("the root project's own orders model still counts", async () => {
    await makeProject()
    await writeModel("orders")
    await writeManifest({
      "model.rootproj.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/orders.sql",
        config: {},
      },
    })
    const produced = await collectProducedNodeNames(dir)
    expect(produced.has("orders")).toBe(true)
  })

  test("end to end: dbt-deliverable-names does not pass on a dependency's model alone", async () => {
    await makeProject()
    await fs.mkdir(join(dir, "dbt_packages", "some_dep", "models"), { recursive: true })
    await fs.writeFile(join(dir, "dbt_packages", "some_dep", "models", "orders.sql"), "select 1")
    await writeManifest({
      "model.some_dep.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "dbt_packages/some_dep/models/orders.sql",
        config: {},
      },
    })
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `orders`.\n")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Filter authored relation names by valid dbt extensions
// ---------------------------------------------------------------------------

describe("an inert file extension under models/ does not satisfy a model update contract", () => {
  test("writing orders.txt does not count as authoring the orders model", async () => {
    await makeProject()
    await writeModel("orders", "select 1 as id")
    await fs.utimes(
      join(dir, "models", "orders.sql"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await fs.writeFile(join(dir, "TASK.md"), "Update the model `orders` to add a column.\n")
    // The session writes an inert .txt file under models/ instead of editing
    // the real .sql file.
    await fs.writeFile(join(dir, "models", "orders.txt"), "notes")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
  })

  test("writing the real .sql file still satisfies the contract", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Update the model `orders` to add a column.\n")
    await writeModel("orders", "select 1 as id, 2 as new_col")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sanitize the task-file path in the retry prompt
// ---------------------------------------------------------------------------

describe("dbt-deliverable-names sanitizes its own task-file path in fixHint", () => {
  test("the hint carries the sanitizer's delimiters around the task file path", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Create the model `fct_orders`.\n")
    const r = await DbtDeliverableNamesValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.fixHint).toContain("«")
    expect(r.fixHint).toMatch(/«[^»]*TASK\.md[^»]*»/)
  })
})

// ---------------------------------------------------------------------------
// Reject exemptions from unresolved conditional config
// ---------------------------------------------------------------------------

describe("a config() call inside a runtime-dependent conditional does not grant a source-level exemption", () => {
  test("materialized=ephemeral behind target.name == 'dev' is not trusted as a static exemption", () => {
    const sql = "{% if target.name == 'dev' %}{{ config(enabled=false) }}{% endif %}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
  })

  test("end to end: a fresh error row for the model is not classified out of scope", async () => {
    await makeProject()
    const sql = "{% if target.name == 'dev' %}{{ config(enabled=false) }}{% endif %}\nselect 1 as id"
    await writeModel("orders", sql)
    await writeRunResults([{ id: "model.t.orders", status: "error" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
  })

  test("an unconditional exemption is still honoured (unaffected)", () => {
    const sql = "{{ config(enabled=false) }}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(true)
  })

  test("a statically-dead {% if false %} arm's exemption is still honoured (unaffected)", () => {
    const sql = "{% if false %}{{ config(enabled=false) }}{% endif %}\nselect 1"
    // The if-arm is dead — stripInactiveJinja already removes it — so this
    // call is never even seen as conditional; it contributes nothing, same
    // as before this fix. (No exemption either way, since the call is gone.)
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
  })

  test("an ephemeral exemption in the surviving else-arm of an if-false/else chain is still honoured", () => {
    const sql =
      "{% if false %}{{ config(enabled=true) }}{% else %}{{ config(materialized='ephemeral') }}{% endif %}\nselect 1"
    // The dead if-arm (including its own opening tag) is blanked away, so the
    // else-arm's config() call is no longer inside any remaining {% if %}
    // span — it must still grant the exemption.
    expect(sourceExemptsFromRunResults(sql)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Do not treat optional idempotency as a requirement
// ---------------------------------------------------------------------------

describe("optional/advisory idempotency wording does not trigger the missing-guard finding", () => {
  test("'Idempotency is optional for the events model' does not block a guardless model", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "Idempotency is optional for the `events` model.\n")
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    const findings = r.details!["findings"] as Array<{ model: string; kind: string }>
    expect(findings.some((f) => f.model === "events" && f.kind === "missing-is-incremental-guard")).toBe(
      false,
    )
  })

  test("an affirmative idempotency demand is unaffected", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "The `events` model must be idempotent on re-run.\n")
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    const findings = r.details!["findings"] as Array<{ model: string; kind: string }>
    expect(findings.some((f) => f.model === "events" && f.kind === "missing-is-incremental-guard")).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// resolveWithinRoot: symlink-escape (Kilo suggestion)
// ---------------------------------------------------------------------------

describe("resolveWithinRoot resolves real paths, not just lexical ones", () => {
  test("a symlinked subdirectory pointing outside the root is refused", async () => {
    await makeProject()
    const outsideDir = await fs.mkdtemp(join(tmpdir(), "review-sweep-5-outside-"))
    await fs.writeFile(join(outsideDir, "secret.csv"), "id\n1\n")
    await fs.rm(join(dir, "models"), { recursive: true, force: true })
    await fs.symlink(outsideDir, join(dir, "models"))
    try {
      expect(await resolveWithinRoot(dir, "models/secret.csv")).toBeNull()
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test("an ordinary (non-symlinked) path still resolves", async () => {
    await makeProject()
    const resolved = await resolveWithinRoot(dir, "models/orders.sql")
    expect(resolved).toBe(join(dir, "models", "orders.sql"))
  })
})
// altimate_change end

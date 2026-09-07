// altimate_change start — regression tests for the fourth PR-1175 review sweep
/**
 * One test per defect the bot reviewer found on the third-sweep fix commit
 * itself (3d2f6e96be) — sibling code paths the earlier fixes did not reach,
 * plus one genuine regression the top-level config rewrite introduced.
 *
 * Same house rule: every test here is checked to FAIL against the code as it
 * stood immediately after 3d2f6e96be, before being counted as done.
 */

import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtBuildGreenValidator } from "../../../src/altimate/validators/dbt-build-green"
import { DbtIncrementalConfigValidator } from "../../../src/altimate/validators/dbt-incremental-config"
import { DbtNothingBuiltValidator } from "../../../src/altimate/validators/dbt-nothing-built"
import {
  sourceExemptsFromRunResults,
  sanitizeTelemetryDetails,
} from "../../../src/altimate/validators/validator-utils"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(prefix = "review-sweep-4-"): Promise<string> {
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
// Parse incremental config at the top level (dbt-incremental-config.ts)
// ---------------------------------------------------------------------------

describe("dbt-incremental-config reads unique_key/strategy from top-level config only", () => {
  test("a hook string containing 'unique_key=' text does not forge a real key", async () => {
    await makeProject()
    await writeModel(
      "orders",
      "{{ config(materialized='incremental', incremental_strategy='merge', " +
        "pre_hook=\"insert into audit_log values ('unique_key=''id''')\") }}\nselect 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    const findings = r.details!["findings"] as Array<{ kind: string }>
    expect(findings.some((f) => f.kind === "upsert-without-unique-key")).toBe(true)
  })

  test("a real top-level unique_key still suppresses the finding", async () => {
    await makeProject()
    await writeModel(
      "orders",
      "{{ config(materialized='incremental', incremental_strategy='merge', unique_key='id') }}\nselect 1 as id",
    )
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scope idempotency demands to the named model (P2, dbt-incremental-config.ts)
// ---------------------------------------------------------------------------

describe("an idempotency demand scoped to one model does not block a separate append-only model", () => {
  test("naming `orders` in the demand does not force a guard on `events`", async () => {
    await makeProject()
    await fs.writeFile(
      join(dir, "TASK.md"),
      "Make `orders` idempotent on re-run.\nAlso update the append-only `events` model.\n",
    )
    await writeModel(
      "orders",
      "{{ config(materialized='incremental') }}\n{% if is_incremental() %}\nwhere loaded_at > (select max(loaded_at) from {{ this }})\n{% endif %}\nselect 1 as id, current_timestamp as loaded_at",
    )
    // events is intentionally append-only: no is_incremental() guard.
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    const findings = r.details!["findings"] as Array<{ model: string; kind: string }>
    expect(findings.some((f) => f.model === "events" && f.kind === "missing-is-incremental-guard")).toBe(
      false,
    )
  })

  test("an unscoped, workspace-wide demand still applies to every incremental model", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "TASK.md"), "All models must be idempotent on re-run.\n")
    await writeModel("events", "{{ config(materialized='incremental') }}\nselect 1 as id")
    const r = await DbtIncrementalConfigValidator.check(ctx())
    expect(r.ok).toBe(false)
    const findings = r.details!["findings"] as Array<{ model: string; kind: string }>
    expect(findings.some((f) => f.model === "events" && f.kind === "missing-is-incremental-guard")).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// Scope failed rows by manifest unique ID (dbt-build-green.ts)
// ---------------------------------------------------------------------------

describe("a failed row is only in scope when it is THIS session's own model", () => {
  test("a dependency's failure under the same bare name does not block a correctly built local edit", async () => {
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
    await fs.utimes(
      join(dir, "models", "orders.sql"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    // The LOCAL model succeeded; only the unrelated DEPENDENCY node failed.
    await writeRunResults(
      [
        { id: "model.rootproj.orders", status: "success" },
        { id: "model.some_dep.orders", status: "error" },
      ],
      "build",
    )
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["failed_in_scope"]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Track modification requirements for files (dbt-nothing-built.ts)
// ---------------------------------------------------------------------------

describe("an update contract on a FILE cannot be satisfied by pre-session existence alone", () => {
  test("a pre-existing, untouched schema.yml does not satisfy 'update the file'", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "models", "schema.yml"), "version: 2\n")
    await fs.utimes(
      join(dir, "models", "schema.yml"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await fs.writeFile(
      join(dir, "TASK.md"),
      "Update the file `models/schema.yml` to add a description.\n",
    )
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
  })

  test("a create contract on a file IS satisfied by pre-existing presence (unaffected)", async () => {
    await makeProject()
    await fs.writeFile(join(dir, "models", "schema.yml"), "version: 2\n")
    await fs.utimes(
      join(dir, "models", "schema.yml"),
      (Date.now() - 3600_000) / 1000,
      (Date.now() - 3600_000) / 1000,
    )
    await fs.writeFile(join(dir, "TASK.md"), "Create the file `models/schema.yml`.\n")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(true)
  })

  test("actually editing the file satisfies an update contract", async () => {
    await makeProject()
    await fs.writeFile(
      join(dir, "TASK.md"),
      "Update the file `models/schema.yml` to add a description.\n",
    )
    await fs.writeFile(join(dir, "models", "schema.yml"), "version: 2\ndescription: added\n")
    const r = await DbtNothingBuiltValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Redact relative file paths from validator telemetry
// ---------------------------------------------------------------------------

describe("sanitizeTelemetryDetails redacts relative paths under known path-bearing keys", () => {
  test("a relative required_files entry is hashed, not passed through", () => {
    const out = sanitizeTelemetryDetails({
      required_files: ["models/private_customer_rollup.sql"],
      missing_files: ["models/private_customer_rollup.sql"],
    })
    const files = out["required_files"] as string[]
    expect(files[0]).toMatch(/^path:[0-9a-f]{12}$/)
    expect(files[0]).not.toContain("private_customer_rollup")
    const missing = out["missing_files"] as string[]
    expect(missing[0]).toMatch(/^path:[0-9a-f]{12}$/)
  })

  test("an unrelated field containing a slash is left alone", () => {
    const out = sanitizeTelemetryDetails({ required_source: "requirement-lines", verdict: "a/b" })
    expect(out["required_source"]).toBe("requirement-lines")
    expect(out["verdict"]).toBe("a/b")
  })
})

// ---------------------------------------------------------------------------
// Preserve manifest exemptions for dynamic materializations
// ---------------------------------------------------------------------------

describe("a dynamic materialized value does not override the manifest's resolved exemption", () => {
  test("materialized=var('kind', 'ephemeral') is not read as a static non-ephemeral declaration", () => {
    const sql = "{{ config(materialized=var('kind', 'ephemeral')) }}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
    // The key assertion: this must NOT be read as declaring a REAL, static
    // non-ephemeral materialization, which would override a manifest
    // exemption for a model the resolved config actually renders ephemeral.
  })

  test("a genuinely static non-ephemeral literal still overrides a stale ephemeral exemption", () => {
    const sql = "{{ config(materialized='table') }}\nselect 1 as id"
    expect(sourceExemptsFromRunResults(sql)).toBe(false)
  })

  test("end to end: a dynamic materialized value does not defeat the manifest's ephemeral exemption", async () => {
    await makeProject()
    await writeManifest({
      "model.rootproj.orders": {
        name: "orders",
        resource_type: "model",
        original_file_path: "models/orders.sql",
        config: { materialized: "ephemeral" },
      },
    })
    await writeModel("orders", "{{ config(materialized=var('kind', 'ephemeral')) }}\nselect 1 as id")
    // No run_results row for `orders` at all — ephemeral models never get one.
    await writeRunResults([{ id: "model.rootproj.other", status: "success" }], "build")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})
// altimate_change end

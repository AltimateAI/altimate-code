// altimate_change start — tests for the build-green completion gate
import { describe, expect, test, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DbtBuildGreenValidator } from "../../../src/altimate/validators/dbt-build-green"
import type { ValidatorContext } from "../../../src/session/validators/types"

let dir = ""

async function makeProject(): Promise<string> {
  dir = await fs.mkdtemp(join(tmpdir(), "build-green-"))
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

/** Write run_results.json, optionally back- or forward-dating its mtime. */
async function writeRunResults(
  nodes: Array<{ id: string; status: string; message?: string }>,
  mtimeOffsetMs = 0,
): Promise<void> {
  await fs.mkdir(join(dir, "target"), { recursive: true })
  const path = join(dir, "target", "run_results.json")
  await fs.writeFile(
    path,
    JSON.stringify({
      metadata: { dbt_schema_version: "v5" },
      results: nodes.map((n) => ({
        unique_id: n.id,
        status: n.status,
        message: n.message ?? null,
      })),
    }),
  )
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

describe("DbtBuildGreenValidator — appliesTo", () => {
  test("applies inside a dbt project", async () => {
    await makeProject()
    expect(await DbtBuildGreenValidator.appliesTo(ctx())).toBe(true)
  })

  test("does not apply outside a dbt project", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "build-green-nodbt-"))
    expect(await DbtBuildGreenValidator.appliesTo(ctx())).toBe(false)
  })
})

describe("DbtBuildGreenValidator — nothing to gate", () => {
  test("passes a session that edited nothing and built nothing", async () => {
    await makeProject()
    await writeModel("stg_orders")
    const r = await DbtBuildGreenValidator.check(ctx({ sessionStartMs: Date.now() + 60_000 }))
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("nothing-to-gate")
  })
})

describe("DbtBuildGreenValidator — missing or stale artifact", () => {
  test("fails when models were edited and no artifact exists", async () => {
    await makeProject()
    await writeModel("stg_orders")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("never built")
    expect(r.details!["verdict"]).toBe("no-fresh-build")
  })

  test("fails when the only artifact predates the session", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([{ id: "model.t.stg_orders", status: "success" }], -600_000)
    const r = await DbtBuildGreenValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("predates this session")
    expect(r.details!["run_results_fresh"]).toBe(false)
  })
})

describe("DbtBuildGreenValidator — fresh artifact", () => {
  test("passes when every edited model built successfully", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([{ id: "model.t.stg_orders", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["verdict"]).toBe("fresh-build")
  })

  test("treats warn as a clean build", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([{ id: "model.t.stg_orders", status: "warn" }])
    expect((await DbtBuildGreenValidator.check(ctx())).ok).toBe(true)
  })

  test("fails on an errored edited model and surfaces dbt's message", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([
      { id: "model.t.stg_orders", status: "error", message: "Compilation Error in model" },
    ])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("stg_orders")
    expect(r.fixHint).toContain("Compilation Error in model")
  })

  test("fails on a skipped edited model", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([{ id: "model.t.stg_orders", status: "skipped" }])
    expect((await DbtBuildGreenValidator.check(ctx())).ok).toBe(false)
  })

  test("fails when an edited model is absent from the artifact", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeModel("fct_orders")
    await writeRunResults([{ id: "model.t.stg_orders", status: "success" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["not_built"]).toEqual(["fct_orders"])
  })

  test("does not assert coverage when the artifact holds no model nodes", async () => {
    // `dbt test` overwrites run_results.json with test nodes only; a missing
    // model entry then proves nothing about whether the model was built.
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([{ id: "test.t.not_null_stg_orders_id.abc", status: "pass" }])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["coverage_assertable"]).toBe(false)
  })

  test("fails when a model was edited after the last build", async () => {
    await makeProject()
    await writeRunResults([{ id: "model.t.stg_orders", status: "success" }], -30_000)
    await writeModel("stg_orders")
    const r = await DbtBuildGreenValidator.check(ctx({ sessionStartMs: Date.now() - 120_000 }))
    expect(r.ok).toBe(false)
    expect(r.details!["stale_build"]).toEqual(["stg_orders"])
  })

  test("failures on untouched nodes are reported but do not block", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await writeRunResults([
      { id: "model.t.stg_orders", status: "success" },
      { id: "model.t.some_other_model", status: "error" },
    ])
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
    expect(r.details!["failed_out_of_scope"]).toBe(1)
  })

  test("with no edits of our own, every failure in the fresh artifact is in scope", async () => {
    await makeProject()
    await writeModel("stg_orders")
    // Backdate the model so the session touched nothing, but the build is ours.
    const old = (Date.now() - 600_000) / 1000
    await fs.utimes(join(dir, "models", "stg_orders.sql"), old, old)
    await writeRunResults([{ id: "model.t.stg_orders", status: "error" }])
    const r = await DbtBuildGreenValidator.check(ctx({ sessionStartMs: Date.now() - 60_000 }))
    expect(r.ok).toBe(false)
    expect(r.details!["models_touched"]).toBe(0)
    expect(r.details!["failed_in_scope"]).toEqual(["stg_orders"])
  })

  test("a malformed artifact is treated as no artifact, not as a crash", async () => {
    await makeProject()
    await writeModel("stg_orders")
    await fs.mkdir(join(dir, "target"), { recursive: true })
    await fs.writeFile(join(dir, "target", "run_results.json"), "{{{")
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(false)
    expect(r.details!["verdict"]).toBe("no-fresh-build")
  })

  test("honours a custom target-path", async () => {
    await makeProject()
    await fs.appendFile(join(dir, "dbt_project.yml"), 'target-path: "build_out"\n')
    await writeModel("stg_orders")
    await fs.mkdir(join(dir, "build_out"), { recursive: true })
    await fs.writeFile(
      join(dir, "build_out", "run_results.json"),
      JSON.stringify({ results: [{ unique_id: "model.t.stg_orders", status: "success" }] }),
    )
    const r = await DbtBuildGreenValidator.check(ctx())
    expect(r.ok).toBe(true)
  })
})
// altimate_change end

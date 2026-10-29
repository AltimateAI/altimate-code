import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bootstrap } from "../../../src/cli/bootstrap"
import { createRunner, resultsDirectory, type Runner } from "../../../src/altimate/tool-cli/runner"
import { EXPOSED } from "../../../src/altimate/tool-cli/allow-list"
import { askFor, isBlockedStatement } from "../../../src/altimate/tool-cli/permissions"
import { Effect, Exit } from "effect"
import { Global } from "../../../src/global"

let dir: string
let runner: Runner
let done: () => void
let finished: Promise<void>
let ready: Promise<void>

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tool-cli-runner-"))
  finished = new Promise((resolve) => (done = resolve))
  ready = new Promise((resolve, reject) => {
    bootstrap(dir, async () => {
      runner = await createRunner()
      resolve()
      await finished
      await runner.close()
    }).catch(reject)
  })
  await ready
})

afterAll(async () => {
  done()
  await rm(dir, { recursive: true, force: true })
})

describe("tool list", () => {
  test("exposes the data tools with schemas", async () => {
    const tools = await runner.list()
    const ids = tools.map((tool) => tool.id)
    for (const id of [
      "sql_execute",
      "sql_materialize",
      "sql_check",
      "sql_format",
      "warehouse_list",
      "schema_inspect",
      "altimate_core_validate",
      "dbt_manifest",
      "dbt_lineage",
      "dbt_profiles",
      "dbt_unit_test_gen",
      "lineage_check",
      "impact_analysis",
      "data_diff",
      "finops_query_history",
      "project_scan",
      "answer_commit",
    ])
      expect(ids).toContain(id)
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeObject()
    }
  })

  test("excludes coding, model-backed and housekeeping tools", async () => {
    const ids = Object.keys(EXPOSED)
    for (const id of [
      "bash",
      "read",
      "edit",
      "write",
      "task",
      "webfetch",
      "dbt_pr_review",
      "datamate_manager",
      "mcp_discover",
      "feedback_submit",
      "sample_setup",
      "tool_lookup",
      "memory_read",
      "training_save",
    ])
      expect(ids).not.toContain(id)
    expect(ids.some((id) => id.startsWith("memory_") || id.startsWith("training_"))).toBe(false)
  })
})

describe("tool run", () => {
  test("runs a pure core tool in-process", async () => {
    const result = await runner.run("sql_format", { sql: "select a,b from t where x=1", dialect: "postgres" })
    expect(result.status).toBe("ok")
    expect(result.output).toContain("SELECT a, b FROM t")
  })

  test("runs altimate_core_validate", async () => {
    const result = await runner.run("altimate_core_validate", { sql: "SELECT 1" })
    expect(result.status).toBe("ok")
  })

  test("unknown and excluded tools fail", async () => {
    for (const name of ["nope", "bash", "dbt_pr_review", "constructor"]) {
      const result = await runner.run(name, {})
      expect(result.status).toBe("error")
      expect(result.output).toContain(`Unknown tool: ${name}`)
    }
  })

  test("invalid arguments fail", async () => {
    const wrongShape = await runner.run("sql_format", { sql: 5 })
    expect(wrongShape.status).toBe("error")
    expect(wrongShape.output).toContain("invalid arguments")
    const notObject = await runner.run("sql_format", [])
    expect(notObject.status).toBe("error")
  })

  test("a write is denied without --allow-write", async () => {
    const result = await runner.run("sql_execute", { query: "CREATE TABLE t (a int)" })
    expect(result.status).toBe("error")
    expect(result.output).toBe("Permission denied: sql_execute_write. Re-run with --allow-write to enable writes.")
  })

  test("config-changing tools need --allow-write", async () => {
    const result = await runner.run("warehouse_remove", { name: "x" })
    expect(result.status).toBe("error")
    expect(result.output).toContain("Permission denied: warehouse_remove")
  })

  test.each(["DROP DATABASE prod", "drop schema s", "TRUNCATE TABLE t"])("%s stays blocked with --allow-write", async (query) => {
    const result = await runner.run("sql_execute", { query }, { allowWrite: true })
    expect(result.status).toBe("error")
    expect(result.output).toContain("blocked for safety")
  })
})

describe("ask handler", () => {
  const ask = (allowWrite: boolean, permission: string, patterns: string[] = ["*"]) =>
    Effect.runSyncExit(askFor(allowWrite)({ permission, patterns, always: [], metadata: {} }))

  test("reads pass, everything else is denied by default", () => {
    for (const kind of ["sql_execute", "sql_execute_read", "schema_inspect", "answer_commit"])
      expect(Exit.isSuccess(ask(false, kind))).toBe(true)
    for (const kind of ["sql_execute_write", "bash", "external_directory", "edit", "warehouse_add"])
      expect(Exit.isFailure(ask(false, kind))).toBe(true)
  })

  test("--allow-write opens writes but never destructive statements", () => {
    expect(Exit.isSuccess(ask(true, "sql_execute_write", ["INSERT INTO t VALUES (1)"]))).toBe(true)
    expect(Exit.isSuccess(ask(true, "bash", ["dbt run"]))).toBe(true)
    expect(Exit.isFailure(ask(true, "sql_execute_write", ["DROP DATABASE x"]))).toBe(true)
    expect(Exit.isFailure(ask(true, "bash", ["truncate table x"]))).toBe(true)
    expect(isBlockedStatement("  Drop Schema s")).toBe(true)
    expect(isBlockedStatement("DROP TABLE t")).toBe(false)
  })
})

describe("shared adapter behaviour", () => {
  test("lists the compact adapter schemas, with sql_execute `tables` and the answer_commit request", async () => {
    const tools = await runner.list()
    const sql = tools.find((tool) => tool.id === "sql_execute")!
    expect(Object.keys((sql.inputSchema as { properties: object }).properties)).toContain("tables")
    expect(JSON.stringify(sql.inputSchema)).not.toContain("$schema")
    const commit = tools.find((tool) => tool.id === "answer_commit")!
    expect((commit.inputSchema as { required: string[] }).required).toContain("request")
  })

  test("sql_execute with only `tables` and nothing to describe reports an error", async () => {
    const result = await runner.run("sql_execute", { warehouse: "nope", tables: ["t"] })
    expect(result.status).toBe("error")
  })

  test("workspace tools are listed only when requested", async () => {
    expect((await runner.list()).some((tool) => tool.id.startsWith("workspace_"))).toBe(false)
    expect((await runner.run("workspace_context", {})).output).toContain("Unknown tool")
    let withWorkspace!: Runner
    await bootstrap(dir, async () => {
      withWorkspace = await createRunner({ workspaceTools: true })
    })
    try {
      const ids = (await withWorkspace.list()).map((tool) => tool.id)
      for (const id of ["workspace_context", "workspace_skill", "workspace_execute"]) expect(ids).toContain(id)
      const unlinked = await withWorkspace.run("workspace_context", {})
      expect(typeof unlinked.output).toBe("string")
      const skill = await withWorkspace.run("workspace_skill", { name: "x" })
      expect(skill.status).toBe("error")
    } finally {
      await withWorkspace.close()
    }
  })
})

describe("results directory", () => {
  test("lives under the state directory", () => {
    expect(resultsDirectory()).toBe(path.join(Global.Path.state, "tool-results"))
  })
})

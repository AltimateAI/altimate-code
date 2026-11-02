import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bootstrap } from "../../../src/cli/bootstrap"
import { createRunner, resultsDirectory, type Runner } from "../../../src/altimate/tool-cli/runner"
import { EXPOSED } from "../../../src/altimate/tool-cli/allow-list"
import { askFor, isBlockedStatement } from "../../../src/altimate/tool-cli/permissions"
import { Effect, Exit } from "effect"
import { Global } from "../../../src/global"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerDefaultNativeHandlers } from "../../lib/native-handlers"

let dir: string
let runner: Runner
let done: () => void
let finished: Promise<void>
let ready: Promise<void>
let booted: Promise<unknown>

beforeAll(async () => {
  registerDefaultNativeHandlers()
  dir = await mkdtemp(path.join(tmpdir(), "tool-cli-runner-"))
  finished = new Promise((resolve) => (done = resolve))
  ready = new Promise((resolve, reject) => {
    booted = bootstrap(dir, async () => {
      runner = await createRunner()
      resolve()
      await finished
      await runner.close()
    })
    booted.catch(reject)
  })
  await ready
})

afterAll(async () => {
  done()
  await booted.catch(() => {})
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

  test("blocked statements are refused for read permissions too", () => {
    for (const kind of ["sql_execute", "sql_execute_read", "schema_inspect", "answer_commit"])
      for (const allowWrite of [false, true])
        expect(Exit.isFailure(ask(allowWrite, kind, ["DROP SCHEMA s"]))).toBe(true)
    expect(Exit.isSuccess(ask(false, "sql_execute_read", ["SELECT 1"]))).toBe(true)
  })

  test("--allow-write opens writes but never destructive statements", () => {
    expect(Exit.isSuccess(ask(true, "sql_execute_write", ["INSERT INTO t VALUES (1)"]))).toBe(true)
    expect(Exit.isSuccess(ask(true, "bash", ["dbt run"]))).toBe(true)
    expect(Exit.isFailure(ask(true, "sql_execute_write", ["DROP DATABASE x"]))).toBe(true)
    expect(Exit.isFailure(ask(true, "bash", ["truncate table x"]))).toBe(true)
    expect(isBlockedStatement("  Drop Schema s")).toBe(true)
    expect(isBlockedStatement("DROP TABLE t")).toBe(false)
  })

  test("with the warehouse dialect, later statements and leading comments are checked too", () => {
    expect(isBlockedStatement("/* c */ DROP SCHEMA s", "postgres")).toBe(true)
    expect(isBlockedStatement("SELECT 1; TRUNCATE t", "postgres")).toBe(true)
    // Dollar-quoted text is a string in Postgres, not a second statement.
    expect(isBlockedStatement("SELECT $q$; TRUNCATE staging$q$", "postgres")).toBe(false)
    // Each dialect's comments apply: nested block comments (Postgres), # comments (MySQL).
    expect(isBlockedStatement("/* outer /* inner */ DROP SCHEMA s */ SELECT 1", "postgres")).toBe(false)
    expect(isBlockedStatement("# note\nDROP DATABASE db", "mysql")).toBe(true)
    // Comments between keywords, executable comments and CR line ends are seen in any dialect.
    for (const sql of ["/* note */ DROP SCHEMA s", "DROP/**/SCHEMA s", "/*!50000 DROP */ SCHEMA s", "-- note\rDROP SCHEMA s"])
      expect(isBlockedStatement(sql)).toBe(true)
    expect(isBlockedStatement("/* DROP SCHEMA s */ SELECT 1")).toBe(false)
    Registry.setConfigs({ pg: { type: "postgres" } as any })
    try {
      const askWith = (patterns: string[]) =>
        Effect.runSyncExit(askFor(false)({ permission: "sql_execute", patterns, always: [], metadata: { warehouse: "pg" } }))
      expect(Exit.isFailure(askWith(["SELECT 1; TRUNCATE t"]))).toBe(true)
      expect(Exit.isSuccess(askWith(["SELECT $q$; TRUNCATE staging$q$"]))).toBe(true)
    } finally {
      Registry.reset()
    }
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
    // A separate project directory, so disposing this bootstrap leaves the shared runner's instance alone.
    const other = await mkdtemp(path.join(tmpdir(), "tool-cli-runner-ws-"))
    const cwd = spyOn(process, "cwd").mockReturnValue(other)
    let withWorkspace: Runner | undefined
    try {
      await bootstrap(other, async () => {
        withWorkspace = await createRunner({ workspaceTools: true })
      })
      if (!withWorkspace) throw new Error("runner was not created")
      const ids = (await withWorkspace.list()).map((tool) => tool.id)
      for (const id of ["workspace_context", "workspace_skill", "workspace_execute"]) expect(ids).toContain(id)
      const unlinked = await withWorkspace.run("workspace_context", {})
      expect(typeof unlinked.output).toBe("string")
      const skill = await withWorkspace.run("workspace_skill", { name: "x" })
      expect(skill.status).toBe("error")
    } finally {
      cwd.mockRestore()
      await withWorkspace?.close()
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe("data_diff write-carrying inputs", () => {
  const write = "SELECT 1 AS id) SELECT 1 AS id; DELETE FROM dbo.t; WITH __x AS (SELECT 1 AS id"
  for (const [field, value] of [
    ["source", write],
    ["target", write],
    ["where_clause", "1=1); DELETE FROM dbo.t; --"],
  ] as const) {
    test(`refuses a write in ${field} without --allow-write`, async () => {
      Registry.setConfigs({ wh: { type: "sqlserver" } as any })
      try {
        const result = await runner.run("data_diff", {
          source: "orders",
          target: "orders_v2",
          key_columns: ["id"],
          source_warehouse: "wh",
          [field]: value,
        })
        expect(result.status).toBe("error")
        expect(JSON.stringify(result)).toContain("read-only inputs")
      } finally {
        Registry.reset()
      }
    })
  }

  test("each side's hard-block check uses its own warehouse dialect", async () => {
    Registry.setConfigs({ my: { type: "mysql" } as any, pg: { type: "postgres" } as any })
    try {
      // Dollar-quoted text is a string in Postgres; read as MySQL it would look like a DROP SCHEMA.
      const result = await runner.run("data_diff", {
        source: "orders",
        target: "SELECT $$; DROP SCHEMA s;$$ AS id",
        key_columns: ["id"],
        source_warehouse: "my",
        target_warehouse: "pg",
      })
      expect(JSON.stringify(result)).not.toContain("blocked for safety")
    } finally {
      Registry.reset()
    }
  })
})

describe("results directory", () => {
  test("lives under the state directory", () => {
    expect(resultsDirectory()).toBe(path.join(Global.Path.state, "tool-results"))
  })
})

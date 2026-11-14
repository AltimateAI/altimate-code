// dbt_cte_profile: the CTE list, and one timed count query per CTE. The dbt adapter is replaced through
// `dbtAdapterInternals`, so no warehouse, Python or dbt is needed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtCteProfileTool } from "@/altimate/tools/dbt-cte-profile"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_cte_profile"),
  messageID: MessageID.make("msg_dbt_cte_profile"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const CUSTOMERS = `{{ config(materialized='table') }}

-- orders first
with orders as (
    select * from {{ ref('stg_orders') }}
),

"Big Spenders" (customer_id, total) as (
    select customer_id, sum(amount) from orders group by 1
),

final as (
    select * from "Big Spenders"
)

select * from final
`

let project: string
let queries: { sql: string; name: string; limit: number }[]
let respond: (sql: string) => Promise<unknown>

function useAdapter() {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "corecommand",
    queryLimit: 500,
  })
  dbtAdapterInternals.create = async () => ({
    isInitialized: () => true,
    dispose: async () => {},
    immediatelyExecuteSQLWithLimit: async (sql: string, name: string, limit: number) => {
      queries.push({ sql, name, limit })
      return respond(sql)
    },
  })
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-cte-profile-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
  await mkdir(path.join(project, "models", "marts"), { recursive: true })
  await mkdir(path.join(project, "models", "staging"), { recursive: true })
  await mkdir(path.join(project, "dbt_packages", "pkg", "models"), { recursive: true })
  await writeFile(path.join(project, "models", "marts", "customers.sql"), CUSTOMERS)
  await writeFile(path.join(project, "models", "staging", "plain.sql"), "select 1 as id\n")
  await writeFile(path.join(project, "models", "marts", "dup.sql"), "with a as (select 1) select * from a")
  await writeFile(path.join(project, "models", "staging", "dup.sql"), "with b as (select 1) select * from b")
  await writeFile(
    path.join(project, "models", "marts", "twins.sql"),
    'with "Foo" as (select 1 as a), foo as (select 2 as a), keep as (select 3 as a)\nselect * from keep\n',
  )
  await writeFile(
    path.join(project, "models", "marts", "wrapped.sql"),
    "{% if is_incremental() %}\nwith a as (select 1 as x) select * from a\n{% else %}\nwith b as (select 2 as x) select * from b\n{% endif %}\n",
  )
  await writeFile(
    path.join(project, "models", "marts", "second.sql"),
    "with a as (select 1 as x) select * from a;\nwith b as (select 2 as x) select * from b\n",
  )
  await mkdir(path.join(project, "target"), { recursive: true })
  await writeFile(
    path.join(project, "target", "manifest.json"),
    JSON.stringify({
      nodes: {
        "model.jaffle_shop.customers": { resource_type: "model", name: "customers", original_file_path: "models/marts/customers.sql" },
        "model.jaffle_shop.gone": { resource_type: "model", name: "gone", original_file_path: "models/marts/gone.sql" },
        "model.jaffle_shop.dup.v1": { resource_type: "model", name: "sales", unique_id: "model.jaffle_shop.sales.v1", original_file_path: "models/marts/dup.sql" },
        "model.jaffle_shop.sales.v2": { resource_type: "model", name: "sales", unique_id: "model.jaffle_shop.sales.v2", original_file_path: "models/staging/dup.sql" },
        "model.pkg.customers": { resource_type: "model", name: "customers", package_name: "pkg", original_file_path: "models/marts/customers.sql" },
      },
    }),
  )
  await writeFile(path.join(project, "dbt_packages", "pkg", "models", "ignored.sql"), "with z as (select 1) select * from z")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => {
  queries = []
  respond = async () => ({ columnNames: ["_PROFILE_COUNT"], data: [{ _PROFILE_COUNT: 42 }] })
  resetDbtAdapter()
  useAdapter()
})

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("dbt_cte_profile list", () => {
  test("lists the CTEs in source order with their lines, without the adapter, on a read-only call", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers" }, { ...ctx, extra: { forceReadOnly: true } })
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.file).toBe(path.join("models", "marts", "customers.sql"))
    expect(result.metadata.ctes).toEqual([
      { name: "orders", line: 4, index: 0, clause: expect.any(Number), position: 0 },
      { name: '"Big Spenders"', line: 8, index: 1, clause: expect.any(Number), position: 1 },
      { name: "final", line: 12, index: 2, clause: expect.any(Number), position: 2 },
    ])
    expect(result.output).toContain("3 CTEs")
    expect(queries).toEqual([])
  })

  test("a model without CTEs lists none", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "plain" }, ctx)
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.ctes).toEqual([])
  })

  test("takes a project-relative path and ignores dbt_packages", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const byPath = await tool.execute({ model: "models/marts/customers.sql" }, ctx)
    expect(byPath.metadata.success).toBe(true)
    const packaged = await tool.execute({ model: "ignored" }, ctx)
    expect(packaged.metadata.success).toBe(false)
    expect(packaged.output).toContain("no model named ignored")
  })

  test("an ambiguous name asks for the path; a path outside the project is refused", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const dup = await tool.execute({ model: "dup" }, ctx)
    expect(dup.metadata.success).toBe(false)
    expect(dup.output).toContain("matches 2 files")
    const outside = await tool.execute({ model: "../../etc/passwd.sql" }, ctx)
    expect(outside.metadata.success).toBe(false)
    expect(outside.output).toContain("outside the dbt project")
  })
})

describe("dbt_cte_profile model lookup", () => {
  test("finds a model by unique_id through the manifest, and takes an absolute path", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const byId = await tool.execute({ model: "model.jaffle_shop.customers" }, ctx)
    expect(byId.metadata.success).toBe(true)
    const absolute = await tool.execute({ model: path.join(project, "models", "marts", "customers.sql") }, ctx)
    expect(absolute.metadata.success).toBe(true)
    expect(absolute.metadata.file).toBe(path.join("models", "marts", "customers.sql"))
  })

  test("a unique_id the manifest does not hold is refused, never read as a name", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const other = await tool.execute({ model: "model.other_package.customers" }, ctx)
    expect(other.metadata.success).toBe(false)
    expect(other.output).toContain("is not in target/manifest.json")
    // The manifest knows this model but its file is gone: the name search must not answer for another package's.
    const gone = await tool.execute({ model: "model.jaffle_shop.gone" }, ctx)
    expect(gone.metadata.success).toBe(false)
    // A package's model is recorded relative to its own package: never read as the project's file of that path.
    const packaged = await tool.execute({ model: "model.pkg.customers" }, ctx)
    expect(packaged.metadata.success).toBe(false)
    expect(packaged.output).toContain("belongs to the package pkg")
  })

  test("a folder, or a path that is not a .sql file, is a failure, not a crash", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const folder = await tool.execute({ model: "models/marts/" }, ctx)
    expect(folder.metadata.success).toBe(false)
    expect(folder.output).toContain("not a .sql file")
    const config = await tool.execute({ model: "models/../dbt_project.yml" }, ctx)
    expect(config.metadata.success).toBe(false)
    expect(config.output).toContain("not a .sql file")
    const dirNamedSql = path.join(project, "models", "dir.sql")
    await mkdir(dirNamedSql, { recursive: true })
    const named = await tool.execute({ model: "models/dir.sql" }, ctx)
    expect(named.metadata.success).toBe(false)
    await rm(dirNamedSql, { recursive: true })
  })

  test("a symlink out of the project is refused", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "dbt-cte-outside-"))
    await writeFile(path.join(outside, "secret.sql"), "with s as (select 1) select * from s")
    await symlink(path.join(outside, "secret.sql"), path.join(project, "models", "link.sql"))
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "models/link.sql" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("outside the dbt project")
    await rm(path.join(project, "models", "link.sql"))
    await rm(outside, { recursive: true, force: true })
  })

  test("the list is read from the session's project, not the one the adapter was set up for", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "dbt-cte-other-"))
    await writeFile(path.join(other, "dbt_project.yml"), "name: other\n")
    await mkdir(path.join(other, "models"), { recursive: true })
    await writeFile(path.join(other, "models", "customers.sql"), "with only_here as (select 1) select * from only_here")
    const before = process.cwd()
    process.chdir(other)
    try {
      const tool = await initTool(DbtCteProfileTool)
      const result = await tool.execute({ model: "customers" }, ctx)
      expect((result.metadata.ctes as { name: string }[]).map((c) => c.name)).toEqual(["only_here"])
      const run = await tool.execute({ model: "customers", cte: "only_here" }, ctx)
      expect(run.metadata.success).toBe(false)
      expect(run.metadata.refusal).toBe("other_project")
    } finally {
      process.chdir(before)
      await rm(other, { recursive: true, force: true })
    }
  })

  test("an oversize model is refused", async () => {
    await writeFile(path.join(project, "models", "huge.sql"), "-- " + "x".repeat(4 * 1024 * 1024 + 10))
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "huge" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("largest file read")
    await rm(path.join(project, "models", "huge.sql"))
  })
})

describe("dbt_cte_profile same-named CTEs", () => {
  test("two CTEs whose names differ only in case are listed apart, and each is reachable by its exact name", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const list = await tool.execute({ model: "twins" }, ctx)
    expect((list.metadata.ctes as { name: string; position: number }[]).map((c) => [c.name, c.position])).toEqual([['"Foo"', 0], ["foo", 1], ["keep", 2]])
    const exact = await tool.execute({ model: "twins", cte: "foo" }, ctx)
    expect(exact.metadata.position).toBe(1)
    expect(queries[0].sql).toEndWith("FROM foo")
    const quoted = await tool.execute({ model: "twins", cte: '"Foo"' }, ctx)
    expect(quoted.metadata.position).toBe(0)
    expect(queries[1].sql).toEndWith('FROM "Foo"')
    // Letter case alone does not pick between two matches.
    const loose = await tool.execute({ model: "twins", cte: "FOO" }, ctx)
    expect(loose.metadata.success).toBe(false)
    expect(loose.output).toContain("positions 0, 1")
    expect(queries).toHaveLength(2)
  })

  test("position picks one CTE, and a name that disagrees with it is refused", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "twins", position: 2 }, ctx)
    expect(result.metadata.cte).toBe("keep")
    const wrong = await tool.execute({ model: "twins", cte: "foo", position: 2 }, ctx)
    expect(wrong.metadata.success).toBe(false)
    const missing = await tool.execute({ model: "twins", position: 9 }, ctx)
    expect(missing.metadata.success).toBe(false)
    expect(queries).toHaveLength(1)
  })

  test("a CTE of a second WITH clause has no query of its own and runs nothing", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const first = await tool.execute({ model: "second", cte: "a" }, ctx)
    expect(first.metadata.success).toBe(true)
    const later = await tool.execute({ model: "second", cte: "b" }, ctx)
    expect(later.metadata.success).toBe(false)
    expect(later.output).toContain("second WITH clause")
    expect(queries).toHaveLength(1)
  })
})

describe("dbt_cte_profile run", () => {
  test("every failure carries an error, so the CLI and MCP report it as one", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const results = [
      await tool.execute({ model: "nope" }, ctx),
      await tool.execute({ model: "customers", cte: "nope" }, ctx),
      await tool.execute({ model: "customers", cte: "orders" }, { ...ctx, extra: { forceReadOnly: true } }),
    ]
    for (const result of results) {
      expect(result.metadata.success).toBe(false)
      expect(typeof result.metadata.error).toBe("string")
    }
  })

  test("a query that outlives the call's abort ends the wait at the abort", async () => {
    respond = () => new Promise(() => {})
    const controller = new AbortController()
    const tool = await initTool(DbtCteProfileTool)
    const run = tool.execute({ model: "customers", cte: "orders" }, { ...ctx, abort: controller.signal })
    setTimeout(() => controller.abort(new Error("stopped")), 50)
    await expect(run).rejects.toThrow("stopped")
  })

  test("a name shared by several versions of one model is refused, not guessed", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "sales" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("matches 2 models")
  })

  test("a query that timed out is reported as timed out, since it may still be running", async () => {
    respond = async () => {
      throw Object.assign(new Error("exceeded 300000 ms"), { code: "QUERY_TIMEOUT" })
    }
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "orders" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.timedOut).toBe(true)
    expect(result.output).toContain("may still be running")
  })

  test("a CTE inside a Jinja block that the query would cut open is refused, and nothing runs", async () => {
    const tool = await initTool(DbtCteProfileTool)
    for (const cte of ["a", "b"]) {
      const result = await tool.execute({ model: "wrapped", cte }, ctx)
      expect(result.metadata.success).toBe(false)
      expect(result.output).toContain("Jinja")
    }
    expect(queries).toHaveLength(0)
  })

  test("runs one count query over the CTE and the earlier ones, limit 1, and reads the count by position", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "Big Spenders" }, ctx)
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.cte).toBe('"Big Spenders"')
    expect(result.metadata.rows).toBe(42)
    expect(typeof result.metadata.queryMs).toBe("number")
    expect(queries).toHaveLength(1)
    expect(queries[0].name).toBe('cte_profiler_"Big Spenders"')
    expect(queries[0].limit).toBe(1)
    expect(queries[0].sql).toContain("{{ config(materialized='table') }}")
    expect(queries[0].sql).toContain("orders as (")
    expect(queries[0].sql).toContain('"Big Spenders" (customer_id, total) as (')
    expect(queries[0].sql).not.toContain("final as (")
    expect(queries[0].sql).toEndWith('SELECT COUNT(*) AS _profile_count FROM "Big Spenders"')
  })

  test("matches the CTE name ignoring case and quotes", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "ORDERS" }, ctx)
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.cte).toBe("orders")
    expect(queries[0].sql).toEndWith("FROM orders")
  })

  test("an unknown CTE names the ones the model has and runs nothing", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "nope" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("orders")
    expect(queries).toEqual([])
  })

  test("a read-only call is refused and never starts the adapter", async () => {
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "orders" }, { ...ctx, extra: { forceReadOnly: true } })
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.refusal).toBe("read_only")
    expect(result.output).toContain("--allow-write")
    expect(queries).toEqual([])
  })

  test("a failing query is reported as a failure, not thrown", async () => {
    respond = async () => {
      throw new Error("Object 'STG_ORDERS' does not exist")
    }
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "orders" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("STG_ORDERS")
  })

  test("an empty result counts as zero rows", async () => {
    respond = async () => ({ columnNames: ["_PROFILE_COUNT"], data: [] })
    const tool = await initTool(DbtCteProfileTool)
    const result = await tool.execute({ model: "customers", cte: "final" }, ctx)
    expect(result.metadata.rows).toBe(0)
  })

  test("a cancelled call throws instead of answering", async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = await initTool(DbtCteProfileTool)
    await expect(tool.execute({ model: "customers", cte: "orders" }, { ...ctx, abort: controller.signal })).rejects.toBeDefined()
    expect(queries).toEqual([])
  })
})

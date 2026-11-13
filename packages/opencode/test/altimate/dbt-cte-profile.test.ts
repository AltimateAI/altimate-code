// dbt_cte_profile: the CTE list, and one timed count query per CTE. The dbt adapter is replaced through
// `dbtAdapterInternals`, so no warehouse, Python or dbt is needed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
      { name: "orders", line: 4, index: 0, clause: expect.any(Number) },
      { name: '"Big Spenders"', line: 8, index: 1, clause: expect.any(Number) },
      { name: "final", line: 12, index: 2, clause: expect.any(Number) },
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

describe("dbt_cte_profile run", () => {
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

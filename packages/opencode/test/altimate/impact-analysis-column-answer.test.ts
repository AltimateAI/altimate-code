// impact_analysis returns the column answer (metadata.column_answer) beside column_reach, in both
// directions, and the MCP server passes it on as structured content.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { ImpactAnalysisTool } from "../../src/altimate/tools/impact-analysis"
import { structuredResult } from "../../src/altimate/mcp-server/server"
import { SessionID, MessageID } from "../../src/session/schema"
import { clearLineageCaches } from "../../src/altimate/native/dbt/project-lineage"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const dirs: string[] = []
let spy: ReturnType<typeof spyOn> | undefined
const telemetryBefore = process.env.ALTIMATE_TELEMETRY_DISABLED
beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterEach(() => {
  clearLineageCaches()
  spy?.mockRestore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => {
  if (telemetryBefore === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = telemetryBefore
})

const model = (name: string, deps: string[], sql: string) => ({
  resource_type: "model",
  unique_id: `model.shop.${name}`,
  name,
  alias: name,
  database: "shop",
  schema: "main",
  original_file_path: `models/${name}.sql`,
  depends_on: { nodes: deps.map((d) => `model.shop.${d}`) },
  config: { materialized: "table" },
  compiled_code: sql,
  columns: {},
})

// orders.amount → fct.revenue (renamed) → mart.total (summed); rpt filters on fct.revenue.
function setup(exposures: Record<string, unknown> = {}) {
  const nodes = {
    "model.shop.orders": model("orders", [], "select 1 as order_id, 2.5 as amount"),
    "model.shop.fct": model("fct", ["orders"], "select order_id, amount as revenue from shop.main.orders"),
    "model.shop.mart": model("mart", ["fct"], "select order_id, revenue * 1.1 as total from shop.main.fct"),
    "model.shop.rpt": model("rpt", ["fct"], "select order_id from shop.main.fct where revenue > 10"),
  }
  const dir = mkdtempSync(join(tmpdir(), "impact-answer-"))
  dirs.push(dir)
  mkdirSync(join(dir, "target"))
  const file = join(dir, "target", "manifest.json")
  writeFileSync(file, JSON.stringify({ metadata: { adapter_type: "duckdb" }, nodes, sources: {}, exposures }))
  const models = Object.values(nodes).map((n) => ({
    name: n.name,
    unique_id: n.unique_id,
    depends_on: n.depends_on.nodes,
    materialized: "table",
  }))
  spy = spyOn(Dispatcher, "call").mockImplementation((async (method: string) => {
    if (method === "dbt.manifest") return { models, model_count: models.length, test_count: 0, tests: [] }
    throw new Error(`No mock for ${method}`)
  }) as any)
  return file
}

const run = async (args: Record<string, unknown>) => {
  const tool = await initTool(ImpactAnalysisTool)
  return tool.execute({ change_type: "modify", ...args } as any, ctx)
}

describe("impact_analysis: column answer", () => {
  test("downstream by default, beside column_reach, with one line of text", async () => {
    const manifest_path = setup()
    const result = await run({ model: "fct", column: "revenue", manifest_path })
    const answer = result.metadata.column_answer
    expect(answer.version).toBe(1)
    expect(answer.direction).toBe("downstream")
    expect(answer.counts).toMatchObject({
      columns: 1,
      models: 1,
      may_carry_models: 1,
      cleared_models: 0,
      model_level: 2,
    })
    expect(answer.also_reads).toEqual([
      { model: answer.nodes.findIndex((n: any) => n.name === "rpt"), columns: ["revenue"], downstream: 0 },
    ])
    expect(result.metadata.column_reach.models.map((m: any) => m.name)).toEqual(["mart"])
    expect(result.output).toContain("Column Reach: fct.revenue")
    expect(result.output.trimEnd().split("\n").at(-1)).toStartWith("Column impact: 1 column in 1 model")
  })

  test("upstream traces where the column comes from", async () => {
    const manifest_path = setup()
    const result = await run({ model: "mart", column: "total", manifest_path, direction: "upstream" })
    const answer = result.metadata.column_answer
    expect(answer.direction).toBe("upstream")
    const names = answer.columns.map((c: any) => `${answer.nodes[c.model].name}.${c.column}`)
    expect(names).toEqual(["mart.total", "fct.revenue", "orders.amount"])
    expect(result.output.trimEnd().split("\n").at(-1)).toStartWith("Column trace (upstream): 2 columns in 2 models")
  })

  test("no column, no answer", async () => {
    const manifest_path = setup()
    const result = await run({ model: "fct", manifest_path })
    expect(result.metadata.column_answer).toBeUndefined()
  })

  test("says how many exposures the project declares, with or without a column", async () => {
    const none = await run({ model: "fct", manifest_path: setup() })
    expect(none.metadata.exposures_declared).toBe(0)
    expect(none.metadata.exposures).toEqual([])
    const manifest_path = setup({
      "exposure.shop.board": {
        name: "board",
        label: "Board",
        type: "dashboard",
        url: "https://bi.example.com/1",
        owner: { name: "Data team" },
        depends_on: { nodes: ["model.shop.mart"] },
      },
      "exposure.shop.up": { name: "up", depends_on: { nodes: ["model.shop.orders"] } },
    })
    const modelLevel = await run({ model: "fct", manifest_path })
    expect(modelLevel.metadata.exposures_declared).toBe(2)
    expect(modelLevel.metadata.exposures).toEqual([
      { unique_id: "exposure.shop.board", name: "board", label: "Board", type: "dashboard", url: "https://bi.example.com/1", owner: "Data team" },
    ])
    const column = await run({ model: "fct", column: "revenue", manifest_path })
    expect(column.metadata.exposures_declared).toBe(2)
    expect(column.metadata.column_answer.consumers.exposures.map((c: any) => [c.name, c.tier])).toEqual([["board", "carries"]])
  })

  test("a column the model doesn't have is a column error, with no column reach or answer", async () => {
    const manifest_path = setup({
      "exposure.shop.fct_board": { name: "fct_board", label: "Fct board", depends_on: { nodes: ["model.shop.fct"] } },
    })
    const result = await run({ model: "fct", column: "not_a_column", manifest_path })
    const error = "fct has no column not_a_column; its columns are order_id, revenue"
    expect(result.metadata.column_reach).toBeUndefined()
    expect(result.metadata.column_answer).toBeUndefined()
    expect(result.metadata.column_reach_error).toBe(error)
    expect(result.metadata.column_answer_error).toBe(error)
    expect(result.output).toContain(`Column Reach: not traced (${error}); the model-level impact above stands`)
  })

  test("the MCP structured result carries it", async () => {
    const manifest_path = setup()
    const result = await run({ model: "fct", column: "revenue", manifest_path })
    const structured = structuredResult("impact_analysis", result.metadata, result.output)
    expect(structured.truncated).toBeUndefined()
    expect((structured.column_answer as any)?.version).toBe(1)
    expect(structured.column_answer).toEqual(result.metadata.column_answer)
    expect(structured.column_reach).toEqual(result.metadata.column_reach)
  })
})

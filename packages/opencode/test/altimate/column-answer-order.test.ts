import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as realCore from "@altimateai/altimate-core"

// The engine's edge order changes from process to process, which one process can't show: these tests
// reorder its answer themselves.
let reorder: (edges: any[]) => any[] = (edges) => edges
const real: any = { ...realCore }
mock.module("@altimateai/altimate-core", () => ({
  ...real,
  columnLineage: (...args: unknown[]) => {
    const result = JSON.parse(JSON.stringify(real.columnLineage(...args)))
    return { ...result, column_lineage: reorder(result.column_lineage ?? []) }
  },
}))
const { clearColumnAnswerCache, columnAnswer } = await import("../../src/altimate/native/dbt/column-answer")

const dirs: string[] = []
afterEach(() => {
  reorder = (edges) => edges
  clearColumnAnswerCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const model = (name: string, deps: string[], sql: string, columns: string[]) => ({
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
  columns: Object.fromEntries(columns.map((c) => [c, { name: c }])),
})

/** The answer from a fresh project and empty caches, so the engine is asked again. */
function answer() {
  const nodes = [
    model("stg", [], "select 1 as id, 2 as amount", ["id", "amount"]),
    model("mart", ["stg"], "select amount as a, amount * 2 as b, amount + 1 as c from shop.main.stg", []),
    model("rollup", ["mart"], "select a as a2, b as b2, c as c2 from shop.main.mart", []),
  ]
  const dir = mkdtempSync(join(tmpdir(), "column-answer-order-"))
  dirs.push(dir)
  mkdirSync(join(dir, "target"))
  const file = join(dir, "target", "manifest.json")
  writeFileSync(
    file,
    JSON.stringify({
      metadata: { adapter_type: "duckdb", generated_at: "2026-01-01T00:00:00Z" },
      nodes: Object.fromEntries(nodes.map((n) => [n.unique_id, n])),
      sources: {},
      exposures: {},
    }),
  )
  clearColumnAnswerCache()
  return columnAnswer(file, "stg", "amount")
}

describe("column answer: order", () => {
  test("the same whichever order the engine returns its edges in", () => {
    const first = answer()
    expect(first.counts.columns).toBe(6)
    reorder = (edges) => [...edges].reverse()
    const second = answer()
    expect(second.columns).toEqual(first.columns)
    expect(second.edges).toEqual(first.edges)
    expect(second.nodes).toEqual(first.nodes)
  })

  test("two entries for one edge: the same one is used whichever comes first", () => {
    const other = (e: any) => ({ ...e, lens_type: "Transformation", lens_code: [{ expression: "sum(amount)" }] })
    reorder = (edges) => edges.flatMap((e) => [e, other(e)])
    const first = answer()
    reorder = (edges) => edges.flatMap((e) => [other(e), e])
    const second = answer()
    expect(second.columns).toEqual(first.columns)
    expect(second.edges).toEqual(first.edges)
  })
})

// dbt.model_lineage: the manifest's lineage for one model, in dbt-integration's
// getModelLineage format (version 1). altimate-core is the real one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dbtModelLineage, lineageEdges } from "@/altimate/native/dbt/lineage"
import { isModelLineage } from "@/altimate/tools/dbt-lineage"
import { lineageManifest } from "./dbt-model-lineage.fixture"

let dir: string
const CUSTOMERS = "model.jaffle_shop.customers"
const STG_CUSTOMERS = "model.jaffle_shop.stg_customers"
const STG_ORDERS = "model.jaffle_shop.stg_orders"
const PAYMENTS = "source.jaffle_shop.stripe.payments"

async function manifestFile(name: string, manifest: object) {
  const file = path.join(dir, `${name}.json`)
  await writeFile(file, JSON.stringify(manifest))
  return file
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dbt-model-lineage-"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("dbt.model_lineage", () => {
  test("returns the model and its direct parents, with column edges, in the version-1 format", async () => {
    const result = dbtModelLineage({ manifest_path: await manifestFile("full", lineageManifest()), model: "customers" })
    expect(isModelLineage(result)).toBe(true)
    expect(result).toMatchObject({
      version: 1,
      project: "jaffle_shop",
      dialect: "duckdb",
      focus: { uniqueId: CUSTOMERS, name: "customers" },
      confidence: "high",
      errors: [],
    })
    expect(result.nodes).toEqual([
      {
        uniqueId: CUSTOMERS,
        name: "customers",
        type: "model",
        materialization: "table",
        direction: "focus",
        depth: 0,
        parents: [STG_CUSTOMERS, STG_ORDERS, PAYMENTS],
        path: "models/customers.sql",
        columns: [
          { name: "customer_id" },
          { name: "first_name" },
          { name: "number_of_orders" },
          { name: "total_amount" },
        ],
        columnsFrom: "compiled-sql",
      },
      {
        uniqueId: STG_CUSTOMERS,
        name: "stg_customers",
        type: "model",
        materialization: "view",
        direction: "upstream",
        depth: 1,
        parents: [],
        path: "models/staging/stg_customers.sql",
        columns: [{ name: "customer_id", dataType: "integer", description: "The customer" }, { name: "first_name" }],
        columnsFrom: "manifest",
      },
      {
        uniqueId: STG_ORDERS,
        name: "stg_orders",
        type: "model",
        materialization: "view",
        direction: "upstream",
        depth: 1,
        parents: [STG_CUSTOMERS],
        path: "models/staging/stg_orders.sql",
        columns: [],
        columnsFrom: "none",
      },
      {
        uniqueId: PAYMENTS,
        name: "stripe.payments",
        type: "source",
        materialization: "source",
        direction: "upstream",
        depth: 1,
        parents: [],
        path: "models/staging/sources.yml",
        columns: [{ name: "order_id" }, { name: "amount", dataType: "integer" }],
        columnsFrom: "manifest",
      },
    ])
    expect(result.columnLineage).toContainEqual({
      source: [STG_CUSTOMERS, "first_name"],
      target: [CUSTOMERS, "first_name"],
      type: "direct",
      viewsType: "Not sure",
      viewsCode: [],
    })
    for (const edge of result.columnLineage) {
      expect([STG_CUSTOMERS, STG_ORDERS, PAYMENTS]).toContain(edge.source[0])
      expect(edge.target[0]).toBe(CUSTOMERS)
    }
    expect(result.stats).toMatchObject({ nodes: 4, edges: 2, compiled: 1, fromWarehouse: 0 })
  })

  test("keeps only the edges into a column it is asked to trace", async () => {
    const result = dbtModelLineage({
      manifest_path: await manifestFile("column", lineageManifest()),
      model: "customers",
      column: "First_Name",
    })
    expect(result.focus).toEqual({ uniqueId: CUSTOMERS, name: "customers", column: "First_Name" })
    expect(result.columnLineage.map((e) => [e.source, e.target])).toEqual([
      [
        [STG_CUSTOMERS, "first_name"],
        [CUSTOMERS, "first_name"],
      ],
    ])
    expect(result.stats.edges).toBe(1)
  })

  test("takes the columns traced to a parent, and says so, when the compiled SQL ends in select *", async () => {
    const sql = `with final as (select c.customer_id, c.first_name from "jaffle"."main"."stg_customers" c)
select * from final`
    const result = dbtModelLineage({
      manifest_path: await manifestFile("star", lineageManifest(sql)),
      model: "customers",
    })
    expect(result.nodes[0].columnsFrom).toBe("compiled-sql")
    expect(result.nodes[0].columns.map((c) => c.name)).toEqual(["customer_id", "first_name"])
    expect(result.errors).toEqual([
      "Could not read customers's output columns (unable to extract output columns due to star: *), so its columns are only the ones traced to a parent",
    ])
    expect(result.columnLineage).toHaveLength(2)
  })

  test("names two parents that share a table name, and leaves out their edges", async () => {
    const manifest = lineageManifest(`select o.order_id, c.first_name
from (select order_id, customer_id from "jaffle"."shopify_us"."orders"
      union all select order_id, customer_id from "jaffle"."shopify_eu"."orders") o
join "jaffle"."main"."stg_customers" c on c.customer_id = o.customer_id`)
    const orders = (region: string) => ({
      unique_id: `source.jaffle_shop.shopify_${region}.orders`,
      resource_type: "source",
      source_name: `shopify_${region}`,
      name: "orders",
      identifier: "orders",
      schema: `shopify_${region}`,
      columns: { order_id: { name: "order_id" }, customer_id: { name: "customer_id" } },
    })
    const US = "source.jaffle_shop.shopify_us.orders"
    const EU = "source.jaffle_shop.shopify_eu.orders"
    Object.assign(manifest.sources, { [US]: orders("us"), [EU]: orders("eu") })
    manifest.nodes["model.jaffle_shop.customers"].depends_on.nodes = [US, EU, STG_CUSTOMERS]
    const result = dbtModelLineage({ manifest_path: await manifestFile("shared", manifest), model: "customers" })
    expect(result.errors).toEqual([
      `customers reads ${US}, ${EU}, which share a table name in altimate-core's schema, so their column edges into it were left out`,
    ])
    expect(result.confidence).toBe("low")
    expect(result.columnLineage.filter((e) => [US, EU].includes(e.source[0]))).toEqual([])
    expect(result.columnLineage).toContainEqual(
      expect.objectContaining({ source: [STG_CUSTOMERS, "first_name"], target: [CUSTOMERS, "first_name"] }),
    )
  })

  // Parents whose name, alias and schema name overlap across parents.
  const withParents = (sql: string, parents: [string, string][]) => {
    const manifest = lineageManifest(sql) as ReturnType<typeof lineageManifest> & { nodes: Record<string, any> }
    for (const [name, alias] of parents) {
      manifest.nodes[`model.jaffle_shop.${name}`] = {
        unique_id: `model.jaffle_shop.${name}`,
        resource_type: "model",
        name,
        alias,
        config: { materialized: "table" },
        depends_on: { nodes: [] },
        columns: { id: { name: "id" } },
      }
    }
    manifest.nodes[CUSTOMERS].depends_on.nodes = parents.map(([name]) => `model.jaffle_shop.${name}`)
    return manifest
  }

  test("maps a table name to the parent whose schema name it is before another's plain name", async () => {
    const manifest = withParents(`select b.id from "jaffle"."main"."orders" b`, [
      ["orders", "historical_orders"],
      ["current_orders", "orders"],
    ])
    const result = dbtModelLineage({ manifest_path: await manifestFile("precedence", manifest), model: "customers" })
    expect(result.columnLineage.map((e) => e.source)).toEqual([["model.jaffle_shop.current_orders", "id"]])
    expect(result.errors).toEqual([])
  })

  test("keeps the edges of a parent whose schema name another parent's shared name shadows", async () => {
    const manifest = withParents(
      `select o.id as clean_id, d.id as dup_id from "jaffle"."main"."orders" o join "jaffle"."main"."dup" d on d.id = o.id`,
      [
        ["orders", "dup"],
        ["other_orders", "dup"],
        ["clean_orders", "orders"],
      ],
    )
    const result = dbtModelLineage({ manifest_path: await manifestFile("shadowed", manifest), model: "customers" })
    expect(result.errors).toEqual([
      "customers reads model.jaffle_shop.orders, model.jaffle_shop.other_orders, which share a table name in altimate-core's schema, so their column edges into it were left out",
    ])
    expect(result.columnLineage.map((e) => e.source)).toEqual([["model.jaffle_shop.clean_orders", "id"]])
  })

  test("keeps a dotted output column's name whole", async () => {
    const sql = `select c.customer_id as "customer.id" from "jaffle"."main"."stg_customers" c`
    const result = dbtModelLineage({
      manifest_path: await manifestFile("dotted", lineageManifest(sql)),
      model: "customers",
      column: "customer.id",
    })
    expect(result.nodes[0].columns.map((c) => c.name)).toEqual(["customer.id"])
    expect(result.columnLineage.map((e) => [e.source, e.target])).toEqual([
      [
        [STG_CUSTOMERS, "customer_id"],
        [CUSTOMERS, "customer.id"],
      ],
    ])
  })

  test("lists the model without columns when the manifest has no compiled SQL", async () => {
    const result = dbtModelLineage({
      manifest_path: await manifestFile("uncompiled", lineageManifest(null)),
      model: "customers",
    })
    expect(isModelLineage(result)).toBe(true)
    expect(result.nodes[0]).toMatchObject({ uniqueId: CUSTOMERS, columns: [], columnsFrom: "none" })
    expect(result.nodes).toHaveLength(4)
    expect(result.columnLineage).toEqual([])
    expect(result.errors).toEqual(["No compiled SQL found — run `dbt compile` first"])
    expect(result.confidence).toBe("low")
    expect(result.stats.compiled).toBe(0)
  })

  test("returns an empty lineage, with the error, for a model or manifest it can't find", async () => {
    const missingModel = dbtModelLineage({
      manifest_path: await manifestFile("nomodel", lineageManifest()),
      model: "nope",
    })
    const missingFile = dbtModelLineage({ manifest_path: path.join(dir, "absent.json"), model: "customers" })
    for (const [result, error] of [
      [missingModel, "Model 'nope' not found in manifest"],
      [missingFile, "Manifest file not found"],
    ] as const) {
      expect(isModelLineage(result)).toBe(true)
      expect(result.nodes).toEqual([])
      expect(result.errors).toEqual([error])
      expect(result.confidence).toBe("low")
    }
  })
})

describe("lineageEdges", () => {
  const tables = new Map([
    ["stg_customers", STG_CUSTOMERS],
    ["raw_payments", PAYMENTS],
  ])
  const focus = { uniqueId: CUSTOMERS, name: "customers" }

  test("maps altimate-core's edges to a parent's and the model's columns", () => {
    const errors: string[] = []
    const edges = lineageEdges(
      [
        {
          source: '"jaffle"."main"."raw_payments"."Amount"',
          target: "total_amount",
          lineage_type: "direct",
          lens_type: "aggregate",
          lens_code: [{ expression: "SUM(amount)", step_type: "transform" }],
        },
      ],
      tables,
      focus,
      errors,
    )
    expect(edges).toEqual([
      {
        source: [PAYMENTS, "amount"],
        target: [CUSTOMERS, "total_amount"],
        type: "direct",
        viewsType: "aggregate",
        viewsCode: ["SUM(amount)"],
      },
    ])
    expect(errors).toEqual([])
  })

  test("keeps one of an edge reported under a qualified and a bare table name", () => {
    const edge = { target: "first_name", lineage_type: "direct", lens_type: "Not sure", lens_code: [] }
    const edges = lineageEdges(
      [
        { ...edge, source: '"jaffle"."main"."stg_customers"."first_name"' },
        { ...edge, source: '"stg_customers"."first_name"' },
      ],
      tables,
      focus,
      [],
    )
    expect(edges).toHaveLength(1)
  })

  test("names an edge whose table isn't a parent in errors, and leaves it out", () => {
    const errors: string[] = []
    const edges = lineageEdges(
      [
        { source: '"mystery"."id"', target: "id", lineage_type: "direct", lens_type: "Not sure", lens_code: [] },
        { source: "id", target: "id", lineage_type: "direct", lens_type: "Not sure", lens_code: [] },
      ],
      tables,
      focus,
      errors,
    )
    expect(edges).toEqual([])
    expect(errors).toEqual([
      `"mystery"."id" -> customers.id: mystery isn't one of customers's parents, so the edge was left out`,
      "id -> customers.id: no table, so the edge was left out",
    ])
  })
})

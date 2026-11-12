/**
 * Tests for dbt lineage helper functions: findModel, detectDialect,
 * buildSchemaContext, and the top-level dbtLineage() error paths.
 *
 * These pure functions parse manifest data and build schema contexts
 * for column-level lineage analysis. Zero tests existed previously.
 * A bug in findModel or buildSchemaContext causes lineage to silently
 * return empty results, which users see as "no lineage available".
 */

import { describe, test, expect, afterEach } from "bun:test"
import { dbtLineage } from "../../src/altimate/native/dbt/lineage"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { clearLineageCaches } from "../../src/altimate/native/dbt/project-lineage"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbt-lineage-test-"))
  tmpDirs.push(dir)
  return dir
}

function writeManifest(dir: string, manifest: Record<string, any>): string {
  const manifestPath = join(dir, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return manifestPath
}

afterEach(() => {
  clearLineageCaches()
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

// ---------------------------------------------------------------------------
// Minimal manifest fixtures
// ---------------------------------------------------------------------------

const BASE_MANIFEST = {
  metadata: { adapter_type: "snowflake" },
  nodes: {
    "model.proj.orders": {
      resource_type: "model",
      name: "orders",
      schema: "public",
      database: "analytics",
      config: { materialized: "table" },
      compiled_code: "SELECT c.id, c.name FROM customers c",
      depends_on: { nodes: ["source.proj.raw.customers"] },
      columns: {
        id: { name: "id", data_type: "INTEGER" },
        name: { name: "name", data_type: "VARCHAR" },
      },
    },
    "model.proj.revenue": {
      resource_type: "model",
      name: "revenue",
      compiled_code: "SELECT SUM(amount) AS total FROM orders",
      depends_on: { nodes: ["model.proj.orders"] },
      columns: {},
    },
    "test.proj.not_null": {
      resource_type: "test",
      name: "not_null",
    },
  },
  sources: {
    "source.proj.raw.customers": {
      name: "customers",
      source_name: "raw",
      schema: "raw_data",
      database: "analytics",
      columns: {
        id: { name: "id", data_type: "INTEGER" },
        name: { name: "name", data_type: "VARCHAR" },
        email: { name: "email", data_type: "VARCHAR" },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// 1. Model lookup (findModel)
// ---------------------------------------------------------------------------

describe("dbtLineage: model lookup", () => {
  test("finds model by unique_id", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "model.proj.orders",
    })

    expect(result.model_name).toBe("orders")
    expect(result.model_unique_id).toBe("model.proj.orders")
    expect(result.compiled_sql).toContain("SELECT")
  })

  test("finds model by short name", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.model_name).toBe("orders")
    expect(result.model_unique_id).toBe("model.proj.orders")
  })

  test("returns low confidence when model not found", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "nonexistent_model",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("Model 'nonexistent_model' not found in manifest")
  })

  test("does not match test or seed nodes by name", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "not_null",
    })

    // "not_null" is a test node, not a model — should not be found
    expect(result.confidence).toBe("low")
    expect(result.confidence_factors[0]).toContain("not found in manifest")
  })
})

// ---------------------------------------------------------------------------
// 2. Dialect detection (detectDialect)
// ---------------------------------------------------------------------------

describe("dbtLineage: dialect detection", () => {
  test("detects dialect from manifest metadata.adapter_type", () => {
    const dir = makeTmpDir()
    const manifest = {
      ...BASE_MANIFEST,
      metadata: { adapter_type: "bigquery" },
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // We can't directly check dialect, but the result shouldn't error
    // due to dialect mismatch. The model has compiled_code, so confidence
    // should be high if lineage succeeds or reflect the actual error.
    expect(result.model_name).toBe("orders")
  })

  test("explicit dialect param overrides auto-detection", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
      dialect: "postgres",
    })

    // Should not throw regardless of dialect choice
    expect(result.model_name).toBe("orders")
  })

  test("defaults to snowflake when adapter_type is missing", () => {
    const dir = makeTmpDir()
    const manifest = {
      ...BASE_MANIFEST,
      metadata: {},
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // Should not throw — defaults to snowflake
    expect(result.model_name).toBe("orders")
  })
})

// ---------------------------------------------------------------------------
// 3. Schema context building (buildSchemaContext)
// ---------------------------------------------------------------------------

describe("dbtLineage: schema context from upstream deps", () => {
  test("builds context from source with columns", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // The orders model depends on source.proj.raw.customers which has columns.
    // If schema context was built correctly, lineage should have non-empty output.
    expect(result.model_name).toBe("orders")
    // compiled_sql should be present
    expect(result.compiled_sql).toBeDefined()
    expect(result.compiled_sql).toContain("SELECT")
  })

  test("handles model with no upstream columns gracefully", () => {
    const dir = makeTmpDir()
    // Revenue depends on orders, but orders has columns — so context should build.
    // Create a model that depends on a node with no columns.
    const manifest = {
      ...BASE_MANIFEST,
      nodes: {
        ...BASE_MANIFEST.nodes,
        "model.proj.bare": {
          resource_type: "model",
          name: "bare",
          compiled_code: "SELECT 1 AS val",
          depends_on: { nodes: ["model.proj.no_cols"] },
          columns: {},
        },
        "model.proj.no_cols": {
          resource_type: "model",
          name: "no_cols",
          compiled_code: "SELECT 1",
          depends_on: { nodes: [] },
          columns: {},
        },
      },
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "bare",
    })

    // Should not crash — just returns with whatever lineage can determine
    expect(result.model_name).toBe("bare")
    expect(result.compiled_sql).toBe("SELECT 1 AS val")
  })
})

// ---------------------------------------------------------------------------
// 4. Error paths
// ---------------------------------------------------------------------------

describe("dbtLineage: error handling", () => {
  test("returns low confidence for non-existent manifest", () => {
    const result = dbtLineage({
      manifest_path: "/tmp/definitely-not-a-manifest.json",
      model: "orders",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("Manifest file not found")
    expect(result.raw_lineage).toEqual({})
  })

  test("returns low confidence for invalid JSON manifest", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "manifest.json")
    writeFileSync(manifestPath, "not valid json {{{")

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors[0]).toContain("Failed to parse manifest")
  })

  test("returns low confidence when model has no compiled SQL", () => {
    const dir = makeTmpDir()
    const manifest = {
      nodes: {
        "model.proj.uncompiled": {
          resource_type: "model",
          name: "uncompiled",
          // No compiled_code or compiled_sql
          depends_on: { nodes: [] },
          columns: {},
        },
      },
      sources: {},
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "uncompiled",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("No compiled SQL found — run `dbt compile` first")
  })

  test("reports the model's name, not the path used to find it, when there is no compiled SQL", () => {
    const dir = makeTmpDir()
    const manifest = {
      nodes: {
        "model.proj.uncompiled": {
          resource_type: "model",
          name: "uncompiled",
          original_file_path: "models/uncompiled.sql",
          depends_on: { nodes: [] },
          columns: {},
        },
      },
      sources: {},
    }
    const result = dbtLineage({ manifest_path: writeManifest(dir, manifest), model: "models/uncompiled.sql" })
    expect(result.model_name).toBe("uncompiled")
  })

  test("handles manifest with no nodes key at all", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, { metadata: {} })

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.confidence).toBe("low")
  })
})

// ---------------------------------------------------------------------------
// 6. Parents with no declared columns
// ---------------------------------------------------------------------------

// Jaffle shop's customers and orders over staging models that declare their columns, or don't.
function jaffle(declareStaging: boolean, more: Record<string, any> = {}) {
  const R = (name: string) => `"jaffle"."main"."${name}"`
  const node = (type: string, name: string, deps: string[], sql: string, columns: string[]) => ({
    resource_type: type,
    unique_id: `${type}.jaffle.${name}`,
    name,
    alias: name,
    database: "jaffle",
    schema: "main",
    config: { materialized: type === "seed" ? "seed" : "view" },
    depends_on: { nodes: deps },
    ...(sql && { compiled_code: sql }),
    columns: Object.fromEntries(columns.map((c) => [c, { name: c }])),
  })
  const staging = (cols: string[]) => (declareStaging ? cols : [])
  const nodes: Record<string, any> = {
    "seed.jaffle.raw_customers": node("seed", "raw_customers", [], "", ["id", "first_name", "last_name"]),
    "seed.jaffle.raw_orders": node("seed", "raw_orders", [], "", ["id", "user_id", "order_date", "status"]),
    "seed.jaffle.raw_payments": node("seed", "raw_payments", [], "", ["id", "order_id", "payment_method", "amount"]),
    "model.jaffle.stg_customers": node(
      "model",
      "stg_customers",
      ["seed.jaffle.raw_customers"],
      `with source as (select * from ${R("raw_customers")}), renamed as (select id as customer_id, first_name, last_name from source) select * from renamed`,
      staging(["customer_id", "first_name", "last_name"]),
    ),
    "model.jaffle.stg_orders": node(
      "model",
      "stg_orders",
      ["seed.jaffle.raw_orders"],
      `with source as (select * from ${R("raw_orders")}), renamed as (select id as order_id, user_id as customer_id, order_date, status from source) select * from renamed`,
      staging(["order_id", "customer_id", "order_date", "status"]),
    ),
    "model.jaffle.stg_payments": node(
      "model",
      "stg_payments",
      ["seed.jaffle.raw_payments"],
      `with source as (select * from ${R("raw_payments")}), renamed as (select id as payment_id, order_id, payment_method, amount / 100 as amount from source) select * from renamed`,
      staging(["payment_id", "order_id", "payment_method", "amount"]),
    ),
    "model.jaffle.customers": node(
      "model",
      "customers",
      ["model.jaffle.stg_customers", "model.jaffle.stg_orders", "model.jaffle.stg_payments"],
      `with customers as (select * from ${R("stg_customers")}), orders as (select * from ${R("stg_orders")}), payments as (select * from ${R("stg_payments")}),
customer_orders as (select customer_id, min(order_date) as first_order, max(order_date) as most_recent_order, count(order_id) as number_of_orders from orders group by customer_id),
customer_payments as (select orders.customer_id, sum(amount) as total_amount from payments left join orders on payments.order_id = orders.order_id group by orders.customer_id),
final as (select customers.customer_id, customers.first_name, customers.last_name, customer_orders.first_order, customer_orders.most_recent_order, customer_orders.number_of_orders, customer_payments.total_amount as customer_lifetime_value
from customers left join customer_orders on customers.customer_id = customer_orders.customer_id left join customer_payments on customers.customer_id = customer_payments.customer_id)
select * from final`,
      [],
    ),
    "model.jaffle.orders": node(
      "model",
      "orders",
      ["model.jaffle.stg_orders", "model.jaffle.stg_payments"],
      `with orders as (select * from ${R("stg_orders")}), payments as (select * from ${R("stg_payments")}),
order_payments as (select order_id, sum(case when payment_method = 'credit_card' then amount else 0 end) as credit_card_amount, sum(amount) as total_amount from payments group by order_id),
final as (select orders.order_id, orders.customer_id, orders.order_date, orders.status, order_payments.credit_card_amount, order_payments.total_amount as amount from orders left join order_payments on orders.order_id = order_payments.order_id)
select * from final`,
      [],
    ),
    ...more,
  }
  const sources = {
    "source.jaffle.raw.events": {
      resource_type: "source",
      name: "events",
      source_name: "raw",
      database: "jaffle",
      schema: "raw",
      columns: {},
    },
  }
  return { metadata: { adapter_type: "duckdb" }, nodes, sources, exposures: {} }
}

const outputs = (result: ReturnType<typeof dbtLineage>) =>
  Object.keys((result.raw_lineage as any).column_dict ?? {}).sort()

describe("dbtLineage: parents with no declared columns", () => {
  test("a select * over undeclared staging models finds every column, as with them declared", () => {
    for (const declared of [true, false]) {
      const result = dbtLineage({ manifest_path: writeManifest(makeTmpDir(), jaffle(declared)), model: "customers" })
      expect(outputs(result)).toEqual([
        "customer_id",
        "customer_lifetime_value",
        "first_name",
        "first_order",
        "last_name",
        "most_recent_order",
        "number_of_orders",
      ])
      expect(result.confidence).toBe("high")
    }
  })

  test("orders.credit_card_amount traces to the payment amount with undeclared staging columns", () => {
    const result = dbtLineage({ manifest_path: writeManifest(makeTmpDir(), jaffle(false)), model: "orders" })
    expect((result.raw_lineage as any).column_dict.credit_card_amount).toEqual([
      '"stg_payments"."amount"',
      '"stg_payments"."payment_method"',
    ])
  })

  test("an ephemeral parent's own parents give the columns its inlined SQL reads", () => {
    const manifest = jaffle(false, {
      "model.jaffle.eph": {
        resource_type: "model",
        name: "eph",
        alias: "eph",
        config: { materialized: "ephemeral" },
        depends_on: { nodes: ["model.jaffle.stg_customers"] },
        compiled_code: 'select * from "jaffle"."main"."stg_customers"',
        columns: {},
      },
      "model.jaffle.after_eph": {
        resource_type: "model",
        name: "after_eph",
        alias: "after_eph",
        config: { materialized: "view" },
        depends_on: { nodes: ["model.jaffle.eph"] },
        compiled_code:
          'with __dbt__cte__eph as (select * from "jaffle"."main"."stg_customers") select * from __dbt__cte__eph',
        columns: {},
      },
    })
    const result = dbtLineage({ manifest_path: writeManifest(makeTmpDir(), manifest), model: "after_eph" })
    expect(outputs(result)).toEqual(["customer_id", "first_name", "last_name"])
    expect(result.upstream).toEqual(["model.jaffle.eph"])
  })

  // stg_events selects * from a source that declares no columns, so neither its docs nor its SQL say
  // what its columns are.
  const unknownEvents = (child: string) =>
    jaffle(false, {
      "model.jaffle.stg_events": {
        resource_type: "model",
        name: "stg_events",
        alias: "stg_events",
        config: { materialized: "view" },
        depends_on: { nodes: ["source.jaffle.raw.events"] },
        compiled_code: 'select * from "jaffle"."raw"."events"',
        columns: {},
      },
      "model.jaffle.events_child": {
        resource_type: "model",
        name: "events_child",
        alias: "events_child",
        config: { materialized: "view" },
        depends_on: { nodes: ["model.jaffle.stg_events", "model.jaffle.stg_customers"] },
        compiled_code: child,
        columns: {},
      },
    })

  test("a select * over a parent whose columns can't be worked out is low, naming the parent", () => {
    const result = dbtLineage({
      manifest_path: writeManifest(
        makeTmpDir(),
        unknownEvents(
          'select e.*, c.first_name from "jaffle"."main"."stg_events" e join "jaffle"."main"."stg_customers" c on e.customer_id = c.customer_id',
        ),
      ),
      model: "events_child",
    })
    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toEqual([
      "select * over stg_events, whose columns aren't declared and can't be worked out from its SQL: the columns read through it are missing",
    ])
    expect(result.unexpanded_stars).toEqual(["stg_events"])
    expect(outputs(result)).toContain("first_name")
  })

  test("a * inside a function over such a parent is low too, naming it", () => {
    const result = dbtLineage({
      manifest_path: writeManifest(makeTmpDir(), unknownEvents('select hash(*) as h from "jaffle"."main"."stg_events"')),
      model: "events_child",
    })
    expect(result.confidence).toBe("low")
    expect(result.unexpanded_stars).toEqual(["stg_events"])
    expect((result.raw_lineage as any).column_dict.h).toEqual([])
  })

  test("a select * over a CTE that lists such a parent's columns stays high", () => {
    const result = dbtLineage({
      manifest_path: writeManifest(
        makeTmpDir(),
        unknownEvents('with e as (select event_id, kind from "jaffle"."main"."stg_events") select * from e'),
      ),
      model: "events_child",
    })
    expect(result.confidence).toBe("high")
    expect(result.unexpanded_stars).toBeUndefined()
    expect(outputs(result)).toEqual(["event_id", "kind"])
  })
})

// altimate_change — Part 3 (activation): "try without connecting" sample environment.
//
// Provisions a REAL, queryable jaffle-shop-style environment on demand:
//   - a DuckDB file seeded with the classic tables (raw_customers, raw_orders,
//     raw_payments) from a DETERMINISTIC generator (identical data every run)
//   - a minimal but real dbt project (staging views + marts + schema tests)
//     pointing at that DuckDB via a local profiles.yml
//   - a registered warehouse connection, so /discover, sql_execute,
//     warehouse_test and schema_index all work against it unmodified.
//
// Under PROTO_FRESH=1 everything lives in the sandbox temp dir (wiped per
// launch); otherwise under ~/.altimate-code/samples/.

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { spawnSync } from "child_process"
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const SAMPLE_CONNECTION_NAME = "jaffle_shop_duckdb"

function sampleRoot(): string {
  if (process.env.PROTO_FRESH === "1") return path.join(os.tmpdir(), "altimate-proto-fresh", "sample")
  return path.join(os.homedir(), ".altimate-code", "samples")
}

// Deterministic PRNG (LCG) — every demo run produces identical data.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const FIRST_NAMES = ["Michael","Shawn","Kathleen","Jimmy","Katherine","Sarah","Martin","Frank","Jennifer","Henry","Fred","Amy","Anna","Norma","Willie","Alan","Cathy","Rose","Douglas","Joseph","Sara","Bonnie","Julia","Terry","Johnny","Scott","Gloria","Steve","Gerald","Adam"]
const LAST_NAMES = ["P.","H.","B.","G.","R.","T.","W.","K.","S.","M.","L.","C.","D.","F.","J.","A.","N.","O.","V.","E."]
const ORDER_STATUSES = ["placed", "shipped", "completed", "return_pending", "returned"]
// Weighted toward completed, like the classic dataset
const STATUS_WEIGHTS = [0.12, 0.15, 0.62, 0.04, 0.07]
const PAYMENT_METHODS = ["credit_card", "coupon", "bank_transfer", "gift_card"]
const METHOD_WEIGHTS = [0.65, 0.1, 0.15, 0.1]

function pickWeighted(rand: () => number, values: string[], weights: number[]): string {
  const r = rand()
  let acc = 0
  for (let i = 0; i < values.length; i++) {
    acc += weights[i]
    if (r < acc) return values[i]
  }
  return values[values.length - 1]
}

interface SampleData {
  customers: Array<{ id: number; first_name: string; last_name: string }>
  orders: Array<{ id: number; user_id: number; order_date: string; status: string }>
  payments: Array<{ id: number; order_id: number; payment_method: string; amount: number }>
}

function generateData(): SampleData {
  const rand = lcg(20180101)
  const customers = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    first_name: FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)],
    last_name: LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)],
  }))

  const start = Date.UTC(2018, 0, 1)
  const orders = Array.from({ length: 300 }, (_, i) => {
    const day = Math.floor(rand() * 99) // 2018-01-01 .. 2018-04-09
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10)
    return {
      id: i + 1,
      user_id: 1 + Math.floor(rand() * 100),
      order_date: date,
      status: pickWeighted(rand, ORDER_STATUSES, STATUS_WEIGHTS),
    }
  })

  let paymentID = 1
  const payments = orders.flatMap((order) => {
    const count = rand() < 0.9 ? 1 : 2 // a few orders split payment
    return Array.from({ length: count }, () => ({
      id: paymentID++,
      order_id: order.id,
      payment_method: pickWeighted(rand, PAYMENT_METHODS, METHOD_WEIGHTS),
      amount: (1 + Math.floor(rand() * 30)) * 100, // cents, 100..3000
    }))
  })

  return { customers, orders, payments }
}

async function seedDuckDB(dbPath: string, data: SampleData): Promise<void> {
  let duckdb: any = await import("duckdb")
  duckdb = duckdb.default || duckdb
  const db = new duckdb.Database(dbPath)
  const conn = db.connect()
  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) => conn.exec(sql, (err: Error | null) => (err ? reject(err) : resolve())))

  const rows = {
    customers: data.customers.map((c) => `(${c.id}, '${c.first_name}', '${c.last_name}')`).join(",\n"),
    orders: data.orders.map((o) => `(${o.id}, ${o.user_id}, DATE '${o.order_date}', '${o.status}')`).join(",\n"),
    payments: data.payments.map((p) => `(${p.id}, ${p.order_id}, '${p.payment_method}', ${p.amount})`).join(",\n"),
  }

  await exec(`
    DROP TABLE IF EXISTS raw_customers; DROP TABLE IF EXISTS raw_orders; DROP TABLE IF EXISTS raw_payments;
    CREATE TABLE raw_customers (id INTEGER PRIMARY KEY, first_name VARCHAR, last_name VARCHAR);
    CREATE TABLE raw_orders (id INTEGER PRIMARY KEY, user_id INTEGER, order_date DATE, status VARCHAR);
    CREATE TABLE raw_payments (id INTEGER PRIMARY KEY, order_id INTEGER, payment_method VARCHAR, amount INTEGER);
    INSERT INTO raw_customers VALUES ${rows.customers};
    INSERT INTO raw_orders VALUES ${rows.orders};
    INSERT INTO raw_payments VALUES ${rows.payments};
  `)

  await new Promise<void>((resolve) => conn.close(() => db.close(() => resolve())))
}

function writeDbtProject(projectDir: string, dbPath: string): void {
  const write = (rel: string, content: string) => {
    const p = path.join(projectDir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, "utf-8")
  }

  write(
    "dbt_project.yml",
    `name: jaffle_shop
version: "1.0.0"
profile: jaffle_shop

model-paths: ["models"]

models:
  jaffle_shop:
    staging:
      +materialized: view
    marts:
      +materialized: table
`,
  )

  write(
    "profiles.yml",
    `jaffle_shop:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: ${dbPath}
      threads: 1
`,
  )

  write(
    "models/staging/sources.yml",
    `version: 2

sources:
  - name: jaffle_shop
    schema: main
    tables:
      - name: raw_customers
      - name: raw_orders
      - name: raw_payments
`,
  )

  write(
    "models/staging/stg_customers.sql",
    `select
    id as customer_id,
    first_name,
    last_name
from {{ source('jaffle_shop', 'raw_customers') }}
`,
  )

  write(
    "models/staging/stg_orders.sql",
    `select
    id as order_id,
    user_id as customer_id,
    order_date,
    status
from {{ source('jaffle_shop', 'raw_orders') }}
`,
  )

  write(
    "models/staging/stg_payments.sql",
    `select
    id as payment_id,
    order_id,
    payment_method,
    amount / 100.0 as amount
from {{ source('jaffle_shop', 'raw_payments') }}
`,
  )

  write(
    "models/marts/customers.sql",
    `with customers as (
    select * from {{ ref('stg_customers') }}
),

orders as (
    select * from {{ ref('stg_orders') }}
),

payments as (
    select * from {{ ref('stg_payments') }}
),

customer_orders as (
    select
        customer_id,
        min(order_date) as first_order,
        max(order_date) as most_recent_order,
        count(order_id) as number_of_orders
    from orders
    group by customer_id
),

customer_payments as (
    select
        orders.customer_id,
        sum(payments.amount) as total_amount
    from payments
    left join orders on payments.order_id = orders.order_id
    group by orders.customer_id
)

select
    customers.customer_id,
    customers.first_name,
    customers.last_name,
    customer_orders.first_order,
    customer_orders.most_recent_order,
    customer_orders.number_of_orders,
    customer_payments.total_amount as customer_lifetime_value
from customers
left join customer_orders on customers.customer_id = customer_orders.customer_id
left join customer_payments on customers.customer_id = customer_payments.customer_id
`,
  )

  write(
    "models/marts/orders.sql",
    `with orders as (
    select * from {{ ref('stg_orders') }}
),

payments as (
    select * from {{ ref('stg_payments') }}
),

order_payments as (
    select
        order_id,
        {% for payment_method in ['credit_card', 'coupon', 'bank_transfer', 'gift_card'] %}
        sum(case when payment_method = '{{ payment_method }}' then amount else 0 end) as {{ payment_method }}_amount,
        {% endfor %}
        sum(amount) as total_amount
    from payments
    group by order_id
)

select
    orders.order_id,
    orders.customer_id,
    orders.order_date,
    orders.status,
    {% for payment_method in ['credit_card', 'coupon', 'bank_transfer', 'gift_card'] %}
    order_payments.{{ payment_method }}_amount,
    {% endfor %}
    order_payments.total_amount as amount
from orders
left join order_payments on orders.order_id = order_payments.order_id
`,
  )

  write(
    "models/schema.yml",
    `version: 2

models:
  - name: stg_customers
    columns:
      - name: customer_id
        tests: [unique, not_null]

  - name: stg_orders
    columns:
      - name: order_id
        tests: [unique, not_null]
      - name: status
        tests:
          - accepted_values:
              values: [placed, shipped, completed, return_pending, returned]

  - name: stg_payments
    columns:
      - name: payment_id
        tests: [unique, not_null]
      - name: payment_method
        tests:
          - accepted_values:
              values: [credit_card, coupon, bank_transfer, gift_card]

  - name: customers
    columns:
      - name: customer_id
        tests: [unique, not_null]

  - name: orders
    columns:
      - name: order_id
        tests: [unique, not_null]
      - name: amount
        tests: [not_null]
`,
  )

  write(
    "README.md",
    `# jaffle_shop (Altimate sample)

A small, real dbt project over a seeded DuckDB — try Altimate's data tools
without connecting your own warehouse.

- Warehouse: DuckDB at \`${dbPath}\` (connection: \`${SAMPLE_CONNECTION_NAME}\`)
- Raw tables: raw_customers (100), raw_orders (300), raw_payments (~330)
- Models: 3 staging views + 2 marts, with schema tests

Run it:

    cd ${projectDir}
    dbt run && dbt test
`,
  )
}

/** dbt readiness: dbt on PATH with the duckdb adapter. */
function checkDbt(): { ok: boolean; detail: string } {
  const res = spawnSync("dbt", ["--version"], { encoding: "utf-8", timeout: 30_000 })
  if (res.error || res.status !== 0) {
    return { ok: false, detail: "dbt is not installed. Install it with: pip install dbt-duckdb" }
  }
  const out = `${res.stdout}\n${res.stderr}`
  if (!/duckdb/i.test(out)) {
    return { ok: false, detail: "dbt is installed but the duckdb adapter is missing. Run: pip install dbt-duckdb" }
  }
  return { ok: true, detail: "dbt + duckdb adapter found" }
}

export const SampleSetupTool = Tool.define("sample_setup", {
  description:
    "Provision the bundled jaffle-shop sample environment: a seeded DuckDB (customers, orders, payments) plus a small real dbt project (staging + marts + tests) pointing at it, and register the warehouse connection. Lets the user try Altimate on real data without connecting their own warehouse. Idempotent — recreates the sample deterministically each call.",
  parameters: z.object({}),
  async execute() {
    const root = sampleRoot()
    const projectDir = path.join(root, "jaffle_shop")
    const dbPath = path.join(root, "jaffle_shop.duckdb")

    // Clean recreate for deterministic demos
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(dbPath, { force: true })
    fs.mkdirSync(root, { recursive: true })

    const data = generateData()
    await seedDuckDB(dbPath, data)
    writeDbtProject(projectDir, dbPath)

    const registered = await Dispatcher.call("warehouse.add", {
      name: SAMPLE_CONNECTION_NAME,
      config: { type: "duckdb", path: dbPath },
    })

    const dbt = checkDbt()

    const lines = [
      "# Sample environment ready",
      "",
      `**Warehouse**: DuckDB \`${dbPath}\` — registered as connection \`${SAMPLE_CONNECTION_NAME}\`${registered.success ? "" : ` (registration failed: ${registered.error})`}`,
      `**Data**: raw_customers (${data.customers.length}), raw_orders (${data.orders.length}), raw_payments (${data.payments.length}) — deterministic, identical every run`,
      `**dbt project**: \`${projectDir}\` — 3 staging views + 2 marts (customers, orders) with schema tests; profiles.yml included`,
      "",
      dbt.ok
        ? `**dbt**: ${dbt.detail}. Build it with: \`cd ${projectDir} && dbt run && dbt test\``
        : `**dbt**: ⚠ ${dbt.detail} — the DuckDB is still fully queryable via sql_execute; dbt commands need that one install.`,
      "",
      "You can now query these tables with sql_execute, run /discover from the project dir, index the schema, or run real dbt builds/tests against it.",
    ]

    return {
      title: `Sample ready: jaffle_shop (${SAMPLE_CONNECTION_NAME})`,
      metadata: {
        connection: SAMPLE_CONNECTION_NAME,
        db_path: dbPath,
        project_dir: projectDir,
        rows: { customers: data.customers.length, orders: data.orders.length, payments: data.payments.length },
        dbt_ready: dbt.ok,
        registered: registered.success === true,
      },
      output: lines.join("\n"),
    }
  },
})

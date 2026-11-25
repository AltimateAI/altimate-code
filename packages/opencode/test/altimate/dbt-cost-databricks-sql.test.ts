// The Databricks history SQL, run for real against fixtures: the hour expansion, the proration by overlap, the
// task-time denominator and the price join. SQLite stands in for Spark, with the few Spark functions the query
// uses rewritten (timestamps are integer microseconds, so unix_micros and timestamp_micros are identities).
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { databricksHistorySql, needleFor } from "@/altimate/tools/dbt-cost-history"

const HOUR = 3_600_000_000
/** Read as of a real date; the fixtures sit in the days before it (timestamps are microseconds from the epoch). */
const ASOF_MS = Date.UTC(2026, 4, 10)
/** The epoch hour the fixtures' hour numbers count from: 25 April 2026, 15 days inside the 30-day window. */
const BASE_HOUR = Math.floor(Date.UTC(2026, 3, 25) / 3_600_000)
const NEEDLE = needleFor("model.shop.orders")
const TEXT = `/* {"node_id": "model.shop.orders"} */ merge into t`

/** The index just past the parenthesis that closes the one opened at `open`. */
function closing(sql: string, open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++
    else if (sql[i] === ")" && --depth === 0) return i + 1
  }
  throw new Error("unbalanced")
}

/** The two arguments of a call at `open`, split at the top-level comma. */
function args(sql: string, open: number): [string, string] {
  const end = closing(sql, open)
  const body = sql.slice(open + 1, end - 1)
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++
    else if (body[i] === ")") depth--
    else if (body[i] === "," && depth === 0) return [body.slice(0, i).trim(), body.slice(i + 1).trim()]
  }
  throw new Error("no comma")
}

function toSqlite(spark: string): string {
  let sql = spark
    .replace(/system\.query\.history/g, "query_history")
    .replace(/system\.billing\.usage/g, "billing_usage")
    .replace(/system\.billing\.list_prices/g, "list_prices")
    .replace(/compute\.warehouse_id/g, "compute_warehouse_id")
    .replace(/usage_metadata\.warehouse_id/g, "usage_metadata_warehouse_id")
    .replace(/p\.pricing\.effective_list\.default/g, "p.pricing_effective_list_default")
    .replace(/p\.pricing\.default/g, "p.pricing_default")
    .replace(/ div /g, " / ")
    .replace(/unix_micros\(/g, "(")
    .replace(/timestamp_micros\(/g, "(")
    .replace(/\bleast\(/g, "min(")
    .replace(/\bgreatest\(/g, "max(")
    .replace(/timestamp_millis\((-?\d+)\)/g, (_, ms) => `(${ms} * 1000)`)
  // explode(sequence(a, b)) as hour  ->  a join on the hours a..b
  for (let at = sql.indexOf("explode(sequence("); at !== -1; at = sql.indexOf("explode(sequence(")) {
    const seq = at + "explode(".length + "sequence".length
    const [from, to] = args(sql, seq)
    const call = sql.slice(at, closing(sql, at + "explode".length))
    const afterAs = sql.indexOf(" as hour", at) + " as hour".length
    expect(sql.slice(at + call.length, afterAs)).toBe(" as hour")
    sql = `${sql.slice(0, at)}nums.n as hour${sql.slice(afterAs)}`
    const table = /\bfrom (\w+)/g
    table.lastIndex = at
    const m = table.exec(sql)!
    sql = `${sql.slice(0, m.index)}from ${m[1]} join nums on nums.n between ${from} and ${to}${sql.slice(m.index + m[0].length)}`
  }
  return sql
}

type Stmt = { status?: string; id: string; session?: string; wh?: string; start: number; end: number; ms: number | null; text?: string; type?: string }
type Bill = { wh?: string; hour: number; dbus: number; sku?: string }

function run(stmts: Stmt[], bills: Bill[], prices: { def: number; eff: number | null } | null = { def: 0.7, eff: null }, configuredRate = false) {
  const db = new Database(":memory:")
  db.run("create table nums (n integer)")
  for (let n = BASE_HOUR - 1200; n < BASE_HOUR + 400; n++) db.run("insert into nums values (?)", [n])
  db.run(
    "create table query_history (statement_id text, session_id text, compute_warehouse_id text, start_time integer, end_time integer, statement_type text, total_task_duration_ms integer, execution_status text, statement_text text)",
  )
  for (const s of stmts)
    db.run("insert into query_history values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [s.id, s.session ?? "s", s.wh ?? "w1", s.start, s.end, s.type ?? "MERGE", s.ms, s.status ?? "FINISHED", s.text ?? TEXT])
  db.run("create table billing_usage (usage_metadata_warehouse_id text, usage_start_time integer, usage_quantity real, usage_unit text, sku_name text, cloud text)")
  for (const b of bills) db.run("insert into billing_usage values (?, ?, ?, 'DBU', ?, 'aws')", [b.wh ?? "w1", (BASE_HOUR + b.hour) * HOUR, b.dbus, b.sku ?? "sku"])
  db.run("create table list_prices (sku_name text, cloud text, price_start_time integer, price_end_time integer, pricing_default real, pricing_effective_list_default real)")
  if (prices) db.run("insert into list_prices values ('sku', 'aws', 0, null, ?, ?)", [prices.def, prices.eff])
  const rows = db.query<Record<string, number | string | null>, []>(toSqlite(databricksHistorySql(NEEDLE, ASOF_MS, configuredRate))).all()
  db.close()
  return Object.fromEntries(rows.map((r) => [String(r.statement_id), r]))
}

const at = (hour: number, minutes = 0) => (BASE_HOUR + hour) * HOUR + minutes * 60_000_000

describe("the Databricks history SQL, executed", () => {
  test("a statement across two hours takes each hour's billing in proportion to the time it spent in it", () => {
    // 30 minutes in hour 100 and 30 in hour 101; the task time (60 s) splits evenly. The statement is alone on the warehouse.
    const out = run([{ id: "x", start: at(100, 30), end: at(101, 30), ms: 60_000 }], [
      { hour: 100, dbus: 10 },
      { hour: 101, dbus: 20 },
    ])
    expect(out.x.dbus).toBeCloseTo(30, 9)
    expect(out.x.usd).toBeCloseTo(30 * 0.7, 9)
    expect(out.x.total_task_duration_ms).toBeCloseTo(60_000, 6)
    expect(out.x.missing_hours).toBe(0)
  })

  test("two statements in one hour share its billing by task time, and an unrelated one counts in the denominator", () => {
    // x has 30 ms of 100 ms in the hour (the other statement carries no dbt comment); it gets 30% of the hour.
    const out = run(
      [
        { id: "x", start: at(100, 10), end: at(100, 20), ms: 30 },
        { id: "other", start: at(100, 15), end: at(100, 25), ms: 70, text: "select 1" },
      ],
      [{ hour: 100, dbus: 10 }],
    )
    expect(out.x.dbus).toBeCloseTo(3, 9)
    expect(out.x.usd).toBeCloseTo(3 * 0.7, 9)
    expect(out.other).toBeUndefined()
  })

  test("a null task duration of a neighbour counts as zero in the denominator; the statement's own is unknown", () => {
    const out = run(
      [
        { id: "x", start: at(100, 10), end: at(100, 20), ms: 40 },
        { id: "nullish", start: at(100, 12), end: at(100, 22), ms: null, text: "select 1" },
        { id: "y", start: at(100, 40), end: at(100, 50), ms: null },
      ],
      [{ hour: 100, dbus: 8 }],
    )
    // x: 40 of (40 + 0 + 0) in the hour.
    expect(out.x.dbus).toBeCloseTo(8, 9)
    expect(out.x.missing_hours).toBe(0)
    expect(out.x.null_duration).toBe(0)
    // y has no task duration of its own.
    expect(out.y.null_duration).toBe(1)
    expect(out.y.missing_hours).toBeGreaterThan(0)
  })

  test("an hour with no task time to share by, or with no billing row, makes the statement unknown, for its own reason", () => {
    const out = run(
      [
        { id: "zero", start: at(100, 10), end: at(100, 20), ms: 0 },
        { id: "unbilled", start: at(102, 10), end: at(102, 20), ms: 50 },
      ],
      [{ hour: 100, dbus: 5 }],
    )
    expect(out.zero.zero_weight).toBe(1)
    expect(out.zero.missing_billing).toBe(0)
    expect(out.zero.missing_hours).toBe(1)
    expect(out.unbilled.missing_billing).toBe(1)
    expect(out.unbilled.zero_weight).toBe(0)
    expect(out.unbilled.missing_hours).toBe(1)
  })

  test("a statement with zero length takes its whole task time in its start hour", () => {
    const out = run([{ id: "x", start: at(100, 30), end: at(100, 30), ms: 10 }], [{ hour: 100, dbus: 4 }])
    expect(out.x.dbus).toBeCloseTo(4, 9)
    expect(out.x.missing_hours).toBe(0)
  })

  test("a statement that ends exactly on an hour boundary does not need the next hour's billing", () => {
    const out = run([{ id: "x", start: at(100, 30), end: at(101), ms: 10 }], [{ hour: 100, dbus: 4 }])
    expect(out.x.missing_hours).toBe(0)
    expect(out.x.dbus).toBeCloseTo(4, 9)
  })

  test("the price is the effective list price when there is one, else the list price", () => {
    const stmt = [{ id: "x", start: at(100, 10), end: at(100, 20), ms: 10 }]
    const bill = [{ hour: 100, dbus: 10 }]
    expect(run(stmt, bill, { def: 0.7, eff: 0.5 }).x.usd).toBeCloseTo(5, 9)
    expect(run(stmt, bill, { def: 0.7, eff: null }).x.usd).toBeCloseTo(7, 9)
  })

  test("a statement older than the 30-day window is not read, and neither are its hours", () => {
    const out = run(
      [
        { id: "x", start: at(100, 10), end: at(100, 20), ms: 10 },
        // 40 days before the as-of instant: outside the window.
        { id: "old", start: at(-900, 10), end: at(-900, 20), ms: 10 },
      ],
      [
        { hour: 100, dbus: 10 },
        { hour: -900, dbus: 10 },
      ],
    )
    expect(out.old).toBeUndefined()
    expect(out.x.dbus).toBeCloseTo(10, 9)
  })

  test("with a configured rate, an hour with billed DBUs but no list price is known; without one it is unknown", () => {
    const stmt = [{ id: "x", start: at(100, 10), end: at(100, 20), ms: 10 }]
    const bill = [{ hour: 100, dbus: 10 }]
    // No price row at all: the list-price figure is missing, the DBUs are not.
    const configured = run(stmt, bill, null, true)
    expect(configured.x.missing_hours).toBe(0)
    expect(configured.x.dbus).toBeCloseTo(10, 9)
    const listed = run(stmt, bill, null, false)
    expect(listed.x.missing_hours).toBe(1)
    expect(listed.x.missing_billing).toBe(1)
  })

  test("an hour with some DBUs priced and some not is unknown at list price, and priced in full at a configured rate", () => {
    const stmt = [{ id: "x", start: at(100, 10), end: at(100, 20), ms: 10 }]
    // 10 DBUs of a SKU with a list price, 20 of one without: the priced part alone would be 7 USD.
    const bill = [
      { hour: 100, dbus: 10 },
      { hour: 100, dbus: 20, sku: "unlisted" },
    ]
    const listed = run(stmt, bill, { def: 0.7, eff: null }, false)
    expect(listed.x.missing_hours).toBe(1)
    expect(listed.x.missing_billing).toBe(1)
    const configured = run(stmt, bill, { def: 0.7, eff: null }, true)
    expect(configured.x.missing_hours).toBe(0)
    expect(configured.x.dbus).toBeCloseTo(30, 9)
  })

  test("an hour whose DBUs are all priced is known at list price, whatever other hours do", () => {
    const stmt = [{ id: "x", start: at(100, 10), end: at(100, 20), ms: 10 }]
    // Hour 101 has DBUs of a SKU with no list price, and no statement of the model runs in it.
    const bill = [
      { hour: 100, dbus: 10 },
      { hour: 100, dbus: 5 },
      { hour: 101, dbus: 40, sku: "unlisted" },
    ]
    const out = run(stmt, bill, { def: 0.7, eff: null }, false)
    expect(out.x.missing_hours).toBe(0)
    expect(out.x.usd).toBeCloseTo(15 * 0.7, 9)
  })

  test("an hour with no billed DBUs at all is unknown whichever rate prices it", () => {
    const stmt = [{ id: "x", start: at(100, 10), end: at(100, 20), ms: 10 }]
    expect(run(stmt, [], { def: 0.7, eff: null }, true).x.missing_hours).toBe(1)
  })

  test("statement status and type are compared in upper case, and a failed statement is not read", () => {
    const out = run(
      [
        { id: "lower", start: at(100, 10), end: at(100, 20), ms: 10, status: "finished", type: "merge" },
        { id: "failed", start: at(100, 30), end: at(100, 40), ms: 10, status: "FAILED" },
        { id: "select", start: at(100, 50), end: at(100, 55), ms: 10, type: "SELECT" },
      ],
      [{ hour: 100, dbus: 10 }],
    )
    expect(Object.keys(out)).toEqual(["lower"])
  })

  test("a statement on another warehouse neither shares nor takes the hour", () => {
    const out = run(
      [
        { id: "x", start: at(100, 10), end: at(100, 20), ms: 10 },
        { id: "far", wh: "w2", start: at(100, 10), end: at(100, 20), ms: 990, text: "select 1" },
      ],
      [{ hour: 100, dbus: 10 }],
    )
    expect(out.x.dbus).toBeCloseTo(10, 9)
  })
})

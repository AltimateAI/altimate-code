// The Databricks history SQL, run for real against fixtures: the hour expansion, the proration by overlap, the
// task-time denominator and the price join. SQLite stands in for Spark, with the few Spark functions the query
// uses rewritten (timestamps are integer microseconds, so unix_micros and timestamp_micros are identities).
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { databricksHistorySql, needleFor } from "@/altimate/tools/dbt-cost-history"

const HOUR = 3_600_000_000
/** Read as of a time far after the fixtures (timestamps here are microseconds from the epoch). */
const ASOF_MS = 1_000_000_000
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

type Stmt = { id: string; session?: string; wh?: string; start: number; end: number; ms: number | null; text?: string; type?: string }
type Bill = { wh?: string; hour: number; dbus: number; sku?: string }

function run(stmts: Stmt[], bills: Bill[], prices = { def: 0.7, eff: null as number | null }) {
  const db = new Database(":memory:")
  db.run("create table nums (n integer)")
  for (let n = 0; n < 400; n++) db.run("insert into nums values (?)", [n])
  db.run(
    "create table query_history (statement_id text, session_id text, compute_warehouse_id text, start_time integer, end_time integer, statement_type text, total_task_duration_ms integer, execution_status text, statement_text text)",
  )
  for (const s of stmts)
    db.run("insert into query_history values (?, ?, ?, ?, ?, ?, ?, 'FINISHED', ?)", [s.id, s.session ?? "s", s.wh ?? "w1", s.start, s.end, s.type ?? "MERGE", s.ms, s.text ?? TEXT])
  db.run("create table billing_usage (usage_metadata_warehouse_id text, usage_start_time integer, usage_quantity real, usage_unit text, sku_name text, cloud text)")
  for (const b of bills) db.run("insert into billing_usage values (?, ?, ?, 'DBU', 'sku', 'aws')", [b.wh ?? "w1", b.hour * HOUR, b.dbus])
  db.run("create table list_prices (sku_name text, cloud text, price_start_time integer, price_end_time integer, pricing_default real, pricing_effective_list_default real)")
  db.run("insert into list_prices values ('sku', 'aws', 0, null, ?, ?)", [prices.def, prices.eff])
  const rows = db.query<Record<string, number | string | null>, []>(toSqlite(databricksHistorySql(NEEDLE, ASOF_MS))).all()
  db.close()
  return Object.fromEntries(rows.map((r) => [String(r.statement_id), r]))
}

const at = (hour: number, minutes = 0) => hour * HOUR + minutes * 60_000_000

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

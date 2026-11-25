// The Snowflake rate queries, run for real against fixtures stored the way Snowflake stores them (upper-case
// categories): SQLite stands in for Snowflake, with the few Snowflake functions rewritten.
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { billedRates, sheetRates, snowflakeBilledRateSql, snowflakeRateSql } from "@/altimate/tools/dbt-cost-history"

const ASOF = Date.UTC(2026, 4, 10)

const toSqlite = (sql: string) => sql.replace(/current_account\(\)/g, "'ACCT'").replace(/to_date\(/g, "(")

type Usage = { date: string; type?: string; rating?: string; service?: string; usage: number; amount: number | null; currency?: string; account?: string }
type Rate = { date: string; type: string; rate: number; service?: string; account?: string }

function billed(rows: Usage[]) {
  const db = new Database(":memory:")
  db.run("create table usage_in_currency_daily (account_locator text, usage_date text, rating_type text, service_type text, currency text, usage real, usage_in_currency real)")
  for (const r of rows)
    db.run("insert into usage_in_currency_daily values (?, ?, ?, ?, ?, ?, ?)", [r.account ?? "ACCT", r.date, r.rating ?? "COMPUTE", r.service ?? "WAREHOUSE_METERING", r.currency ?? "USD", r.usage, r.amount])
  const out = db.query<Record<string, string | number | null>, []>(toSqlite(snowflakeBilledRateSql(ASOF)).replace("snowflake.organization_usage.", "")).all()
  db.close()
  return out
}

function contract(rows: Rate[]) {
  const db = new Database(":memory:")
  db.run("create table rate_sheet_daily (account_locator text, date text, usage_type text, service_type text, effective_rate real, currency text)")
  for (const r of rows) db.run("insert into rate_sheet_daily values (?, ?, ?, ?, ?, 'USD')", [r.account ?? "ACCT", r.date, r.type, r.service ?? "WAREHOUSE_METERING", r.rate])
  const out = db.query<Record<string, string | number | null>, []>(toSqlite(snowflakeRateSql(ASOF)).replace("snowflake.organization_usage.", "")).all()
  db.close()
  return out.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)])))
}

describe("the Snowflake billed-rate query, executed", () => {
  test("rows stored as COMPUTE and WAREHOUSE_METERING are read, in any case", () => {
    const out = billed([
      { date: "2026-05-05", usage: 100, amount: 300 },
      { date: "2026-05-06", rating: "compute", service: "warehouse_metering", usage: 10, amount: 40 },
    ])
    expect(out.map((r) => [r.usage_date, r.rate])).toEqual([
      ["2026-05-05", 3],
      ["2026-05-06", 4],
    ])
    expect(billedRates(out.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))))).toHaveLength(2)
  })

  test("other rating types, services and accounts are left out, and so is a date outside the window", () => {
    const out = billed([
      { date: "2026-05-05", rating: "STORAGE", usage: 1, amount: 1 },
      { date: "2026-05-05", service: "SERVERLESS_TASK", usage: 1, amount: 1 },
      { date: "2026-05-05", account: "OTHER", usage: 1, amount: 1 },
      { date: "2026-03-01", usage: 1, amount: 1 },
      { date: "2026-05-11", usage: 1, amount: 1 },
    ])
    expect(out).toEqual([])
  })

  test("contract and overage rows of one day blend into one rate; a row with no amount does not understate it", () => {
    const out = billed([
      { date: "2026-05-05", usage: 100, amount: 200 },
      { date: "2026-05-05", usage: 100, amount: 400 },
      { date: "2026-05-05", usage: 50, amount: null },
    ])
    expect(out[0].rate).toBe(3)
  })
})

describe("the Snowflake contract-rate query, executed", () => {
  test("compute and overage-compute rows stored upper-case are both read", () => {
    const rows = contract([
      { date: "2026-05-05", type: "COMPUTE", rate: 2 },
      { date: "2026-05-05", type: "OVERAGE-COMPUTE", rate: 4 },
      { date: "2026-05-06", type: "OVERAGE-COMPUTE", rate: 5 },
      { date: "2026-05-06", type: "STORAGE", rate: 99 },
      { date: "2026-05-06", type: "COMPUTE", rate: 99, service: "SERVERLESS_TASK" },
    ])
    expect(rows.map((r) => [r.date, r.usage_type])).toEqual([
      ["2026-05-05", "COMPUTE"],
      ["2026-05-05", "OVERAGE-COMPUTE"],
      ["2026-05-06", "OVERAGE-COMPUTE"],
    ])
    // An account that only buys overage still has a rate for the day.
    expect(sheetRates(rows).map((r) => [r.date, r.value, r.kind])).toEqual([
      ["2026-05-05", 2, "compute"],
      ["2026-05-06", 5, "overage-compute"],
    ])
  })
})

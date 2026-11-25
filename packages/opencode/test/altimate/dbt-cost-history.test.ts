// The cost of a model's earlier runs: the history SQL per warehouse, the grouping of statements into runs, and the
// pricing of what each warehouse reports. No adapter or warehouse is involved.
import { describe, expect, test } from "bun:test"
import {
  BQ_MIN_BILLED_BYTES,
  bigqueryCapacitySql,
  bigqueryHistorySql,
  bqProject,
  cleanRates,
  costText,
  databricksHistorySql,
  groupRuns,
  median,
  needleFor,
  onDemandPrice,
  parseRows,
  parseTime,
  priceBigquery,
  priceDatabricks,
  priceSnowflake,
  resolveModel,
  rowsJinja,
  snowflakeHistorySql,
  snowflakeRate,
  sqlString,
  summarize,
  type Row,
  type Stmt,
} from "@/altimate/tools/dbt-cost-history"

const TIB = 1024 ** 4
const MIN = 60_000
const stmt = (startMin: number, endMin: number, cost = 1, known = true): Stmt => ({
  start: startMin * MIN,
  end: endMin * MIN,
  cost,
  native: cost,
  known,
})

describe("needle and SQL escaping", () => {
  test("the needle closes its quote, so one model id is not a prefix of another", () => {
    expect(needleFor("model.a.b")).toBe('"node_id": "model.a.b"')
    expect(needleFor("model.a.b")).not.toContain('"node_id": "model.a.bc')
  })

  test("a quote or a backslash in the needle cannot end the SQL literal", () => {
    expect(sqlString("a'b\\c")).toBe("'a\\'b\\\\c'")
    expect(sqlString("a'; drop table x; --")).toBe("'a\\'; drop table x; --'")
  })
})

describe("history SQL builders", () => {
  const needle = needleFor("model.shop.orders")

  test("BigQuery: project, lowercased region, window, type filter, parent jobs and exact match", () => {
    const sql = bigqueryHistorySql({ project: "my-proj", location: "EU", needle })
    expect(sql).toContain("from `my-proj`.`region-eu`.INFORMATION_SCHEMA.JOBS")
    expect(sql).toContain("interval 30 day")
    expect(sql).toContain("parent_job_id is null")
    expect(sql).toContain("error_result is null")
    expect(sql).toContain("statement_type in ('CREATE_TABLE_AS_SELECT','CREATE_TABLE','CREATE_VIEW','INSERT','MERGE','DELETE','UPDATE','SCRIPT')")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("order by creation_time desc limit 500")
  })

  test("BigQuery: no location falls back to us, and a hostile one cannot leave the quoted name", () => {
    expect(bigqueryHistorySql({ project: "p", needle })).toContain("`region-us`")
    expect(bigqueryHistorySql({ project: "p", location: "eu`; drop", needle })).toContain("`region-eudrop`")
  })

  test("BigQuery: the capacity check looks at a week of query jobs for a reservation", () => {
    const sql = bigqueryCapacitySql({ project: "p", location: "us" })
    expect(sql).toContain("interval 7 day")
    expect(sql).toContain("reservation_id is not null")
    expect(sql).toContain("job_type = 'QUERY'")
  })

  test("BigQuery project ids with anything beyond a name's characters are refused", () => {
    expect(bqProject("my-proj")).toBe("my-proj")
    expect(bqProject("example.com:proj")).toBe("example.com:proj")
    expect(bqProject("p`; drop")).toBeUndefined()
    expect(bqProject(undefined)).toBeUndefined()
  })

  test("Snowflake: window, successful statements of build types, attribution join, exact match", () => {
    const sql = snowflakeHistorySql(needle)
    expect(sql).toContain("dateadd(day, -30, current_timestamp())")
    expect(sql).toContain("q.execution_status = 'SUCCESS'")
    expect(sql).toContain("query_type in ('CREATE_TABLE_AS_SELECT','CREATE_TABLE','CREATE_VIEW','INSERT','MERGE','DELETE','UPDATE','MULTI_STATEMENT')")
    expect(sql).toContain("left join snowflake.account_usage.query_attribution_history a on a.query_id = q.query_id")
    expect(sql).toContain(`contains(q.query_text, '"node_id": "model.shop.orders"')`)
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("limit 500")
  })

  test("Databricks: window, finished build statements on a warehouse, hour split by task time, exact match", () => {
    const sql = databricksHistorySql(needle)
    expect(sql).toContain("interval 30 days")
    expect(sql).toContain("execution_status = 'FINISHED' and compute.warehouse_id is not null")
    expect(sql).toContain("statement_type in ('CREATE','INSERT','MERGE','DELETE','UPDATE','REPLACE','COPY')")
    expect(sql).toContain(`instr(statement_text, '"node_id": "model.shop.orders"') > 0`)
    expect(sql).toContain("q.total_task_duration_ms / nullif(t.task_ms, 0)")
    expect(sql).toContain("pricing.default")
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("limit 500")
  })

  test("a quote in the needle is escaped in every warehouse's SQL", () => {
    const hostile = `"node_id": "model.a.b' or 1=1 --"`
    expect(bigqueryHistorySql({ project: "p", needle: hostile })).toContain("b\\' or 1=1")
    expect(snowflakeHistorySql(hostile)).toContain("b\\' or 1=1")
    expect(databricksHistorySql(hostile)).toContain("b\\' or 1=1")
  })
})

describe("resolveModel", () => {
  const nodes = {
    "model.shop.orders": { resource_type: "model", name: "orders", config: { materialized: "incremental" } },
    "model.shop.dup": { resource_type: "model", name: "dup" },
    "model.other.dup": { resource_type: "model", name: "dup" },
    "model.shop.items.v1": { resource_type: "model", name: "items", version: 1 },
    "model.shop.items.v2": { resource_type: "model", name: "items", version: 2 },
    "seed.shop.orders": { resource_type: "seed", name: "orders" },
  }

  test("a name, a unique_id and a package-qualified name each reach one node", () => {
    expect(resolveModel(nodes, "orders")).toEqual({ uniqueId: "model.shop.orders", materialized: "incremental" })
    expect(resolveModel(nodes, "model.shop.orders")).toMatchObject({ uniqueId: "model.shop.orders" })
    expect(resolveModel(nodes, "shop.orders")).toMatchObject({ uniqueId: "model.shop.orders" })
    expect(resolveModel(nodes, "other.dup")).toMatchObject({ uniqueId: "model.other.dup" })
  })

  test("a versioned name resolves to the version it names, and the bare name is ambiguous", () => {
    expect(resolveModel(nodes, "items.v2")).toMatchObject({ uniqueId: "model.shop.items.v2" })
    expect(resolveModel(nodes, "items")).toEqual({ error: expect.stringContaining("model.shop.items.v1, model.shop.items.v2") })
  })

  test("two packages with one name are ambiguous, and a missing name is an error", () => {
    expect(resolveModel(nodes, "dup")).toEqual({ error: expect.stringContaining("ambiguous") })
    expect(resolveModel(nodes, "nope")).toEqual({ error: expect.stringContaining("no model named nope") })
  })
})

describe("rows from the adapter", () => {
  test("the Jinja runs the query through run_query, escaped, and does nothing at parse time", () => {
    const jinja = rowsJinja("select 'a\\b';")
    expect(jinja).toContain("run_query('select \\'a\\\\b\\'')")
    expect(jinja).toContain("{%- else -%}")
    expect(jinja).toContain("v | string")
  })

  test("a table is read into rows keyed by lower-cased column", () => {
    expect(parseRows('{"columns":["Job_ID","X"],"rows":[["a",null],["b","2"]]}')).toEqual([
      { job_id: "a", x: null },
      { job_id: "b", x: "2" },
    ])
  })

  test("anything else is refused, not read as no rows", () => {
    expect(() => parseRows("compiled(select 1)")).toThrow()
    expect(() => parseRows('{"columns":[]}')).toThrow("no table")
  })

  test("times read as UTC when they name no zone, and keep the zone when they do", () => {
    expect(parseTime("2026-05-02 10:00:00")).toBe(Date.UTC(2026, 4, 2, 10))
    expect(parseTime("2026-05-02 10:00:00+00:00")).toBe(Date.UTC(2026, 4, 2, 10))
    expect(parseTime("2026-05-02 10:00:00.123000-07:00")).toBe(Date.UTC(2026, 4, 2, 17, 0, 0, 123))
    expect(parseTime(null)).toBeNaN()
  })
})

describe("runs", () => {
  test("statements within ten minutes of the last one's end are one run; past ten minutes starts another", () => {
    const { runs } = groupRuns([stmt(0, 1), stmt(11, 12), stmt(23, 24)], "all")
    // 1 -> 11 is exactly ten minutes (same run); 12 -> 23 is eleven (new run).
    expect(runs.map((r) => r.cost)).toEqual([2, 1])
  })

  test("a long statement keeps the run open for statements that start while it still runs", () => {
    const { runs } = groupRuns([stmt(0, 60), stmt(5, 6), stmt(65, 66)], "all")
    expect(runs).toHaveLength(1)
    expect(runs[0].cost).toBe(3)
  })

  test("input order does not matter and a run's cost is the sum of its statements", () => {
    const { runs } = groupRuns([stmt(30, 31, 5), stmt(0, 1, 1), stmt(2, 3, 2)], "all")
    expect(runs).toEqual([
      { start: 0, cost: 3, native: 3 },
      { start: 30 * MIN, cost: 5, native: 5 },
    ])
  })

  test("need all: one unknown statement leaves the run out; need any: only a run with none known", () => {
    const stmts = [stmt(0, 1, 1), stmt(2, 3, 0, false), stmt(60, 61, 4, false)]
    expect(groupRuns(stmts, "all")).toEqual({ runs: [], skipped: 2 })
    const any = groupRuns(stmts, "any")
    expect(any.skipped).toBe(1)
    expect(any.runs.map((r) => r.cost)).toEqual([1])
  })

  test("median is the middle run, or the mean of the middle two", () => {
    expect(median([9, 1, 5])).toBe(5)
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })

  test("last run is the newest one, typical the median, highest the largest", () => {
    const s = summarize([
      { start: 3, cost: 3, native: 30 },
      { start: 9, cost: 1, native: 10 },
      { start: 1, cost: 8, native: 80 },
    ])
    expect(s).toMatchObject({ lastRun: 1, typical: 3, highest: 8, runs: 3, windowDays: 30 })
    expect(s.native).toEqual({ lastRun: 10, typical: 30, highest: 80 })
  })
})

const bq = (id: string, startMin: number, billed: number, reservation: string | null = null, slotMs = 0): Row => ({
  job_id: id,
  creation_time: new Date(startMin * MIN).toISOString(),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  total_bytes_billed: String(billed),
  total_slot_ms: String(slotMs),
  reservation_id: reservation,
})

describe("BigQuery pricing", () => {
  test("on demand: bytes billed over a TiB at the rate", () => {
    const { cost, reserved } = priceBigquery([bq("a", 0, 2 * TIB)], "model.s.m", {})
    expect(reserved).toBe(false)
    expect(cost).toMatchObject({ basis: "history", lastRun: 12.5, native: { unit: "bytes_billed", lastRun: 2 * TIB }, rate: { value: 6.25, source: "default" } })
  })

  test("the configured rate wins and is named config", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB)], "model.s.m", { bigqueryUsdPerTib: 5 })
    expect(cost).toMatchObject({ lastRun: 5, rate: { value: 5, source: "config" } })
    expect(cost.notes.join(" ")).not.toContain("default rate")
  })

  test("a default rate says which key sets it", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB)], "model.s.m", {})
    expect(cost.notes.join(" ")).toContain("cost.bigqueryUsdPerTib")
  })

  test("a reservation job is priced by slot time, not bytes", () => {
    const { cost, reserved } = priceBigquery([bq("a", 0, 100 * TIB, "res", 3_600_000 * 2)], "model.s.m", {})
    expect(reserved).toBe(true)
    expect(cost).toMatchObject({ lastRun: 0.12, native: { unit: "slot_hours", lastRun: 2 }, rate: { value: 0.06, unit: "USD/slot-hour" } })
    expect(cost.notes.join(" ")).toContain("not each job")
  })

  test("a configured slot-hour rate is used", () => {
    const { cost } = priceBigquery([bq("a", 0, 0, "res", 3_600_000)], "model.s.m", { bigquerySlotHourUsd: 0.04 })
    expect(cost).toMatchObject({ lastRun: 0.04, rate: { value: 0.04, source: "config" } })
  })

  test("mixed pricing sums both, keeps no single native unit, and says so", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 100, 0, "res", 3_600_000)], "model.s.m", {})
    expect(cost.native).toBeUndefined()
    expect(cost.highest).toBeCloseTo(6.25)
    expect(cost.notes.join(" ")).toContain("some on demand")
  })

  test("no job is no cost, and the message names the table and the unique_id", () => {
    const { cost } = priceBigquery([], "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("No runs of model.s.m in the last 30 days were found in INFORMATION_SCHEMA.JOBS")
  })

  test("the pre-run price is at least the 10 MiB minimum", () => {
    expect(onDemandPrice(1024, 6.25)).toBeCloseTo((BQ_MIN_BILLED_BYTES / TIB) * 6.25, 12)
    expect(onDemandPrice(0, 6.25)).toBeGreaterThan(0)
    expect(onDemandPrice(TIB, 6.25)).toBe(6.25)
  })
})

const sf = (id: string, startMin: number, compute: string | null, qas: string | null = null, cloud = "0"): Row => ({
  query_id: id,
  start_time: new Date(startMin * MIN).toISOString(),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  credits_attributed_compute: compute,
  credits_used_query_acceleration: qas,
  credits_used_cloud_services: cloud,
})
const rate = { value: 3, unit: "USD/credit", source: "default" as const }

describe("Snowflake pricing", () => {
  test("a statement is its attributed compute plus query acceleration, at the rate", () => {
    const cost = priceSnowflake([sf("a", 0, "0.5", "0.25")], "model.s.m", rate, "USD")
    expect(cost).toMatchObject({ basis: "history", lastRun: 2.25, native: { unit: "credits", lastRun: 0.75 }, rate })
  })

  test("cloud-services credits are reported and not added", () => {
    const cost = priceSnowflake([sf("a", 0, "1", null, "0.4")], "model.s.m", rate, "USD")
    expect(cost.lastRun).toBe(3)
    expect(cost.notes.join(" ")).toContain("Cloud-services credits (0.4")
  })

  test("a statement with no attribution counts zero inside a run that has some", () => {
    const cost = priceSnowflake([sf("a", 0, "1"), sf("b", 2, null)], "model.s.m", rate, "USD")
    expect(cost).toMatchObject({ runs: 1, lastRun: 3 })
  })

  test("a run with no attribution at all is left out and said so", () => {
    const cost = priceSnowflake([sf("a", 0, "1"), sf("b", 100, null)], "model.s.m", rate, "USD")
    expect(cost.runs).toBe(1)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })

  test("every run unattributed is no cost, with the reason", () => {
    const cost = priceSnowflake([sf("a", 0, null)], "model.s.m", rate, "USD")
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("no query attribution yet")
  })

  test("the notes say attribution leaves out idle time", () => {
    expect(priceSnowflake([sf("a", 0, "1")], "model.s.m", rate, "USD").notes.join(" ")).toContain("idle time")
  })

  test("the rate comes from the account's rate sheet with its currency", () => {
    expect(snowflakeRate({ effective_rate: "2.4", currency: "EUR" }, {})).toEqual({
      rate: { value: 2.4, unit: "EUR/credit", source: "account" },
      currency: "EUR",
    })
  })

  test("a configured rate overrides the account's rate sheet", () => {
    expect(snowflakeRate({ effective_rate: "2.4", currency: "EUR" }, { snowflakeUsdPerCredit: 9 })).toEqual({
      rate: { value: 9, unit: "USD/credit", source: "config" },
      currency: "USD",
    })
  })

  test("without a rate sheet it is the configured rate, then the default that names its key", () => {
    expect(snowflakeRate(undefined, { snowflakeUsdPerCredit: 4 }).rate).toEqual({ value: 4, unit: "USD/credit", source: "config" })
    const fallback = snowflakeRate(undefined, {})
    expect(fallback.rate).toEqual({ value: 3, unit: "USD/credit", source: "default" })
    expect(fallback.note).toContain("cost.snowflakeUsdPerCredit")
  })
})

const dbx = (id: string, startMin: number, dbus: string | null, usd: string | null): Row => ({
  statement_id: id,
  start_time: new Date(startMin * MIN).toISOString(),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  dbus,
  usd,
})

describe("Databricks pricing", () => {
  test("a run's cost is the sum of its statements' shares of the billed hour", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "0.55"), dbx("b", 2, "3", "1.65")], "model.s.m", {})
    expect(cost).toMatchObject({ basis: "history", runs: 1, lastRun: 2.2, native: { unit: "dbus", lastRun: 4 } })
    expect(cost.rate).toMatchObject({ source: "list_price", unit: "USD/DBU" })
    expect(cost.rate!.value).toBeCloseTo(0.55, 12)
    expect(cost.notes.join(" ")).toContain("your discount is not applied")
  })

  test("a null usd leaves its whole run out, and says the billing has not landed", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "0.5"), dbx("b", 2, null, null), dbx("c", 100, "2", "1")], "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(1)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })

  test("all runs without billing is no cost", () => {
    const cost = priceDatabricks([dbx("a", 0, null, null)], "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("no billing rows yet")
  })

  test("a configured DBU rate prices the DBUs instead of the list price", () => {
    const cost = priceDatabricks([dbx("a", 0, "10", "99")], "model.s.m", { databricksUsdPerDbu: 0.3 })
    expect(cost).toMatchObject({ lastRun: 3, rate: { value: 0.3, source: "config" } })
    expect(cost.notes.join(" ")).not.toContain("list price")
  })

  test("no statement is no cost and names the SQL-warehouse limit", () => {
    const cost = priceDatabricks([], "model.s.m", {})
    expect(cost.unknownReason).toContain("system.query.history")
    expect(cost.unknownReason).toContain("SQL warehouses only")
  })
})

describe("rates config and the text", () => {
  test("only positive numbers are rates", () => {
    expect(cleanRates({ bigqueryUsdPerTib: 5, bigquerySlotHourUsd: -1, snowflakeUsdPerCredit: "3", databricksUsdPerDbu: 0 })).toEqual({ bigqueryUsdPerTib: 5 })
    expect(cleanRates(undefined)).toEqual({})
  })

  test("the text leads with the cost, or with why there is none", () => {
    const known = costText({ basis: "history", currency: "USD", lastRun: 1.5, typical: 1, highest: 2, runs: 3, windowDays: 30, rate: { value: 6.25, unit: "USD/TiB", source: "config" }, notes: ["a note"] })
    expect(known.split("\n")[0]).toBe("Cost from 3 runs in the last 30 days: last run $1.50, typical $1.00 (median), highest $2.00.")
    expect(known).toContain("Rate: 6.25 USD/TiB (from your config).")
    expect(known).toContain("a note")
    expect(costText({ basis: "none", currency: "USD", rate: null, notes: [], unknownReason: "no history" })).toBe("Cost unknown: no history")
  })
})

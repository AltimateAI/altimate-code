// The cost of a model's earlier runs: the history SQL per warehouse, the grouping of statements into runs, and the
// pricing of what each warehouse reports. No adapter or warehouse is involved.
import { describe, expect, test } from "bun:test"
import {
  BQ_CHILD_LIMIT,
  BQ_MIN_BILLED_BYTES,
  HISTORY_LIMIT,
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
  SNOWFLAKE_RATE_SQL,
  SNOWFLAKE_BILLED_RATE_SQL,
  billedRates,
  type SheetRate,
  snowflakeHistorySql,
  snowflakeRateFor,
  sheetRates,
  countTables,
  bigqueryChildrenSql,
  bigqueryBoundarySql,
  snowflakeBoundarySql,
  databricksBoundarySql,
  sqlString,
  summarize,
  type Row,
  type Stmt,
} from "@/altimate/tools/dbt-cost-history"

const TIB = 1024 ** 4
const MIN = 60_000
const stmt = (startMin: number, endMin: number, cost = 1, known = true, session = "s"): Stmt => ({
  session,
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
    expect(sql).toContain("statement_type in ('CREATE_TABLE_AS_SELECT','CREATE_TABLE','CREATE_VIEW','INSERT','MERGE','SCRIPT','DELETE','UPDATE')")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("order by creation_time desc limit 500")
  })

  test("BigQuery: no location falls back to us, and a hostile one cannot leave the quoted name", () => {
    expect(bigqueryHistorySql({ project: "p", needle })).toContain("`region-us`")
    expect(bigqueryHistorySql({ project: "p", location: "eu`; drop", needle })).toContain("`region-eudrop`")
  })

  test("BigQuery: the capacity check counts a week of query jobs and those in a reservation", () => {
    const sql = bigqueryCapacitySql({ project: "p", location: "us" })
    expect(sql).toContain("interval 7 day")
    expect(sql).toContain("countif(reservation_id is not null) as reserved")
    expect(sql).toContain("count(*) as jobs")
    expect(sql).toContain("job_type = 'QUERY'")
  })

  test("BigQuery: a role that cannot list every user's jobs reads its own from JOBS_BY_USER", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n", view: "JOBS_BY_USER" })).toContain("INFORMATION_SCHEMA.JOBS_BY_USER")
    expect(bigqueryHistorySql({ project: "p", needle: "n" })).toContain("INFORMATION_SCHEMA.JOBS\n")
    expect(bigqueryCapacitySql({ project: "p", view: "JOBS_BY_USER" })).toContain("JOBS_BY_USER")
  })

  test("BigQuery: the children of matched scripts are read by parent id, escaped, in the same window and region", () => {
    const sql = bigqueryChildrenSql({ project: "p", location: "EU", parents: ["job_1", "j'2"] })
    expect(sql).toContain("parent_job_id in ('job_1','j\\'2')")
    expect(sql).toContain("`region-eu`")
    expect(sql).toContain("interval 30 day")
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
    expect(sql).toContain("to_varchar(convert_timezone('UTC', q.start_time), 'YYYY-MM-DD') as start_date_utc")
    expect(sql).toContain("q.session_id")
    expect(sql).toContain("q.execution_time")
    expect(sql).toContain(`contains(q.query_text, '"node_id": "model.shop.orders"')`)
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("limit 500")
  })

  test("Databricks: window, finished build statements on a warehouse, hour split by task time, exact match", () => {
    const sql = databricksHistorySql(needle)
    expect(sql).toContain("interval 30 days")
    expect(sql).toContain("execution_status = 'FINISHED' and compute.warehouse_id is not null")
    // dbt-databricks runs OPTIMIZE and ANALYZE inside the model's materialization, with its query comment.
    expect(sql).toContain("statement_type in ('CREATE','INSERT','MERGE','DELETE','UPDATE','REPLACE','COPY','OPTIMIZE','ANALYZE')")
    expect(sql).toContain(`instr(statement_text, '"node_id": "model.shop.orders"') > 0`)
    expect(sql).toContain("s.share_ms / nullif(t.task_ms, 0)")
    expect(sql).toContain("session_id")
    expect(sql).toContain("coalesce(p.pricing.effective_list.default, p.pricing.default)")
    // A statement is split over the hours it spans, prorated by overlap.
    expect(sql).toContain("explode(sequence(")
    expect(sql).toContain("least(unix_micros(a.end_time), (a.hour + 1) * 3600000000)")
    expect(sql).toContain("missing_hours")
    // Every hour a statement touches needs a billing row and a task-time denominator above zero.
    expect(sql).toContain("count(case when b.usd is null or b.dbus is null or coalesce(t.task_ms, 0) = 0 then 1 end) as missing_hours")
    expect(sql).toContain("left join tasks t on")
    expect(sql).toContain("unix_micros(end_time) - 1")
  })

  test("Databricks: hours are UTC instants from epoch arithmetic, never the session time zone's date_trunc", () => {
    const sql = databricksHistorySql("n")
    expect(sql).not.toMatch(/date_trunc/i)
    expect(sql).toContain("(unix_micros(u.usage_start_time) div 3600000000)")
    expect(sql).toContain("(unix_micros(start_time) div 3600000000)")
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

describe("Snowflake rate sheet query", () => {
  test("reads the rates of the window by date", () => {
    expect(SNOWFLAKE_RATE_SQL).toContain("select date, effective_rate, currency")
    expect(SNOWFLAKE_RATE_SQL).toContain("account_locator = current_account()")
    expect(SNOWFLAKE_RATE_SQL).toContain("dateadd(day, -31, current_date())")
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
    expect(resolveModel(nodes, "orders")).toEqual({ uniqueId: "model.shop.orders", materialized: "incremental", tables: 0, sources: 0 })
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
  test("statements of one session within ten minutes of the last one's end are one run; past ten minutes starts another", () => {
    const { runs } = groupRuns([stmt(0, 1), stmt(11, 12), stmt(23, 24)])
    // 1 -> 11 is exactly ten minutes (same run); 12 -> 23 is eleven (new run).
    expect(runs.map((r) => r.cost)).toEqual([2, 1])
  })

  test("statements of different sessions are never one run, even a minute apart", () => {
    const { runs } = groupRuns([stmt(0, 1, 1, true, "s1"), stmt(2, 3, 1, true, "s2"), stmt(4, 5, 1, true, "s1")])
    expect(runs.map((r) => r.cost).sort((a, b) => a - b)).toEqual([1, 2])
  })

  test("a long statement keeps the run open for statements that start while it still runs", () => {
    const { runs } = groupRuns([stmt(0, 60), stmt(5, 6), stmt(65, 66)])
    expect(runs).toHaveLength(1)
    expect(runs[0].cost).toBe(3)
  })

  test("input order does not matter and a run's cost is the sum of its statements", () => {
    const { runs } = groupRuns([stmt(30, 31, 5), stmt(0, 1, 1), stmt(2, 3, 2)])
    expect(runs).toEqual([
      { start: 0, cost: 3, native: 3, currency: undefined },
      { start: 30 * MIN, cost: 5, native: 5, currency: undefined },
    ])
  })

  test("one unknown statement leaves its whole run out", () => {
    const { runs, skipped } = groupRuns([stmt(0, 1, 1), stmt(2, 3, 0, false), stmt(60, 61, 4)])
    expect(skipped).toBe(1)
    expect(runs.map((r) => r.cost)).toEqual([4])
  })

  test("a run priced in two currencies is unknown", () => {
    const a = { ...stmt(0, 1), currency: "USD" }
    const b = { ...stmt(2, 3), currency: "EUR" }
    expect(groupRuns([a, b])).toEqual({ runs: [], skipped: 1, dropped: 0 })
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

const bq = (
  id: string,
  startMin: number,
  billed: number | null,
  reservation: string | null = null,
  slotMs = 0,
  type = "MERGE",
  extra: Row = {},
): Row => ({
  job_id: id,
  creation_time: new Date(startMin * MIN).toISOString(),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  statement_type: type,
  total_bytes_billed: billed === null ? null : String(billed),
  total_slot_ms: String(slotMs),
  reservation_id: reservation,
  cache_hit: "False",
  user_email: "a@x.com",
  destination_table_id: null,
  ...extra,
})

describe("BigQuery pricing", () => {
  test("on demand: bytes billed over a TiB at the rate", () => {
    const { cost, reserved } = priceBigquery([bq("a", 0, 2 * TIB)], undefined, "model.s.m", {})
    expect(reserved).toBe(false)
    expect(cost).toMatchObject({ basis: "history", lastRun: 12.5, native: { unit: "bytes_billed", lastRun: 2 * TIB }, rate: { value: 6.25, source: "default" } })
  })

  test("the configured rate wins and is named config", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB)], undefined, "model.s.m", { bigqueryUsdPerTib: 5 })
    expect(cost).toMatchObject({ lastRun: 5, rate: { value: 5, source: "config" } })
    expect(cost.notes.join(" ")).not.toContain("default rate")
  })

  test("a default rate says which key sets it", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB)], undefined, "model.s.m", {})
    expect(cost.notes.join(" ")).toContain("cost.bigqueryUsdPerTib")
  })

  test("a reservation job is priced by slot time, not bytes", () => {
    const { cost, reserved } = priceBigquery([bq("a", 0, 100 * TIB, "res", 3_600_000 * 2)], undefined, "model.s.m", {})
    expect(reserved).toBe(true)
    expect(cost).toMatchObject({ lastRun: 0.12, native: { unit: "slot_hours", lastRun: 2 }, rate: { value: 0.06, unit: "USD/slot-hour" } })
    expect(cost.notes.join(" ")).toContain("not each job")
  })

  test("a configured slot-hour rate is used", () => {
    const { cost } = priceBigquery([bq("a", 0, 0, "res", 3_600_000)], undefined, "model.s.m", { bigquerySlotHourUsd: 0.04 })
    expect(cost).toMatchObject({ lastRun: 0.04, rate: { value: 0.04, source: "config" } })
  })

  test("mixed pricing sums both, keeps no single native unit, and says so", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 100, 0, "res", 3_600_000)], undefined, "model.s.m", {})
    expect(cost.native).toBeUndefined()
    expect(cost.highest).toBeCloseTo(6.25)
    expect(cost.notes.join(" ")).toContain("some on demand")
  })

  test("no job is no cost, and the message names the table and the unique_id", () => {
    const { cost } = priceBigquery([], undefined, "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("No runs of model.s.m in the last 30 days were found in INFORMATION_SCHEMA.JOBS")
  })

  test("a script is priced from its children, each by its own reservation, and the parent is not added", () => {
    const parent = bq("p", 0, 50 * TIB, null, 0, "SCRIPT")
    const children: Row[] = [
      { job_id: "c1", parent_job_id: "p", statement_type: "CREATE_TABLE_AS_SELECT", total_bytes_billed: String(TIB), total_slot_ms: "0", reservation_id: null, cache_hit: "False" },
      { job_id: "c2", parent_job_id: "p", statement_type: "MERGE", total_bytes_billed: "0", total_slot_ms: String(3_600_000), reservation_id: "res", cache_hit: "False" },
      { job_id: "x", parent_job_id: "other", statement_type: "MERGE", total_bytes_billed: String(9 * TIB), total_slot_ms: "0", reservation_id: null, cache_hit: "False" },
    ]
    const { cost, reserved } = priceBigquery([parent], children, "model.s.m", {})
    expect(reserved).toBe(true)
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(6.25 + 0.06, 10)
  })

  test("a script whose children were not found is left out, not priced from its own row", () => {
    const { cost } = priceBigquery([bq("p", 0, 50 * TIB, null, 0, "SCRIPT")], [], "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })

  test("an on-demand job with no bytes billed is unknown and its run is left out, never a zero", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 100, null)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6.25)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })

  test("a cached job with zero bytes billed is a real zero", () => {
    const { cost } = priceBigquery([bq("a", 0, 0, null, 0, "MERGE", { cache_hit: "True" })], undefined, "model.s.m", {})
    expect(cost).toMatchObject({ basis: "history", runs: 1, lastRun: 0 })
  })

  test("each build job is its own run, even a minute apart", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 1, TIB), bq("c", 2, TIB)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(3)
  })

  test("a delete joins the build job that starts within a minute after it, else is a run of its own", () => {
    const attached = priceBigquery([bq("d", 0, TIB, null, 0, "DELETE"), { ...bq("m", 0, TIB), creation_time: new Date(MIN / 2).toISOString() }], undefined, "model.s.m", {})
    expect(attached.cost.runs).toBe(1)
    expect(attached.cost.lastRun).toBe(12.5)
    const apart = priceBigquery([bq("d", 0, TIB, null, 0, "UPDATE"), bq("m", 5, TIB)], undefined, "model.s.m", {})
    expect(apart.cost.runs).toBe(2)
  })
})

describe("BigQuery pre-run price", () => {
  const tenMiB = BQ_MIN_BILLED_BYTES
  const rate = 6.25

  test("the charge is at least n x 10 MiB and at most the dry run's upper bound plus n x 10 MiB", () => {
    const price = onDemandPrice({ maxBytes: 2048, tables: 3, usdPerTib: rate })
    expect(price.low).toBeCloseTo((3 * tenMiB * rate) / TIB, 14)
    expect(price.high).toBeCloseTo(((2048 + 3 * tenMiB) * rate) / TIB, 14)
  })

  test("the ceiling follows maxBytes, so a rounded display cannot sit above it", () => {
    const price = onDemandPrice({ maxBytes: Math.ceil(1.05 * TIB), tables: 1, usdPerTib: rate })
    expect(price.high).toBeGreaterThan(((TIB + tenMiB) * rate) / TIB)
  })

  test("no tables counts as one, so the 10 MiB minimum still applies", () => {
    expect(onDemandPrice({ maxBytes: 0, tables: 0, usdPerTib: rate }).low).toBeGreaterThan(0)
  })
})

describe("tables a model reads", () => {
  const nodes = {
    "model.s.m": { resource_type: "model", config: {}, depends_on: { nodes: ["model.s.a", "model.s.eph", "source.s.raw", "seed.s.x", "model.s.a", "model.s.v"] } },
    "model.s.a": { resource_type: "model", config: { materialized: "table" } },
    "model.s.eph": { resource_type: "model", config: { materialized: "ephemeral" }, depends_on: { nodes: ["model.s.b", "model.s.a"] } },
    "model.s.b": { resource_type: "model", config: { materialized: "incremental" } },
    "model.s.v": { resource_type: "model", config: { materialized: "view" }, depends_on: { nodes: ["model.s.c", "source.s.raw2"] } },
    "model.s.c": { resource_type: "model", config: { materialized: "table" } },
    "seed.s.x": { resource_type: "seed" },
  }
  test("physical relations only: a view or an ephemeral model is what it reads, a source is one", () => {
    // a, b (through the ephemeral), c (through the view), seed x, source raw, source raw2.
    expect(countTables(nodes, { "source.s.raw": {}, "source.s.raw2": {} }, "model.s.m")).toEqual({ tables: 6, sources: 2 })
  })
  test("a view is not counted as a table of its own", () => {
    const only = { "model.s.m": { resource_type: "model", depends_on: { nodes: ["model.s.v"] } }, "model.s.v": { resource_type: "model", config: { materialized: "view" }, depends_on: { nodes: [] } } }
    expect(countTables(only, {}, "model.s.m").tables).toBe(0)
  })
})

const sf = (
  id: string,
  startMin: number,
  compute: string | null,
  qas: string | null = null,
  cloud = "0",
  extra: Row = {},
): Row => ({
  query_id: id,
  session_id: "sess",
  start_time: new Date(startMin * MIN).toISOString(),
  start_date_utc: new Date(startMin * MIN).toISOString().slice(0, 10),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  execution_time: "5000",
  credits_attributed_compute: compute,
  credits_used_query_acceleration: qas,
  credits_used_cloud_services: cloud,
  ...extra,
})

describe("Snowflake pricing", () => {
  test("a statement is its attributed compute plus query acceleration, at the rate", () => {
    const cost = priceSnowflake([sf("a", 0, "0.5", "0.25")], "model.s.m", [], {})
    expect(cost).toMatchObject({ basis: "history", lastRun: 2.25, native: { unit: "credits", lastRun: 0.75 }, rate: { value: 3, source: "default" } })
  })

  test("cloud-services credits are reported and not added", () => {
    const cost = priceSnowflake([sf("a", 0, "1", null, "0.4")], "model.s.m", [], {})
    expect(cost.lastRun).toBe(3)
    expect(cost.notes.join(" ")).toContain("Cloud-services credits (0.4")
  })

  test("a null attribution on a statement under 100 ms is a zero: Snowflake never attributes those", () => {
    const cost = priceSnowflake([sf("a", 0, "1"), sf("b", 2, null, null, "0", { execution_time: "40" })], "model.s.m", [], {})
    expect(cost).toMatchObject({ runs: 1, lastRun: 3 })
  })

  test("a null attribution on a longer statement makes its whole run pending: the run is left out and counted", () => {
    const cost = priceSnowflake([sf("a", 0, "1"), sf("b", 2, null), sf("c", 100, "2", null, "0", { session_id: "other" })], "model.s.m", [], {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6)
    expect(cost.notes.join(" ")).toContain("1 run left out: pending attribution")
  })

  test("every run pending is no cost, with the reason", () => {
    const cost = priceSnowflake([sf("a", 0, null)], "model.s.m", [], {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("cannot be priced yet")
  })

  test("statements of different sessions are separate runs", () => {
    const cost = priceSnowflake([sf("a", 0, "1"), sf("b", 2, "1", null, "0", { session_id: "other" })], "model.s.m", [], {})
    expect(cost.runs).toBe(2)
  })

  test("the notes say attribution leaves out idle time", () => {
    expect(priceSnowflake([sf("a", 0, "1")], "model.s.m", [], {}).notes.join(" ")).toContain("idle time")
  })

  test("each statement is priced at the rate of its own day, with its currency", () => {
    const sheet = [
      { date: "1970-01-01", value: 2, currency: "EUR" },
      { date: "1970-01-02", value: 4, currency: "EUR" },
    ]
    const day1 = sf("a", 0, "1")
    const day2 = sf("b", 24 * 60, "1", null, "0", { session_id: "other" })
    const cost = priceSnowflake([day1, day2], "model.s.m", sheet, {})
    expect(cost.currency).toBe("EUR")
    expect(cost.lastRun).toBe(4)
    expect(cost.highest).toBe(4)
    expect(cost.typical).toBe(3)
    expect(cost.rate).toEqual({ value: 4, unit: "EUR/credit", source: "account", detail: "contract" })
    expect(cost.notes.join(" ")).toContain("Contract rate; overage not reflected.")
  })

  test("the day is the statement's UTC date, never a slice of a local timestamp", () => {
    // 23:30 at UTC-8 on the 1st is the 2nd in UTC: its rate is the 2nd's.
    const sheet = [
      { date: "2026-05-01", value: 2, currency: "USD" },
      { date: "2026-05-02", value: 5, currency: "USD" },
    ]
    const local = { ...sf("a", 0, "1"), start_time: "2026-05-01 23:30:00.000-08:00", start_date_utc: "2026-05-02" }
    expect(priceSnowflake([local], "model.s.m", sheet, {}).lastRun).toBe(5)
    expect(priceSnowflake([{ ...local, start_date_utc: null }], "model.s.m", sheet, {}).rate?.source).toBe("default")
  })

  test("a day with no rate row uses the nearest earlier day's, and one before every row uses the default", () => {
    const sheet = [{ date: "1970-01-02", value: 4, currency: "USD" }]
    expect(snowflakeRateFor("1970-01-05", sheet, {}).rate.value).toBe(4)
    expect(snowflakeRateFor("1970-01-01", sheet, {}).rate).toEqual({ value: 3, unit: "USD/credit", source: "default" })
  })

  test("a configured rate overrides every rate sheet row", () => {
    const sheet = [{ date: "1970-01-01", value: 2.4, currency: "EUR" }]
    expect(snowflakeRateFor("1970-01-01", sheet, { snowflakeUsdPerCredit: 9 })).toEqual({
      rate: { value: 9, unit: "USD/credit", source: "config" },
      currency: "USD",
    })
  })

  test("without a rate sheet it is the default, and the note names its key", () => {
    const fallback = snowflakeRateFor("1970-01-01", [], {})
    expect(fallback.rate).toEqual({ value: 3, unit: "USD/credit", source: "default" })
    expect(fallback.note).toContain("cost.snowflakeUsdPerCredit")
  })

  const billed = (date: string, value: number, extra: Partial<SheetRate> = {}): SheetRate => ({ date, value, currency: "USD", detail: "billed", ...extra })

  test("a day's billed rate is the blended contract and overage rate, so a statement costs what its day was billed", () => {
    // Day 1 had overage: 100 credits at 2 and 100 at 4 is a blended 3 per credit.
    const rows: Row[] = [{ usage_date: "1970-01-01", rate: "3", currency: "USD", currencies: "1" }]
    expect(billedRates(rows)).toEqual([billed("1970-01-01", 3, { mixed: false })])
    const cost = priceSnowflake([sf("a", 0, "10")], "model.s.m", billedRates(rows), {})
    expect(cost.lastRun).toBe(30)
    expect(cost.rate).toEqual({ value: 3, unit: "USD/credit", source: "account", detail: "billed" })
    expect(cost.notes.join(" ")).not.toContain("Contract rate")
  })

  test("a day billed in more than one currency leaves its statements unknown", () => {
    // Two currencies on one day: the view's blended figure is a sum across currencies, so the day is mixed.
    const sheet = billedRates([{ usage_date: "1970-01-01", rate: "3", currency: "USD", currencies: "2" }])
    expect(sheet[0]).toMatchObject({ mixed: true })
    const cost = priceSnowflake([sf("a", 0, "10")], "model.s.m", sheet, {})
    expect(cost.basis).toBe("none")
  })

  test("the headline rate and currency are the newest priced run's, not a pending or mixed-day statement's", () => {
    const sheet = [billed("1970-01-01", 3), { ...billed("1970-01-03", 9, { mixed: true }), currency: "EUR" }]
    const rows = [sf("done", 0, "10"), sf("pending", 2 * 24 * 60, null, null, "0", { session_id: "p", execution_time: "9000" })]
    const cost = priceSnowflake(rows, "model.s.m", sheet, {})
    expect(cost.currency).toBe("USD")
    expect(cost.rate).toEqual({ value: 3, unit: "USD/credit", source: "account", detail: "billed" })
    expect(cost.lastRun).toBe(30)
    expect(cost.basis).toBe("history")
  })

  test("a newer pending statement on a single-rate day in another currency does not set the headline", () => {
    const sheet = [billed("1970-01-01", 3), { ...billed("1970-01-03", 4), currency: "EUR" }]
    const rows = [sf("done", 0, "10"), sf("pending", 2 * 24 * 60, null, null, "0", { session_id: "p", execution_time: "9000", start_date_utc: "1970-01-03" })]
    const cost = priceSnowflake(rows, "model.s.m", sheet, {})
    expect(cost.currency).toBe("USD")
    expect(cost.rate).toMatchObject({ value: 3, unit: "USD/credit" })
    expect(cost.lastRun).toBe(30)
  })

  test("a mixed-currency day's blended rate is never shown as the rate", () => {
    const sheet = [billed("1970-01-01", 9, { mixed: true })]
    const cost = priceSnowflake([sf("a", 0, "10")], "model.s.m", sheet, {})
    expect(cost.basis).toBe("none")
    expect(cost.rate).toBeNull()
  })

  test("a statement newer than the last billed day uses the latest billed rate and says so", () => {
    const sheet = [billed("1970-01-01", 3), billed("1970-01-02", 5)]
    const cost = priceSnowflake([sf("a", 4 * 24 * 60, "1")], "model.s.m", sheet, {})
    expect(cost.lastRun).toBe(5)
    expect(cost.notes.join(" ")).toContain("Recent runs priced at the latest billed rate (1970-01-02)")
    const inside = priceSnowflake([sf("a", 0, "1")], "model.s.m", sheet, {})
    expect(inside.notes.join(" ")).not.toContain("Recent runs priced")
  })

  test("the billed rate query reads the blended compute and overage usage by day", () => {
    expect(SNOWFLAKE_BILLED_RATE_SQL).toContain("sum(usage_in_currency) / nullif(sum(usage), 0) as rate")
    expect(SNOWFLAKE_BILLED_RATE_SQL).toContain("snowflake.organization_usage.usage_in_currency_daily")
    // The documented columns, with every balance source (contract and overage) kept.
    expect(SNOWFLAKE_BILLED_RATE_SQL).toContain("rating_type = 'compute' and service_type = 'WAREHOUSE_METERING'")
    expect(SNOWFLAKE_BILLED_RATE_SQL).not.toContain("usage_type")
    expect(SNOWFLAKE_BILLED_RATE_SQL).not.toContain("balance_source")
    expect(SNOWFLAKE_BILLED_RATE_SQL).toContain("count(distinct currency) as currencies")
    expect(SNOWFLAKE_BILLED_RATE_SQL).toContain("group by usage_date")
  })

  test("rate sheet rows are read by date, positive rates only", () => {
    expect(sheetRates([{ date: "2026-05-02 00:00:00", effective_rate: "2.5", currency: "EUR" }, { date: "2026-05-01", effective_rate: "0", currency: "EUR" }])).toEqual([
      { date: "2026-05-02", value: 2.5, currency: "EUR", detail: "contract" },
    ])
  })
})

const dbx = (id: string, startMin: number, dbus: string | null, usd: string | null, extra: Row = {}): Row => ({
  statement_id: id,
  session_id: "sess",
  start_time: new Date(startMin * MIN).toISOString(),
  end_time: new Date((startMin + 1) * MIN).toISOString(),
  dbus,
  usd,
  missing_hours: usd === null ? "1" : "0",
  ...extra,
})

describe("Databricks pricing", () => {
  test("a run's cost is the sum of its statements' shares of the billed hours", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "0.55"), dbx("b", 2, "3", "1.65")], "model.s.m", {})
    expect(cost).toMatchObject({ basis: "history", runs: 1, lastRun: 2.2, native: { unit: "dbus", lastRun: 4 } })
    expect(cost.rate).toMatchObject({ source: "list_price", unit: "USD/DBU" })
    expect(cost.rate!.value).toBeCloseTo(0.55, 12)
    expect(cost.notes.join(" ")).toContain("negotiated discounts are not applied")
  })

  test("a statement with a billed hour missing leaves its whole run out, and says the billing has not landed", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "0.5"), dbx("b", 2, null, null), dbx("c", 100, "2", "1")], "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(1)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })

  test("a statement is known only when its SQL counted no hour without billing or denominator, whatever dbus came back", () => {
    expect(priceDatabricks([dbx("a", 0, "1", "0.5", { missing_hours: "2" })], "model.s.m", {}).basis).toBe("none")
    expect(priceDatabricks([dbx("a", 0, "1", "0.5", { missing_hours: "0" })], "model.s.m", {}).basis).toBe("history")
    // A zero-task statement in a billed hour: the SQL returns numeric zeros and no missing hour, and it costs 0.
    expect(priceDatabricks([dbx("a", 0, "0", "0", { missing_hours: "0" })], "model.s.m", {})).toMatchObject({ basis: "history", lastRun: 0 })
  })

  test("a partly billed statement (one of its hours missing) is unknown even though some cost came back", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "0.5", { missing_hours: "1" })], "model.s.m", {})
    expect(cost.basis).toBe("none")
  })

  test("all runs without billing is no cost", () => {
    const cost = priceDatabricks([dbx("a", 0, null, null)], "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("no billing rows yet")
  })

  test("statements of different sessions are separate runs", () => {
    const cost = priceDatabricks([dbx("a", 0, "1", "1"), dbx("b", 2, "1", "1", { session_id: "other" })], "model.s.m", {})
    expect(cost.runs).toBe(2)
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

  test("a dry-run price is worded as a ceiling with a floor", () => {
    const text = costText({ basis: "dry_run", currency: "USD", rate: null, notes: [], selectOnly: { low: 1, high: 2 } })
    expect(text).toBe(
      "The SELECT would bill at most $2.00 on-demand (at least $1.00; pruning of clustered or partitioned tables can bill less than the dry run).",
    )
  })
})

describe("run boundary", () => {
  const C = 1_000 * MIN
  const at = (min: number) => new Date(C + min * MIN).toISOString()
  const boundary = (...stmts: { session: string | null; start: number; end: number; tmp?: boolean }[]) => ({ cutoff: C, stmts })
  const before = (session: string, startMin: number, endMin: number) => ({ session, start: C + startMin * MIN, end: C + endMin * MIN })

  test("Snowflake: a CTAS before the window and its MERGE after it (fewer than 500 rows) is a run of unknown start, and is left out", () => {
    const rows = [
      sf("merge", 0, "1", null, "0", { session_id: "a", start_time: at(5), end_time: at(6), start_date_utc: "2026-05-02" }),
      sf("other", 0, "2", null, "0", { session_id: "b", start_time: at(300), end_time: at(301) }),
    ]
    // The CTAS began 40 minutes before the window and ended 2 minutes into it: within the gap of the MERGE's start.
    const cost = priceSnowflake(rows, "model.s.m", [], {}, boundary(before("a", -40, 2)))
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("a long CTAS in one session truncates the result for another: the run it ends beside is dropped, the rest kept", () => {
    // 500 rows were returned, the oldest at the cutoff; session x's CTAS began before it and ended 25 minutes after.
    const filler = Array.from({ length: HISTORY_LIMIT - 2 }, (_, i) => sf(`f${i}`, 0, "1", null, "0", { session_id: `f${i}`, start_time: at(500 + i * 120), end_time: at(501 + i * 120) }))
    const rows = [
      sf("oldest", 0, "1", null, "0", { session_id: "o", start_time: at(0), end_time: at(1) }),
      sf("merge", 0, "1", null, "0", { session_id: "x", start_time: at(30), end_time: at(31) }),
      ...filler,
    ]
    const cost = priceSnowflake(rows, "model.s.m", [], {}, boundary(before("x", -60, 25)))
    expect(cost.runs).toBe(HISTORY_LIMIT - 1)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    expect(cost.notes.join(" ")).toContain("Only the newest 500 statements were read")
  })

  test("a boundary statement of another session, or one that ended long before the run, drops nothing", () => {
    const rows = [sf("m", 0, "1", null, "0", { session_id: "a", start_time: at(30), end_time: at(31) })]
    expect(priceSnowflake(rows, "model.s.m", [], {}, boundary(before("b", -5, 25))).runs).toBe(1)
    expect(priceSnowflake(rows, "model.s.m", [], {}, boundary(before("a", -5, 5))).runs).toBe(1)
    expect(priceSnowflake(rows, "model.s.m", [], {}, boundary(before("a", -5, 25))).basis).toBe("none")
  })

  test("a boundary that could not be read drops runs starting within a day of the cutoff and keeps later ones", () => {
    const rows = [
      sf("near", 0, "1", null, "0", { session_id: "a", start_time: at(60), end_time: at(61) }),
      sf("far", 0, "2", null, "0", { session_id: "b", start_time: at(3 * 24 * 60), end_time: at(3 * 24 * 60 + 1) }),
    ]
    const cost = priceSnowflake(rows, "model.s.m", [], {}, { cutoff: C })
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("without a boundary nothing is dropped, and a full result says only 500 statements were read", () => {
    const rows = Array.from({ length: HISTORY_LIMIT }, (_, i) => sf(`q${i}`, i * 120, "1", null, "0", { session_id: `s${i}` }))
    const cost = priceSnowflake(rows, "model.s.m", [], {})
    expect(cost.runs).toBe(HISTORY_LIMIT)
    expect(cost.notes.join(" ")).toContain("Only the newest 500 statements were read")
  })

  test("Databricks: the same boundary rule", () => {
    const rows = [
      dbx("m", 0, "1", "1", { session_id: "a", start_time: at(5), end_time: at(6) }),
      dbx("o", 0, "1", "1", { session_id: "b", start_time: at(400), end_time: at(401) }),
    ]
    const cost = priceDatabricks(rows, "model.s.m", {}, boundary(before("a", -30, 0)))
    expect(cost.runs).toBe(1)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("BigQuery: an unread delete by the same user that started within a minute before a build may belong to it; others do not", () => {
    const rows = [
      { ...bq("near", 0, TIB), creation_time: at(0.5) },
      { ...bq("far", 0, TIB), creation_time: at(120) },
    ]
    const price = (b: { session: string | null; start: number; end: number }) => priceBigquery(rows, undefined, "model.s.m", {}, boundary(b)).cost
    const own = price({ session: "a@x.com", start: C - 0.2 * MIN, end: Number.NaN })
    expect(own.runs).toBe(1)
    expect(own.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Another user's delete, or one more than a minute before the build, cannot have attached to it.
    expect(price({ session: "someone@else.com", start: C - 0.2 * MIN, end: Number.NaN }).runs).toBe(2)
    expect(price({ session: "a@x.com", start: C - 5 * MIN, end: Number.NaN }).runs).toBe(2)
  })

  test("BigQuery: a delete pre-hook and the insert_overwrite script 20 s later by the same user are one run, priced from the script's children", () => {
    const rows = [
      bq("d", 0, TIB, null, 0, "DELETE"),
      { ...bq("s", 0, 9 * TIB, null, 0, "SCRIPT"), creation_time: new Date(20_000).toISOString() },
    ]
    const children: Row[] = [
      { job_id: "k", parent_job_id: "s", creation_time: new Date(21_000).toISOString(), statement_type: "INSERT", total_bytes_billed: String(2 * TIB), total_slot_ms: "0", reservation_id: null, cache_hit: "False" },
    ]
    const { cost } = priceBigquery(rows, children, "model.s.m", {})
    // The script row has the user; its children have none. Without it the delete would be a run of its own.
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(18.75, 10)
  })

  const tmpCtas = (id: string, startMin: number, billed: number, user = "a@x.com", dest = "orders__dbt_tmp"): Row =>
    bq(id, startMin, billed, null, 0, "CREATE_TABLE_AS_SELECT", { user_email: user, destination_table_id: dest })

  test("BigQuery: the CTAS into the temporary relation and the MERGE that follows it are one run", () => {
    // The CTAS runs a minute (minute 0 to 1); the MERGE starts at minute 3, within ten minutes of its end.
    const rows = [tmpCtas("t", 0, TIB), bq("m", 3, 2 * TIB)]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(18.75, 10)
  })

  test("BigQuery: a temporary-relation CTAS joins only a final build by the same user within ten minutes after it ends", () => {
    expect(priceBigquery([tmpCtas("t", 0, TIB), bq("m", 3, TIB, null, 0, "MERGE", { user_email: "b@x.com" })], undefined, "model.s.m", {}).cost.runs).toBe(2)
    expect(priceBigquery([tmpCtas("t", 0, TIB), bq("m", 12, TIB)], undefined, "model.s.m", {}).cost.runs).toBe(2)
    // A CTAS into an ordinary table is a build of its own, not a temporary relation.
    expect(priceBigquery([tmpCtas("t", 0, TIB, "a@x.com", "orders"), bq("m", 3, TIB)], undefined, "model.s.m", {}).cost.runs).toBe(2)
  })

  test("BigQuery: delete, temporary CTAS and merge are one run, even when the merge starts over a minute after the delete", () => {
    const rows = [bq("d", 0, TIB, null, 0, "DELETE"), { ...tmpCtas("t", 0, TIB), creation_time: new Date(30_000).toISOString(), end_time: new Date(5 * MIN).toISOString() }, bq("m", 6, TIB)]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(18.75, 10)
  })

  test("BigQuery: a merge whose temporary CTAS ended just before the cutoff may be the end of a run that began unread, so it is dropped", () => {
    const rows = [{ ...bq("m", 0, TIB), creation_time: at(2) }]
    const stmt = (end: number, session = "a@x.com") => ({ session, start: C - 5 * MIN, end: C + end * MIN, tmp: true })
    const cost = (b: ReturnType<typeof stmt>) => priceBigquery(rows, undefined, "model.s.m", {}, boundary(b)).cost
    expect(cost(stmt(0)).notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Another user's CTAS, or one that ended over ten minutes before the merge, cannot have fed it.
    expect(cost(stmt(0, "b@x.com")).runs).toBe(1)
    expect(priceBigquery(rows, undefined, "model.s.m", {}, boundary({ session: "a@x.com", start: C - 30 * MIN, end: C - 20 * MIN, tmp: true })).cost.runs).toBe(1)
  })

  test("BigQuery: a merge that has its temporary CTAS in the result is not dropped for an unread one", () => {
    const rows = [{ ...tmpCtas("t", 0, TIB), creation_time: at(0), end_time: at(1) }, { ...bq("m", 0, TIB), creation_time: at(2) }]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, boundary({ session: "a@x.com", start: C - 5 * MIN, end: C + 0, tmp: true }))
    expect(cost.runs).toBe(1)
  })

  test("BigQuery: a delete joins only a build by the same user", () => {
    const rows = [
      bq("d", 0, TIB, null, 0, "DELETE", { user_email: "a@x.com" }),
      { ...bq("m", 0, TIB, null, 0, "MERGE", { user_email: "b@x.com" }), creation_time: new Date(20_000).toISOString() },
    ]
    expect(priceBigquery(rows, undefined, "model.s.m", {}).cost.runs).toBe(2)
    const same = [{ ...rows[0], user_email: "b@x.com" }, rows[1]]
    expect(priceBigquery(same, undefined, "model.s.m", {}).cost.runs).toBe(1)
  })

  test("BigQuery: when the boundary alone leaves no run, the message says so rather than blaming bytes billed", () => {
    const rows = [{ ...bq("near", 0, TIB), creation_time: at(0.5) }]
    const cost = priceBigquery(rows, undefined, "model.s.m", {}, boundary({ session: "a@x.com", start: C - 0.2 * MIN, end: Number.NaN })).cost
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("may have started before the period read")
    expect(cost.unknownReason).not.toContain("no bytes billed")
  })
})

describe("boundary SQL", () => {
  const needle = needleFor("model.shop.orders")

  test("Snowflake: before the window, or before a given cutoff, ending within the ten-minute gap, same filters", () => {
    const window = snowflakeBoundarySql(needle)
    expect(window).toContain("/* run boundary */")
    expect(window).toContain("q.start_time < dateadd(day, -30, current_timestamp())")
    expect(window).toContain("q.end_time >= dateadd(second, -600, dateadd(day, -30, current_timestamp()))")
    expect(window).toContain("q.execution_status = 'SUCCESS'")
    expect(window).toContain(`contains(q.query_text, '"node_id": "model.shop.orders"')`)
    expect(window).toContain("limit 500")
    expect(snowflakeBoundarySql(needle, 1234)).toContain("q.start_time < to_timestamp_ltz(1234, 3)")
  })

  test("Databricks: same filters, a cutoff as a timestamp", () => {
    const sql = databricksBoundarySql(needle, 1234)
    expect(sql).toContain("start_time < timestamp_millis(1234)")
    expect(sql).toContain("- interval 600 seconds")
    expect(sql).toContain("execution_status = 'FINISHED'")
    expect(sql).toContain("statement_type in ('CREATE','INSERT','MERGE','DELETE','UPDATE','REPLACE','COPY','OPTIMIZE','ANALYZE')")
    expect(databricksBoundarySql(needle)).toContain("current_timestamp() - interval 30 days")
  })

  test("BigQuery: top-level jobs of the same view, within a minute of the cutoff", () => {
    const sql = bigqueryBoundarySql({ project: "p", location: "EU", needle, view: "JOBS_BY_USER", cutoffMs: 99 })
    expect(sql).toContain("`p`.`region-eu`.INFORMATION_SCHEMA.JOBS_BY_USER")
    expect(sql).toContain("creation_time < timestamp_millis(99)")
    // Only a delete or update can attach to a later build, by creation time.
    expect(sql).toContain("creation_time >= timestamp_sub(timestamp_millis(99), interval 60 second)")
    expect(sql).toContain("statement_type in ('DELETE','UPDATE')")
    expect(sql).toContain("user_email")
    // And the CTAS into dbt's temporary relation that ended within ten minutes before it.
    expect(sql).toContain("statement_type = 'CREATE_TABLE_AS_SELECT' and ends_with(destination_table.table_id, '__dbt_tmp')")
    expect(sql).toContain("end_time >= timestamp_sub(timestamp_millis(99), interval 10 minute)")
    expect(sql).toContain("parent_job_id is null")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
  })

  test("every boundary query returns the id of each statement, so the ones already read can be excluded", () => {
    expect(snowflakeBoundarySql("n")).toContain("select /* run boundary */ q.query_id")
    expect(databricksBoundarySql("n")).toContain("select /* run boundary */ statement_id")
    expect(bigqueryBoundarySql({ project: "p", needle: "n" })).toContain("select /* run boundary */ job_id")
  })

  test("the BigQuery history reads the job's user, which a delete must share with the build it joins", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n" })).toContain("select job_id, user_email,")
    expect(bigqueryHistorySql({ project: "p", needle: "n" })).toContain("destination_table.table_id as destination_table_id")
  })

  test("Databricks proration multiplies in double, never BIGINT by BIGINT", () => {
    const sql = databricksHistorySql(needle)
    expect(sql).toContain("cast(coalesce(a.ms, 0) as double) * (least(")
    expect(sql).toContain("cast(coalesce(q_hours.ms, 0) as double) * (least(")
    expect(sql).toContain("/ cast(unix_micros(a.end_time) - unix_micros(a.start_time) as double)")
    expect(sql).not.toMatch(/coalesce\((a|q_hours)\.ms, 0\) \* \(/)
  })
})

describe("script children at their limit", () => {
  test("a script that began before the oldest child returned is unknown, a later one is priced", () => {
    const old = bq("old", 0, null, null, 0, "SCRIPT")
    const recent = bq("recent", 1000, null, null, 0, "SCRIPT")
    const kid = (id: string, parent: string, startMin: number): Row => ({
      job_id: id,
      parent_job_id: parent,
      creation_time: new Date(startMin * MIN).toISOString(),
      statement_type: "MERGE",
      total_bytes_billed: String(TIB),
      total_slot_ms: "0",
      reservation_id: null,
      cache_hit: "False",
    })
    // The oldest child returned (minute 500) is another script's: the cut happened there, so a script from minute 1000 is whole.
    // The old script has a child past the cut, but may have had more before it.
    const children = [kid("edge", "elsewhere", 500), kid("oc", "old", 700), ...Array.from({ length: BQ_CHILD_LIMIT - 2 }, (_, i) => kid(`x${i}`, "recent", 1001 + i))]
    const { cost } = priceBigquery([old, recent, bq("filler", 5000, TIB)], children, "model.s.m", {})
    expect(cost.runs).toBe(2)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })
})

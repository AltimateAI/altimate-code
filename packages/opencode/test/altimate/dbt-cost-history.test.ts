// The cost of a model's earlier runs: the history SQL per warehouse, the grouping of statements into runs, and the
// pricing of what each warehouse reports. No adapter or warehouse is involved.
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import {
  BQ_CHILD_LIMIT,
  BQ_MIN_BILLED_BYTES,
  HISTORY_LIMIT,
  bigqueryCapacitySql,
  bigqueryHistorySql,
  bqProject,
  cleanRates,
  costText,
  median,
  needleFor,
  onDemandPrice,
  parseRows,
  parseTime,
  priceBigquery,
  resolveModel,
  rowsJinja,
  unreadable,
  windowStartMs,
  countTables,
  bigqueryChildrenSql,
  formatMoney,
  loadHistory,
  manifestPathFor,
  modelFromManifest,
  bigqueryBoundarySql,
  boundaryWindow,
  sqlString,
  summarize,
  type Row,
} from "@/altimate/tools/dbt-cost-history"

const TIB = 1024 ** 4
const MIN = 60_000
/** The instant the SQL under test is read as of. */
const ASOF = Date.UTC(2026, 5, 1, 20, 0, 0)
const WINDOW = windowStartMs(ASOF)

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
    const sql = bigqueryHistorySql({ project: "my-proj", location: "EU", needle, asOfMs: ASOF })
    expect(sql).toContain("from `my-proj`.`region-eu`.INFORMATION_SCHEMA.JOBS")
    expect(sql).toContain(`creation_time > timestamp_millis(${WINDOW}) and creation_time <= timestamp_millis(${ASOF})`)
    expect(sql).toContain("parent_job_id is null")
    expect(sql).toContain("error_result is null")
    expect(sql).toContain("upper(statement_type) in ('CREATE_TABLE_AS_SELECT','CREATE_TABLE','CREATE_VIEW','INSERT','MERGE','SCRIPT','DELETE','UPDATE')")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
    expect(sql).not.toMatch(/\blike\b/i)
    expect(sql).toContain("order by creation_time desc limit 500")
  })

  test("BigQuery: no location falls back to us, and a hostile one cannot leave the quoted name", () => {
    expect(bigqueryHistorySql({ project: "p", needle, asOfMs: ASOF })).toContain("`region-us`")
    expect(bigqueryHistorySql({ project: "p", location: "eu`; drop", needle, asOfMs: ASOF })).toContain("`region-eudrop`")
  })

  test("BigQuery: the capacity check counts a week of query jobs and those in a reservation", () => {
    const sql = bigqueryCapacitySql({ project: "p", location: "us", asOfMs: ASOF })
    expect(sql).toContain(`creation_time > timestamp_millis(${windowStartMs(ASOF, 7)}) and creation_time <= timestamp_millis(${ASOF})`)
    expect(sql).toContain("countif(reservation_id is not null) as reserved")
    expect(sql).toContain("count(*) as jobs")
    expect(sql).toContain("upper(job_type) = 'QUERY'")
  })

  test("BigQuery: a role that cannot list every user's jobs reads its own from JOBS_BY_USER", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n", view: "JOBS_BY_USER", asOfMs: ASOF })).toContain("INFORMATION_SCHEMA.JOBS_BY_USER")
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("INFORMATION_SCHEMA.JOBS\n")
    expect(bigqueryCapacitySql({ project: "p", view: "JOBS_BY_USER", asOfMs: ASOF })).toContain("JOBS_BY_USER")
  })

  test("BigQuery: the children of matched scripts are read by parent id, escaped, in the same window and region", () => {
    const sql = bigqueryChildrenSql({ project: "p", location: "EU", parents: ["job_1", "j'2"], sinceMs: 1_700_000_000_123 })
    expect(sql).toContain("parent_job_id in ('job_1','j\\'2')")
    expect(sql).toContain("`region-eu`")
    // The lower bound is the earliest parent's creation: a fixed instant, not a window that slides while the parents are read.
    expect(sql).toContain("creation_time >= timestamp_millis(1700000000123)")
    expect(sql).not.toContain("current_timestamp")
  })

  test("BigQuery project ids with anything beyond a name's characters are refused", () => {
    expect(bqProject("my-proj")).toBe("my-proj")
    expect(bqProject("example.com:proj")).toBe("example.com:proj")
    expect(bqProject("p`; drop")).toBeUndefined()
    expect(bqProject(undefined)).toBeUndefined()
  })

  test("every comparison with a warehouse enum or category column is case-insensitive", () => {
    const needle = needleFor("model.shop.orders")
    const w = boundaryWindow(1_780_000_000_000)
    const sqls = [
      bigqueryHistorySql({ project: "p", needle, asOfMs: ASOF }),
      bigqueryChildrenSql({ project: "p", parents: ["a"], sinceMs: 1 }),
      bigqueryCapacitySql({ project: "p", asOfMs: ASOF }),
      bigqueryBoundarySql({ project: "p", needle, window: w }),
    ]
    const columns = ["statement_type", "job_type", "state"]
    const bare = new RegExp(`(?<!upper\\()(?:\\b\\w+\\.)?\\b(${columns.join("|")})\\b\\s*(=|in\\s*\\()`, "g")
    for (const sql of sqls) expect([...sql.matchAll(bare)].map((m) => m[0])).toEqual([])
    // The check sees a bare comparison.
    expect([..."and state = 'DONE'".matchAll(bare)]).toHaveLength(1)
  })

  test("a quote in the needle is escaped in the history SQL", () => {
    const hostile = `"node_id": "model.a.b' or 1=1 --"`
    expect(bigqueryHistorySql({ project: "p", needle: hostile, asOfMs: ASOF })).toContain("b\\' or 1=1")
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

describe("run statistics", () => {
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
    // The newest run is the reservation's, so the headline rate is the slot rate; the on-demand rate is named too.
    expect(cost.rate?.unit).toBe("USD/slot-hour")
    expect(cost.notes.join(" ")).toContain("On-demand runs are priced at 6.25 USD/TiB (default).")
    const configured = priceBigquery([bq("a", 0, TIB), bq("b", 100, 0, "res", 3_600_000)], undefined, "model.s.m", { bigqueryUsdPerTib: 5 }).cost
    expect(configured.notes.join(" ")).toContain("On-demand runs are priced at 5 USD/TiB (from your config).")
  })

  test("all-reservation history names no on-demand rate", () => {
    expect(priceBigquery([bq("b", 100, 0, "res", 3_600_000)], undefined, "model.s.m", {}).cost.notes.join(" ")).not.toContain("On-demand runs")
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

  test("the floor is one query's 10 MiB whatever the count, and the high figure adds the counted tables' minimums plus perTable for each further one", () => {
    const price = onDemandPrice({ maxBytes: 2048, tables: 3, usdPerTib: rate })
    expect(price.low).toBeCloseTo((tenMiB * rate) / TIB, 14)
    expect(price.high).toBeCloseTo(((2048 + 3 * tenMiB) * rate) / TIB, 14)
    expect(price.perTable).toBeCloseTo((tenMiB * rate) / TIB, 14)
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

describe("rates config and the text", () => {
  test("only positive numbers are rates", () => {
    expect(cleanRates({ bigqueryUsdPerTib: 5, bigquerySlotHourUsd: -1, snowflakeUsdPerCredit: 3, databricksUsdPerDbu: 2 })).toEqual({ bigqueryUsdPerTib: 5 })
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
    const text = costText({ basis: "dry_run", currency: "USD", rate: null, notes: [], selectOnly: { low: 1, high: 2, perTable: 0.5 } })
    expect(text).toBe(
      "The SELECT would bill $2.00 on-demand, plus 10 MiB (~$0.50) for each further table the query reads (at least $1.00 when it is not served from BigQuery's cache, which bills nothing; pruning of clustered or partitioned tables can bill less than the dry run).",
    )
  })
})

describe("run boundary", () => {
  const C = 1_000 * MIN
  const at = (min: number) => new Date(C + min * MIN).toISOString()
  const boundary = (...stmts: { user: string | null; start: number; end: number; tmp?: boolean }[]) => ({ cutoff: C, stmts })
  const before = (user: string, startMin: number, endMin: number) => ({ user, start: C + startMin * MIN, end: C + endMin * MIN })

  test("a boundary that could not be read drops runs starting within a day of the cutoff and keeps later ones", () => {
    const rows = [
      { ...bq("near", 0, TIB), creation_time: at(60), end_time: at(61) },
      { ...bq("far", 0, 2 * TIB), creation_time: at(3 * 24 * 60), end_time: at(3 * 24 * 60 + 1) },
    ]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C })
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(12.5, 10)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("an unreadable boundary is measured from the cutoff itself: a run exactly a day after it is dropped, one a millisecond later is kept", () => {
    const at = (ms: number) => new Date(C + ms).toISOString()
    const day = 24 * 3_600_000
    const run = (offset: number) =>
      priceBigquery([{ ...bq("a", 0, TIB), creation_time: at(offset), end_time: at(offset + 1000) }], undefined, "model.s.m", {}, { cutoff: C }).cost.basis
    expect(run(day)).toBe("none")
    expect(run(day + 1)).toBe("history")
  })

  test("without a boundary nothing is dropped, and a full result says only 500 statements were read", () => {
    const rows = Array.from({ length: HISTORY_LIMIT }, (_, i) => bq(`q${i}`, i * 120, TIB))
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(HISTORY_LIMIT)
    expect(cost.notes.join(" ")).toContain("Only the newest 500 statements were read")
  })

  test("BigQuery: an unread delete by the same user that started within a minute before a build may belong to it; others do not", () => {
    const rows = [
      { ...bq("near", 0, TIB), creation_time: at(0.5) },
      { ...bq("far", 0, TIB), creation_time: at(120) },
    ]
    const price = (b: { user: string | null; start: number; end: number }) => priceBigquery(rows, undefined, "model.s.m", {}, boundary(b)).cost
    const own = price({ user: "a@x.com", start: C - 0.2 * MIN, end: Number.NaN })
    expect(own.runs).toBe(1)
    expect(own.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Another user's delete, or one more than a minute before the build, cannot have attached to it.
    expect(price({ user: "someone@else.com", start: C - 0.2 * MIN, end: Number.NaN }).runs).toBe(2)
    expect(price({ user: "a@x.com", start: C - 5 * MIN, end: Number.NaN }).runs).toBe(2)
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
    const stmt = (end: number, user = "a@x.com") => ({ user, start: C - 5 * MIN, end: C + end * MIN, tmp: true })
    const cost = (b: ReturnType<typeof stmt>) => priceBigquery(rows, undefined, "model.s.m", {}, boundary(b)).cost
    expect(cost(stmt(0)).notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Another user's CTAS, or one that ended over ten minutes before the merge, cannot have fed it.
    expect(cost(stmt(0, "b@x.com")).runs).toBe(1)
    expect(priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 30 * MIN, end: C - 20 * MIN, tmp: true })).cost.runs).toBe(1)
  })

  test("BigQuery: an unread CTAS that could have been a merge's temporary relation drops it even when the merge already pairs with a CTAS read", () => {
    // The merge has its own CTAS in the result, but an unread one ended just before it too and could have been the one it took.
    const rows = [{ ...tmpCtas("t", 0, TIB), creation_time: at(0), end_time: at(1) }, { ...bq("m", 0, TIB), creation_time: at(2) }]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 5 * MIN, end: C + 0, tmp: true }))
    expect(cost.basis).toBe("none")
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("BigQuery: the temporary-relation rule is measured from the final build's start, not an attached delete's", () => {
    // delete at +1 min attaches to the CTAS at +1.2, which pairs with the merge at +3: the run starts at +1, its final build at +3.
    const rows = [
      { ...bq("d", 0, TIB, null, 0, "DELETE"), creation_time: at(1) },
      { ...tmpCtas("t", 0, TIB), creation_time: at(1.2), end_time: at(2.2) },
      { ...bq("m", 0, TIB), creation_time: at(3) },
    ]
    const price = (end: number) => priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 30 * MIN, end: C + end * MIN, tmp: true })).cost
    // Ending 8 minutes before the merge's start is outside its ten minutes of the merge (-7): the run is whole.
    expect(price(-8).runs).toBe(1)
    // Ending 6 minutes before the cutoff is inside them.
    expect(price(-6).basis).toBe("none")
  })

  test("BigQuery: an unread delete is measured from the run's first build, not from an attached delete that started earlier", () => {
    // A delete read at +0.1 min attaches to the merge at +0.5: the run starts at +0.1, its first build at +0.5.
    const rows = [{ ...bq("d", 0, TIB, null, 0, "DELETE"), creation_time: at(0.1) }, { ...bq("m", 0, TIB), creation_time: at(0.5) }]
    const run = (start: number) => priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C + start * MIN, end: C + start * MIN })).cost
    // Created 42 s before the cutoff: more than a minute before the merge, so it cannot have attached to it.
    expect(run(-0.7).runs).toBe(1)
    expect(run(-0.3).basis).toBe("none")
  })

  test("BigQuery: a delete before the cutoff is measured against the run's first build, not against the merge", () => {
    // tmp CTAS read at +0.5, merge at +3; an unread delete 90 s before the CTAS cannot have attached to it (over a minute).
    const rows = [{ ...tmpCtas("t", 0, TIB), creation_time: at(0.5), end_time: at(1.5) }, { ...bq("m", 0, TIB), creation_time: at(3) }]
    const run = (start: number) => priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C + start * MIN, end: C + start * MIN })).cost
    expect(run(-1).runs).toBe(1)
    expect(run(-0.4).basis).toBe("none")
  })

  test("BigQuery: statement types are read in any case, so a lower-case merge still ends the run of its temporary CTAS", () => {
    const rows = [tmpCtas("t", 0, TIB), bq("m", 3, 2 * TIB, null, 0, "merge")]
    rows[0].statement_type = "create_table_as_select"
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(18.75, 10)
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
    const cost = priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 0.2 * MIN, end: Number.NaN })).cost
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("may have started before the period read")
    expect(cost.unknownReason).not.toContain("no bytes billed")
  })
})

describe("boundary SQL", () => {
  const needle = needleFor("model.shop.orders")

  // A cutoff far enough from zero that every derived instant is distinct and positive.
  const CUT = 1_780_000_000_000
  const w = boundaryWindow(CUT)

  test("the window is derived from the cutoff itself: the start bound reaches it, every lookback is measured from it", () => {
    expect(w).toEqual({
      startBeforeMs: CUT + 1,
      startAfterMs: CUT - 86_400_000,
      attachStartAtLeastMs: CUT - 60_000,
      tmpEndAtLeastMs: CUT - 600_000,
    })
  })

  test("BigQuery: top-level jobs of the same view, each lookback measured from the cutoff", () => {
    const sql = bigqueryBoundarySql({ project: "p", location: "EU", needle, view: "JOBS_BY_USER", window: w })
    expect(sql).toContain("`p`.`region-eu`.INFORMATION_SCHEMA.JOBS_BY_USER")
    expect(sql).toContain(`creation_time < timestamp_millis(${CUT + 1})`)
    // Only a delete or update can attach to a later build, by creation time.
    expect(sql).toContain(`creation_time >= timestamp_millis(${CUT - 60_000})`)
    expect(sql).toContain("upper(statement_type) in ('DELETE','UPDATE')")
    expect(sql).toContain("user_email")
    // And the CTAS into dbt's temporary relation that ended within ten minutes before it.
    expect(sql).toContain("upper(statement_type) = 'CREATE_TABLE_AS_SELECT' and ends_with(destination_table.table_id, '__dbt_tmp')")
    expect(sql).toContain(`end_time >= timestamp_millis(${CUT - 600_000})`)
    expect(sql).not.toContain(`${CUT + 1 - 60_000}`)
    expect(sql).not.toContain(`${CUT + 1 - 600_000}`)
    expect(sql).toContain("parent_job_id is null")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
  })

  test("the boundary query returns the id of each statement, so the ones already read can be excluded", () => {
    expect(bigqueryBoundarySql({ project: "p", needle: "n", window: boundaryWindow(1) })).toContain("select /* run boundary */ job_id")
  })

  test("the BigQuery history reads the job's user, which a delete must share with the build it joins", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("select job_id, user_email,")
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("destination_table.table_id as destination_table_id")
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

describe("review follow-ups: BigQuery temporary relation pairing", () => {
  const C2 = 5_000 * MIN
  const tmp = (id: string, startMin: number, billed: number, user = "a@x.com"): Row =>
    bq(id, startMin, billed, null, 0, "CREATE_TABLE_AS_SELECT", { user_email: user, destination_table_id: "orders__dbt_tmp" })

  test("two overlapping invocations by one user pair one CTAS with one MERGE each, never both with the first", () => {
    // tmpA 0-1 min (1 TiB), tmpB 0.5-1.5 (2 TiB), mergeA at 2 (3 TiB), mergeB at 4 (4 TiB).
    const rows = [tmp("tA", 0, TIB), tmp("tB", 0.5, 2 * TIB), bq("mA", 2, 3 * TIB), bq("mB", 4, 4 * TIB)]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(2)
    // mergeB's run holds tmpB (6 TiB); mergeA's holds tmpA (4 TiB).
    expect(cost.highest).toBeCloseTo(6 * 6.25, 10)
    expect(cost.lastRun).toBeCloseTo(6 * 6.25, 10)
    expect(cost.typical).toBeCloseTo(((4 + 6) / 2) * 6.25, 10)
  })

  test("a second CTAS with no unclaimed final build is a run of its own", () => {
    const { cost } = priceBigquery([tmp("tA", 0, TIB), tmp("tB", 0.2, TIB), bq("m", 2, TIB)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(2)
  })

  test("a merge starting after an unread CTAS that ends after it cannot be that CTAS's run and is kept", () => {
    const rows = [{ ...bq("m", 0, TIB), creation_time: new Date(C2 + 2 * MIN).toISOString() }]
    const run = (end: number) =>
      priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C2, stmts: [{ user: "a@x.com", start: C2 - 5 * MIN, end: C2 + end * MIN, tmp: true }] }).cost
    // The CTAS ends an hour after the merge starts: they cannot be one run.
    expect(run(60).runs).toBe(1)
    // Ending a minute before it starts, it could be the merge's own temporary relation: the run is dropped.
    expect(run(1).notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })
})

describe("review follow-ups: bounds, text and causes", () => {
  test("a ceiling rounds up and a floor rounds down, so the text never excludes the real charge", () => {
    expect(formatMoney(6.562559604645912, "up")).toBe("$6.57")
    expect(formatMoney(6.562559604645912, "down")).toBe("$6.56")
    expect(formatMoney(6.562559604645912)).toBe("$6.56")
    expect(formatMoney(0.000059604644775, "down")).toBe("$0.000059")
    expect(formatMoney(0.000059604644775, "up")).toBe("$0.000060")
    expect(formatMoney(0, "up")).toBe("$0.00")
  })

  test("the SELECT line states its ceiling rounded up and its floor rounded down", () => {
    const text = costText({ basis: "dry_run", currency: "USD", rate: null, notes: [], selectOnly: { low: 0.000059604644775, high: 6.562559604645912, perTable: 0.00006 } })
    expect(text).toContain("would bill $6.57 on-demand")
    expect(text).toContain("at least $0.000059")
  })

  test("the SELECT's price is in the text beside the history, since a note refers to it", () => {
    const text = costText({
      basis: "history",
      currency: "USD",
      lastRun: 1,
      typical: 1,
      highest: 1,
      runs: 1,
      windowDays: 30,
      rate: null,
      notes: [],
      selectOnly: { low: 1, high: 2, perTable: 0.5 },
    })
    expect(text.split("\n")[0]).toContain("Cost from 1 run")
    expect(text).toContain("The SELECT would bill $2.00 on-demand, plus 10 MiB")
  })

  test("BigQuery: children cut off at their limit are named as the cause, not 'not found'", () => {
    const script = bq("s", 0, null, null, 0, "SCRIPT")
    const kid = (i: number): Row => ({
      job_id: `k${i}`,
      parent_job_id: "other",
      creation_time: new Date(10 * MIN).toISOString(),
      statement_type: "MERGE",
      total_bytes_billed: "1",
      total_slot_ms: "0",
      reservation_id: null,
      cache_hit: "False",
    })
    const { cost } = priceBigquery([script], Array.from({ length: BQ_CHILD_LIMIT }, (_, i) => kid(i)), "model.s.m", {})
    expect(cost.unknownReason).toContain("cut off at the children query's limit")
    expect(cost.unknownReason).not.toContain("were not found")
    const none = priceBigquery([script], [], "model.s.m", {}).cost
    expect(none.unknownReason).toContain("child jobs were not found")
  })

  test("BigQuery: a reservation job with no slot time is unknown, never zero slot-hours", () => {
    const { cost } = priceBigquery([bq("a", 0, 0, "res", 0, "MERGE", { total_slot_ms: null })], undefined, "model.s.m", {})
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("no slot time for a job that ran in a reservation")
    // A reported zero is still a zero.
    expect(priceBigquery([bq("b", 0, 0, "res", 0)], undefined, "model.s.m", {}).cost).toMatchObject({ basis: "history", lastRun: 0 })
  })

  test("BigQuery: a job with no bytes billed is named as the cause", () => {
    const { cost } = priceBigquery([bq("a", 0, null)], undefined, "model.s.m", {})
    expect(cost.unknownReason).toContain("hides them for tables under a row access policy")
  })
})

describe("review follow-ups: manifest and cancellation", () => {
  test("the manifest path is the adapter's own, else its project's target, else the session's project's target", () => {
    expect(manifestPathFor({ getManifestPath: () => "/x/m.json", getProjectRoot: () => "/p" }, "/q")).toBe("/x/m.json")
    expect(manifestPathFor({ getProjectRoot: () => "/p" }, "/q")).toBe("/p/target/manifest.json")
    expect(manifestPathFor({}, "/q")).toBe("/q/target/manifest.json")
    expect(manifestPathFor({}, undefined)).toBeUndefined()
    expect(manifestPathFor({ getManifestPath: () => "" }, "/q")).toBe("/q/target/manifest.json")
  })

  test("a manifest that cannot be read is an error that names the file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "manifest.json")
    await writeFile(file, "{ not json")
    expect(modelFromManifest(file, "orders")).toEqual({ error: expect.stringContaining(`the manifest at ${file}`) })
    expect(modelFromManifest(path.join(tmp.path, "missing.json"), "orders")).toEqual({ error: expect.stringContaining("no manifest at") })
  })

  test("dbt's bare 'Encountered an error:' wrapper is not shown as the cause", () => {
    const wrapped = unreadable("[ERROR]: Encountered an error:\nNOT_FOUND: Dataset p:d was not found in location EU")
    expect(wrapped.unknownReason).toContain("(NOT_FOUND: Dataset p:d was not found")
    expect(wrapped.unknownReason).not.toContain("Encountered an error")
    // A message that is only the wrapper leaves no empty parentheses.
    const bare = unreadable("[ERROR]: Encountered an error:")
    expect(bare.unknownReason).not.toContain("()")
    expect(bare.unknownReason).not.toContain("Encountered")
    // An ordinary message is shown as it was.
    expect(unreadable("boom\nsecond line").unknownReason).toContain("(boom)")
  })

  test("a call cancelled before the history starts stops, even when no query would be sent", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const adapter = { unsafeCompileQuery: async () => "{}" }
    const input = { adapter, signal: controller.signal, cfg: {} }
    // SQL input has no history to read, and an unresolved model none either: both would otherwise return normally.
    expect(await loadHistory({ ...input, model: undefined }).then(() => "answered", (e: unknown) => e)).toMatchObject({ message: "cancelled" })
    expect(await loadHistory({ ...input, model: "orders", manifestPath: undefined }).then(() => "answered", (e: unknown) => e)).toMatchObject({ message: "cancelled" })
  })
})

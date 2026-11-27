// The cost of a model's earlier runs: the history SQL per warehouse, the grouping of statements into runs, and the
// pricing of what each warehouse reports. No adapter or warehouse is involved.
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import {
  BQ_CHILD_LIMIT,
  HISTORY_LIMIT,
  bigqueryCapacitySql,
  bigqueryHistorySql,
  bqProject,
  cleanRates,
  costText,
  median,
  needleFor,
  onDemandEstimate,
  parseRows,
  parseTime,
  priceBigquery,
  resolveModel,
  rowsJinja,
  unreadable,
  windowStartMs,
  bigqueryChildrenSql,
  ignoredRateNotes,
  locationNote,
  MAX_RATE,
  formatMoney,
  loadHistory,
  manifestPathFor,
  modelFromManifest,
  BOUNDARY_SPAN_MS,
  MAX_JOB_SPAN_MS,
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
    // No statement-type filter: a SELECT hook is billed and part of the invocation. The tool's own reads are excluded by their marker.
    expect(sql).not.toContain("statement_type) in")
    expect(sql).toContain("strpos(query, 'altimate_cost_read') = 0")
    expect(sql).toContain("select /* altimate_cost_read */ job_id")
    // The state is read, so a job still queued or running is known as such.
    expect(sql).toContain("end_time, state, statement_type")
    // Finished jobs, and those still queued or running, whose run is not complete.
    expect(sql).toContain("(upper(state) = 'DONE' and error_result is null) or upper(state) in ('PENDING','RUNNING')")
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

  test("BigQuery: the children of matched scripts are read by parent id, escaped, from the earliest parent's creation, in the same region", () => {
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
    // A $0 run gets no note claiming a minimum charge.
    expect(cost.notes.some((n: string) => /at least|minimum|rounds up/i.test(n))).toBe(false)
    expect(cost.notes).toContain("On-demand jobs are priced by the bytes BigQuery billed for each job.")
  })

  test("jobs by one user, each starting within a minute after the previous one ended, are one run; a longer gap is a new run", () => {
    // Each bq() job lasts a minute: starts at 0, 1 and 2 minutes chain, a job at 5 starts 2 minutes after the last ended.
    const chained = priceBigquery([bq("a", 0, TIB), bq("b", 1, TIB), bq("c", 2, TIB)], undefined, "model.s.m", {})
    expect(chained.cost.runs).toBe(1)
    expect(chained.cost.lastRun).toBe(3 * 6.25)
    expect(priceBigquery([bq("a", 0, TIB), bq("b", 5, TIB), bq("c", 10, TIB)], undefined, "model.s.m", {}).cost.runs).toBe(3)
    // Exactly a minute after the previous job ended chains; a millisecond more does not.
    const gap = (ms: number) => priceBigquery([bq("a", 0, TIB), { ...bq("b", 0, TIB), creation_time: new Date(MIN + ms + MIN).toISOString(), end_time: new Date(3 * MIN + ms).toISOString() }], undefined, "model.s.m", {}).cost.runs
    expect(gap(0)).toBe(1)
    expect(gap(1)).toBe(2)
  })

  test("a delete joins the job that starts within a minute after it ended, else is a run of its own", () => {
    const attached = priceBigquery([bq("d", 0, TIB, null, 0, "DELETE"), { ...bq("m", 0, TIB), creation_time: new Date(MIN / 2).toISOString() }], undefined, "model.s.m", {})
    expect(attached.cost.runs).toBe(1)
    expect(attached.cost.lastRun).toBe(12.5)
    // Not within a minute of the build: the delete is not part of its run, and a delete alone is not a run.
    const apart = priceBigquery([bq("d", 0, TIB, null, 0, "UPDATE"), bq("m", 5, TIB)], undefined, "model.s.m", {})
    expect(apart.cost.runs).toBe(1)
    expect(apart.cost.lastRun).toBe(6.25)
  })

  test("a CTAS and an INSERT post-hook 5 s later are one run, not a $6.25 run and a near-zero one", () => {
    const rows = [
      bq("c", 0, TIB, null, 0, "CREATE_TABLE_AS_SELECT", { destination_table_id: "orders" }),
      { ...bq("h", 0, 10 * 1024 ** 2, null, 0, "INSERT", { destination_table_id: "audit" }), creation_time: new Date(MIN + 5_000).toISOString(), end_time: new Date(MIN + 6_000).toISOString() },
    ]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(6.25 + (10 * 1024 ** 2 / TIB) * 6.25, 10)
    expect(cost.highest).toBeCloseTo(cost.lastRun!, 10)
  })

  test("the batches of a microbatch model are one run", () => {
    const batch = (id: string, startMin: number) => bq(id, startMin, TIB, null, 0, "MERGE", { destination_table_id: "orders" })
    const { cost } = priceBigquery([batch("b1", 0), batch("b2", 1), batch("b3", 2)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(3 * 6.25)
  })

  test("two scheduled invocations five minutes apart are two runs", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 5, TIB)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(2)
    expect(cost.highest).toBe(6.25)
  })

  test("jobs of different users are different runs even when they chain in time", () => {
    const rows = [bq("a", 0, TIB), bq("b", 1, TIB, null, 0, "MERGE", { user_email: "b@x.com" })]
    expect(priceBigquery(rows, undefined, "model.s.m", {}).cost.runs).toBe(2)
  })
})

describe("BigQuery pre-run price", () => {
  test("the estimate is the dry run's bytes at the on-demand rate, with no bound fields", () => {
    expect(onDemandEstimate(2 * TIB, 6.25)).toBeCloseTo(12.5, 12)
    expect(onDemandEstimate(0, 6.25)).toBe(0)
    expect(onDemandEstimate(TIB / 2, 5)).toBeCloseTo(2.5, 12)
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

  test("a dry-run price is worded as an estimate that the bill can differ from", () => {
    const text = costText({ basis: "dry_run", currency: "USD", rate: null, notes: [], selectOnly: { estimate: 2 } }, "1.0 TiB")
    expect(text).toBe(
      "BigQuery's dry run estimates the SELECT at 1.0 TiB, about $2.00 on-demand. The bill can differ: a cached or BI Engine result bills nothing, external sources and some queries are not fully counted, and each table read bills at least 10 MiB.",
    )
    for (const claim of ["at most", "at least $", "ceiling", "floor"]) expect(text).not.toContain(claim)
  })
})

describe("run boundary", () => {
  const C = 1_000 * MIN
  const at = (min: number) => new Date(C + min * MIN).toISOString()
  const boundary = (...stmts: { user: string | null; start: number; end: number; tmp?: boolean }[]) => ({ cutoff: C, stmts })

  test("a boundary that could not be read drops runs starting within the boundary span (42 h 10 min) of the cutoff and keeps later ones", () => {
    const rows = [
      { ...bq("near", 0, TIB), creation_time: at(60), end_time: at(61) },
      { ...bq("far", 0, 2 * TIB), creation_time: at(3 * 24 * 60), end_time: at(3 * 24 * 60 + 1) },
    ]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C })
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(12.5, 10)
    expect(cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
  })

  test("an unreadable boundary is measured from the cutoff itself: a run exactly the boundary span after it is dropped, one a millisecond later is kept", () => {
    const at = (ms: number) => new Date(C + ms).toISOString()
    const day = BOUNDARY_SPAN_MS
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

  test("BigQuery: an unread job by the same user that ended within a minute before a run began may belong to it; others do not", () => {
    const rows = [
      { ...bq("near", 0, TIB), creation_time: at(0.5), end_time: at(1.5) },
      { ...bq("far", 0, TIB), creation_time: at(120), end_time: at(121) },
    ]
    const price = (b: { user: string | null; start: number; end: number }) => priceBigquery(rows, undefined, "model.s.m", {}, boundary(b)).cost
    const own = price({ user: "a@x.com", start: C - 3 * MIN, end: C - 0.2 * MIN })
    expect(own.runs).toBe(1)
    expect(own.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Another user's job, or one that ended more than a minute before the run began, cannot have chained to it.
    expect(price({ user: "someone@else.com", start: C - 3 * MIN, end: C - 0.2 * MIN }).runs).toBe(2)
    expect(price({ user: "a@x.com", start: C - 6 * MIN, end: C - 5 * MIN }).runs).toBe(2)
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
    // delete at +1 min chains to the CTAS at +1.2, which pairs with the merge at +3: the run starts at +1, its final build at +3.
    const rows = [
      { ...bq("d", 0, TIB, null, 0, "DELETE"), creation_time: at(1), end_time: at(2) },
      { ...tmpCtas("t", 0, TIB), creation_time: at(1.2), end_time: at(2.2) },
      { ...bq("m", 0, TIB), creation_time: at(3), end_time: at(4) },
    ]
    const price = (end: number) => priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 30 * MIN, end: C + end * MIN, tmp: true })).cost
    // Ending at -8 minutes is eleven minutes before the merge's start (+3), outside its ten minutes of it: the run is whole.
    expect(price(-8).runs).toBe(1)
    // Ending 6 minutes before the cutoff is inside them.
    expect(price(-6).basis).toBe("none")
  })

  test("BigQuery: an unread job is measured from the run's start, the earliest of its jobs", () => {
    // A delete read at +0.1 min chains to the merge at +0.5 (it ends at +1.1): the run starts at +0.1.
    const rows = [{ ...bq("d", 0, TIB, null, 0, "DELETE"), creation_time: at(0.1), end_time: at(0.3) }, { ...bq("m", 0, TIB), creation_time: at(0.5), end_time: at(1.5) }]
    const run = (end: number) => priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 5 * MIN, end: C + end * MIN })).cost
    // Ended 70 s before the run's start: too early to chain to it.
    expect(run(-1.2).runs).toBe(1)
    // Ended 50 s before it.
    expect(run(-0.7).basis).toBe("none")
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
    // The delete is another user's: it does not join the merge's run, and it makes none.
    const other = priceBigquery(rows, undefined, "model.s.m", {}).cost
    expect(other.runs).toBe(1)
    expect(other.lastRun).toBe(6.25)
    const same = [{ ...rows[0], user_email: "b@x.com" }, rows[1]]
    expect(priceBigquery(same, undefined, "model.s.m", {}).cost.lastRun).toBe(12.5)
  })

  test("BigQuery: when the boundary alone leaves no run, the message says so rather than blaming bytes billed", () => {
    const rows = [{ ...bq("near", 0, TIB), creation_time: at(0.5), end_time: at(1.5) }]
    const cost = priceBigquery(rows, undefined, "model.s.m", {}, boundary({ user: "a@x.com", start: C - 3 * MIN, end: C - 0.2 * MIN })).cost
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
      startAfterMs: CUT - BOUNDARY_SPAN_MS,
      liveStartAfterMs: CUT - 30 * 86_400_000,
      joinEndAtLeastMs: CUT - 60_000,
      tmpEndAtLeastMs: CUT - 600_000,
    })
  })

  test("BigQuery: top-level jobs of the same view, each lookback measured from the cutoff", () => {
    const sql = bigqueryBoundarySql({ project: "p", location: "EU", needle, view: "JOBS_BY_USER", window: w })
    expect(sql).toContain("`p`.`region-eu`.INFORMATION_SCHEMA.JOBS_BY_USER")
    expect(sql).toContain(`creation_time < timestamp_millis(${CUT + 1})`)
    // Any matched job (a read too) that ended within a minute before the cutoff can chain to a later run, by end time.
    expect(sql).toContain(`end_time >= timestamp_millis(${CUT - 60_000})`)
    expect(sql).not.toContain("statement_type) in")
    expect(sql).toContain("strpos(query, 'altimate_cost_read') = 0")
    // The identity the main grouping pairs on: the destination table and dataset.
    expect(sql).toContain("destination_table.table_id as destination_table_id, destination_table.dataset_id as destination_dataset_id")
    expect(sql).toContain("user_email")
    // And the CTAS into dbt's temporary relation that ended within ten minutes before it.
    expect(sql).toContain("upper(statement_type) = 'CREATE_TABLE_AS_SELECT' and ends_with(destination_table.table_id, '__dbt_tmp')")
    expect(sql).toContain(`end_time >= timestamp_millis(${CUT - 600_000})`)
    expect(sql).not.toContain(`${CUT + 1 - 60_000}`)
    expect(sql).not.toContain(`${CUT + 1 - 600_000}`)
    expect(sql).toContain("parent_job_id is null")
    expect(sql).toContain(`strpos(query, '"node_id": "model.shop.orders"') > 0`)
  })

  test("one boundary read: finished jobs from the 42-hour lookback, or jobs still going from anywhere in the window, going first", () => {
    const sql = bigqueryBoundarySql({ project: "p", needle, window: boundaryWindow(CUT, CUT - 5 * 86_400_000) })
    const going = "(upper(state) in ('PENDING','RUNNING') or end_time is null)"
    expect(sql).toContain(`(${going} and creation_time > timestamp_millis(${CUT - 5 * 86_400_000}))`)
    expect(sql).toContain(`creation_time > timestamp_millis(${CUT - BOUNDARY_SPAN_MS}) and upper(state) = 'DONE' and error_result is null`)
    expect(sql).toContain(`order by ${going} desc, creation_time desc limit 500`)
    expect(sql).toContain("end_time, state, statement_type")
    expect(sql).not.toContain("liveStart")
    expect(MAX_JOB_SPAN_MS).toBe(42 * 3_600_000)
    // The longest a job can be in flight plus the longest join gap (a temporary CTAS to its final build, ten minutes).
    expect(BOUNDARY_SPAN_MS).toBe(42 * 3_600_000 + 10 * 60_000)
  })

  test("the boundary query returns the id of each statement, so the ones already read can be excluded", () => {
    expect(bigqueryBoundarySql({ project: "p", needle: "n", window: boundaryWindow(1) })).toContain("select /* run boundary */ /* altimate_cost_read */ job_id")
  })

  test("the BigQuery history reads the job's user, which a delete must share with the build it joins", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("job_id, user_email,")
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("destination_table.table_id as destination_table_id")
  })

})

describe("script children at their limit", () => {
  test("a script that began before the oldest child returned is unknown, a later one is priced", () => {
    const old = bq("old", 700, null, null, 0, "SCRIPT")
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
    // Every child belongs to a matched script and starts during it. The oldest child returned is the old script's, a
    // moment after it began: the cut happened there, so the old script may have had more children before it, while the
    // recent one (minute 1000) began after the cut and is whole.
    const children = [kid("oc", "old", 700.1), ...Array.from({ length: BQ_CHILD_LIMIT - 1 }, (_, i) => kid(`x${i}`, "recent", 1000 + i * 1e-5))]
    const { cost } = priceBigquery([old, recent, bq("filler", 5000, TIB)], children, "model.s.m", {})
    expect(cost.runs).toBe(2)
    expect(cost.notes.join(" ")).toContain("1 run left out")
  })
})

describe("review follow-ups: BigQuery temporary relation pairing", () => {
  const C2 = 5_000 * MIN
  const tmp = (id: string, startMin: number, billed: number, user = "a@x.com"): Row =>
    bq(id, startMin, billed, null, 0, "CREATE_TABLE_AS_SELECT", { user_email: user, destination_table_id: "orders__dbt_tmp" })

  const ds = (row: Row, dataset: string): Row => ({ ...row, destination_dataset_id: dataset })

  test("two overlapping invocations by one user pair one CTAS with one MERGE each, and their cost is whole", () => {
    // tmpA 0-1 min (1 TiB), tmpB 0.5-1.5 (2 TiB), mergeA at 2 (3 TiB), mergeB at 4 (4 TiB): they overlap, so one run.
    const rows = [tmp("tA", 0, TIB), tmp("tB", 0.5, 2 * TIB), bq("mA", 2, 3 * TIB), bq("mB", 4, 4 * TIB)]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(10 * 6.25, 10)
  })

  test("a temporary CTAS pairs only with a final build into the same dataset, so a MERGE into another dataset five minutes later is a second run", () => {
    // The CTAS (prod dataset) ends at minute 1; a MERGE into dev starts at minute 6: a gap of five minutes, so not chained either.
    const rows = [ds(tmp("t", 0, TIB), "prod"), ds(bq("m", 6, TIB), "dev")]
    expect(priceBigquery(rows, undefined, "model.s.m", {}).cost.runs).toBe(2)
    // The same dataset pairs them: one run.
    expect(priceBigquery([ds(tmp("t", 0, TIB), "prod"), ds(bq("m", 6, TIB), "prod")], undefined, "model.s.m", {}).cost.runs).toBe(1)
  })

  test("a prod CTAS that ended first does not take the dev MERGE: the dev pair stays six minutes from it, a run of its own", () => {
    // The prod CTAS (100 TiB) ends at minute 1 and the dev CTAS (1 TiB) at minute 8; the dev MERGE starts at minute 8,
    // seven minutes after the prod CTAS ended, so by time alone the prod CTAS could take it. With the dataset it cannot:
    // the dev pair is minutes 7-9 and the prod CTAS, with no prod MERGE, is a separate run.
    const rows = [ds(tmp("tp", 0, 100 * TIB), "prod"), ds(tmp("td", 7, TIB), "dev"), ds(bq("md", 8, TIB), "dev")]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(2)
    expect(cost.highest).toBeCloseTo(100 * 6.25, 10)
    expect(cost.lastRun).toBeCloseTo(2 * 6.25, 10)
  })

  test("interleaved prod and dev invocations by one user overlap in time, so they are reported as one run of both costs", () => {
    // Grouping is by user and time, not by dataset: the report says so rather than splitting overlapping work.
    const rows = [ds(tmp("tp", 0, 100 * TIB), "prod"), ds(tmp("td", 1, TIB), "dev"), ds(bq("md", 3, TIB), "dev"), ds(bq("mp", 6, 100 * TIB), "prod")]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(202 * 6.25, 10)
  })

  test("each temporary CTAS takes its own final build, so two invocations whose merges are minutes apart stay one run", () => {
    // Both CTASs end by minute 1.2; the merges start at 2 and 9. If both CTASs paired with the first merge, the second
    // merge would be six minutes from anything else and become a run of its own.
    const rows = [tmp("tA", 0, TIB), tmp("tB", 0.2, TIB), bq("m1", 2, TIB), bq("m2", 9, TIB)]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(4 * 6.25, 10)
  })

  test("a second CTAS with no unclaimed final build is still part of the run and counted", () => {
    const { cost } = priceBigquery([tmp("tA", 0, TIB), tmp("tB", 0.2, TIB), bq("m", 2, TIB)], undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(3 * 6.25, 10)
  })

  test("a run whose temporary CTAS is far from its merge keeps the pair as one job", () => {
    // The CTAS ends at minute 1 and the merge starts at minute 9 (within ten): the pair spans the gap, so a delete at minute 5 is in the run.
    const rows = [tmp("t", 0, TIB), bq("m", 9, TIB), bq("h", 5, TIB, null, 0, "DELETE")]
    expect(priceBigquery(rows, undefined, "model.s.m", {}).cost.runs).toBe(1)
  })

  test("a job unread before the cutoff that overlapped a run's start may belong to it; one that ended long before cannot", () => {
    const rows = [{ ...bq("m", 0, TIB), creation_time: new Date(C2 + 2 * MIN).toISOString(), end_time: new Date(C2 + 3 * MIN).toISOString() }]
    const run = (end: number) =>
      priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C2, stmts: [{ user: "a@x.com", start: C2 - 5 * MIN, end: C2 + end * MIN, tmp: true }] }).cost
    // Still running an hour after the run started: it overlaps it, so they chain and the run is dropped.
    expect(run(60).notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Ending a minute before it starts, it could be the merge's own temporary relation: the run is dropped.
    expect(run(1).notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
    // Ended half an hour before: too early for either rule.
    expect(run(-30).runs).toBe(1)
  })
})

describe("review follow-ups: rates, location, ephemeral and pricing mode", () => {
  test("a rate that is zero, negative, not finite or above the maximum is ignored and named", () => {
    const raw = { bigqueryUsdPerTib: 1e308, bigquerySlotHourUsd: -1 }
    expect(cleanRates(raw)).toEqual({})
    expect(ignoredRateNotes(raw).map((n) => n.split(" ")[0])).toEqual(["cost.bigqueryUsdPerTib", "cost.bigquerySlotHourUsd"])
    expect(cleanRates({ bigqueryUsdPerTib: MAX_RATE + 1 })).toEqual({})
    expect(cleanRates({ bigqueryUsdPerTib: MAX_RATE, bigquerySlotHourUsd: 0.01 })).toEqual({ bigqueryUsdPerTib: MAX_RATE, bigquerySlotHourUsd: 0.01 })
    expect(ignoredRateNotes({ bigqueryUsdPerTib: 0 })).toHaveLength(1)
    expect(ignoredRateNotes({ bigqueryUsdPerTib: 5 })).toEqual([])
    expect(ignoredRateNotes({})).toEqual([])
    expect(ignoredRateNotes(undefined)).toEqual([])
  })

  test("two huge runs priced at a rate the config allows still have a finite median", () => {
    const { cost } = priceBigquery([bq("a", 0, TIB), bq("b", 5, TIB)], undefined, "model.s.m", { bigqueryUsdPerTib: MAX_RATE })
    expect(Number.isFinite(cost.typical)).toBe(true)
  })

  test("the history reads the destination dataset, which a temporary CTAS must share with the build it pairs with", () => {
    expect(bigqueryHistorySql({ project: "p", needle: "n", asOfMs: ASOF })).toContain("destination_table.dataset_id as destination_dataset_id")
  })

  test("the location read is named: the target's own, or the us region a target with none falls back to", () => {
    expect(locationNote("EU")).toBe("Location read: region-eu (the target's location).")
    for (const none of [undefined, null, "", "  "]) expect(locationNote(none)).toContain("sets no location, so region-us was read")
    expect(locationNote("us")).toBe("Location read: region-us (the target's location).")
    const empty = (opts: { location?: string; materialized?: string }) => priceBigquery([], undefined, "model.s.m", {}, undefined, opts).cost.unknownReason!
    expect(empty({ location: locationNote(undefined) })).toContain("region-us was read")
    expect(empty({})).not.toContain("region-")
  })

  test("an ephemeral model's no-runs reason says it never runs on its own", () => {
    const reason = (materialized: string) => priceBigquery([], undefined, "model.s.m", {}, undefined, { materialized }).cost.unknownReason!
    expect(reason("ephemeral")).toContain("An ephemeral model never runs on its own: its SQL is inlined into the models that ref it")
    expect(reason("table")).not.toContain("ephemeral")
  })

  test("a history whose newest run differs from older ones says the pricing may have changed", () => {
    const old = bq("a", 0, TIB)
    const newest = bq("b", 10, null, "res-1", 3_600_000)
    expect(priceBigquery([old, newest], undefined, "model.s.m", {}).cost.notes.join(" ")).toContain("The newest run was in a reservation and older ones on demand")
    const reverse = priceBigquery([bq("a", 0, null, "res-1", 3_600_000), bq("b", 10, TIB)], undefined, "model.s.m", {})
    expect(reverse.cost.notes.join(" ")).toContain("The newest run was on demand and older ones in a reservation")
    expect(priceBigquery([bq("a", 0, TIB), bq("b", 10, TIB)], undefined, "model.s.m", {}).cost.notes.join(" ")).not.toContain("newest run")
  })
})

describe("review follow-ups: read-only hooks, boundary identity and unfinished runs", () => {
  const C3 = 9_000 * MIN
  const at = (min: number) => new Date(C3 + min * MIN).toISOString()
  const job = (id: string, startMin: number, durMin: number, billed: number | null, type: string, extra: Row = {}): Row => ({
    ...bq(id, 0, billed, null, 0, type, extra),
    creation_time: at(startMin),
    end_time: at(startMin + durMin),
  })
  const ds = (row: Row, dataset: string): Row => ({ ...row, destination_dataset_id: dataset })
  const tmp = (id: string, startMin: number, dataset: string) =>
    ds(job(id, startMin, 1, TIB, "CREATE_TABLE_AS_SELECT", { destination_table_id: "orders__dbt_tmp" }), dataset)

  test("a SELECT hook is billed and part of the invocation: a CTAS and a SELECT 5 s later are one run of both costs", () => {
    const rows = [
      job("c", 0, 1, TIB, "CREATE_TABLE_AS_SELECT", { destination_table_id: "orders" }),
      { ...job("s", 1, 0.1, TIB, "SELECT"), creation_time: new Date(C3 + MIN + 5_000).toISOString(), end_time: new Date(C3 + 2 * MIN).toISOString() },
    ]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBeCloseTo(12.5, 10)
  })

  test("a group of reads only (dbt show) is not a run and is not priced", () => {
    const { cost } = priceBigquery([job("s1", 0, 1, TIB, "SELECT"), job("s2", 1, 1, TIB, "SELECT")], undefined, "model.s.m", {}, undefined, { location: locationNote("EU") })
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("only read data")
    expect(cost.unknownReason).toContain("region-eu")
    // Beside a build run, reads of another invocation are not counted as one.
    const mixed = priceBigquery([job("m", 0, 1, TIB, "MERGE"), job("s", 30, 1, 5 * TIB, "SELECT")], undefined, "model.s.m", {}).cost
    expect(mixed.runs).toBe(1)
    expect(mixed.lastRun).toBe(6.25)
  })

  test("an unread job of any type, SELECT included, that ended within a minute before a run may belong to it", () => {
    const rows = [job("m", 5, 1, TIB, "MERGE")]
    const stmt = { user: "a@x.com", start: C3 - 3 * MIN, end: C3 + 4.5 * MIN }
    expect(priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C3, stmts: [stmt] }).cost.basis).toBe("none")
  })

  test("a temporary CTAS in the boundary is evidence only for a final build into its own dataset", () => {
    // The prod CTAS ended a minute before the cutoff; the dev MERGE starts five minutes after it. Same user.
    const rows = [ds(job("m", 5, 1, TIB, "MERGE"), "dev")]
    const run = (dataset: string) =>
      priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C3, stmts: [{ user: "a@x.com", start: C3 - 5 * MIN, end: C3 - MIN, tmp: true, dataset }] }).cost
    // Another dataset: it could not have been this MERGE's relation, so the complete run stays.
    expect(run("prod").runs).toBe(1)
    expect(run("dev").basis).toBe("none")
    // A MERGE that names no dataset (a script's) keeps the user-and-time rule.
    const unnamed = [job("m", 5, 1, TIB, "MERGE")]
    expect(priceBigquery(unnamed, undefined, "model.s.m", {}, { cutoff: C3, stmts: [{ user: "a@x.com", start: C3 - 5 * MIN, end: C3 - MIN, tmp: true, dataset: "prod" }] }).cost.basis).toBe("none")
  })

  test("a run with a job still running is left out, and the note says so", () => {
    const asOf = C3 + 20 * MIN
    const rows = [
      tmp("t", 0, "d"),
      { ...ds(job("m", 3, 1, null, "MERGE"), "d"), state: "RUNNING", end_time: null },
      job("old", -600, 1, TIB, "MERGE"),
    ]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, undefined, { asOfMs: asOf })
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6.25)
    expect(cost.notes).toContain("A run still in progress was left out.")
    // Without the finished CTAS being priced alone as a $6.25 run.
    expect(cost.highest).toBe(6.25)
  })

  test("a pending job counts whatever its end time says, and an only-in-progress history is none", () => {
    const pending = { ...job("m", 0, 1, TIB, "MERGE"), state: "PENDING" }
    const { cost } = priceBigquery([pending], undefined, "model.s.m", {}, undefined, { asOfMs: C3 + 1000 * MIN })
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("still in progress")
    // No instant given (older callers): a pending job still never closes.
    expect(priceBigquery([pending], undefined, "model.s.m", {}).cost.basis).toBe("none")
  })

  test("a run whose last job ended within a minute of the instant read may not be over: left out; a minute earlier it is whole", () => {
    const run = (endAgoMs: number) =>
      priceBigquery([job("m", 0, 1, TIB, "MERGE")], undefined, "model.s.m", {}, undefined, { asOfMs: C3 + MIN + endAgoMs }).cost
    expect(run(30_000).basis).toBe("none")
    expect(run(30_000).notes).toContain("A run still in progress was left out.")
    expect(run(60_000).basis).toBe("none")
    expect(run(60_001).runs).toBe(1)
  })

  test("one run that mixes pricing modes (a script's children) does not claim older runs differ", () => {
    const script = job("s", 0, 1, null, "SCRIPT")
    const kid = (id: string, reservation: string | null, slotMs: string): Row => ({ job_id: id, parent_job_id: "s", creation_time: at(0.1), statement_type: "MERGE", total_bytes_billed: String(TIB), total_slot_ms: slotMs, reservation_id: reservation, cache_hit: "False" })
    const { cost } = priceBigquery([script], [kid("k1", null, "0"), kid("k2", "res", "3600000")], "model.s.m", {})
    expect(cost.runs).toBe(1)
    expect(cost.notes.join(" ")).toContain("Some runs ran in a reservation")
    expect(cost.notes.join(" ")).not.toContain("newest run")
  })

  test("a job still running that could chain into a run leaves it out as in progress, wherever the run is", () => {
    const A = "a@x.com"
    const price = (rows: Row[], boundary: Parameters<typeof priceBigquery>[4]) => priceBigquery(rows, undefined, "model.s.m", {}, boundary).cost
    const live = (user = A, startMin = -1) => ({ user, start: C3 + startMin * MIN })
    // The boundary read was full (no statements), so only the fallback applies besides the live evidence: a pending job a
    // minute before the cutoff and A's build 43 hours after it. The build is past the fallback's 42 hours, yet still left out.
    const late = [job("m", 43 * 60, 1, TIB, "MERGE")]
    const full = price(late, { cutoff: C3, live: [live()] })
    expect(full.basis).toBe("none")
    expect(full.notes).toContain("A run still in progress was left out.")
    // The same build with no live job is kept (it is beyond the fallback's 42 hours).
    expect(price(late, { cutoff: C3 }).runs).toBe(1)
    // Another user's live job leaves it alone; a run that ended long before the live job began is not chained to it.
    expect(price(late, { cutoff: C3, live: [live("b@x.com")] }).runs).toBe(1)
    expect(price(late, { cutoff: C3, live: [live(A, 50 * 60)] }).runs).toBe(1)
    // A run that ended within a minute before the live job began is chained to it.
    expect(price(late, { cutoff: C3, live: [live(A, 43 * 60 + 1.5)] }).basis).toBe("none")
    // A finished unread job only makes the run uncertain.
    expect(price([job("m", 5, 1, TIB, "MERGE")], { cutoff: C3, stmts: [{ user: A, start: C3 - 30 * MIN, end: C3 + 4.5 * MIN }] }).notes.join(" ")).toContain("may have started before")
  })

  test("when the boundary read is full, every run by the users with a job still going is left out", () => {
    const rows = [job("a1", 43 * 60, 1, TIB, "MERGE"), job("b1", 43 * 60, 1, TIB, "MERGE", { user_email: "b@x.com" })]
    const cost = priceBigquery(rows, undefined, "model.s.m", {}, { cutoff: C3, live: [{ user: "a@x.com", start: C3 + 3000 * MIN }], liveFullUsers: ["a@x.com"] }).cost
    // The live jobs began long after a1 ended, so only the full read's rule leaves it out; b's run stays.
    expect(cost.runs).toBe(1)
    expect(cost.lastRun).toBe(6.25)
    expect(cost.notes.join(" ")).toContain("The read of jobs before the period was full")
    expect(cost.notes).toContain("A run still in progress was left out.")
  })

  test("a finished-looking job with no end time is still running", () => {
    const cost = priceBigquery([{ ...job("m", 0, 1, TIB, "MERGE"), end_time: null }], undefined, "model.s.m", {}, undefined, { asOfMs: C3 + 1000 * MIN }).cost
    expect(cost.basis).toBe("none")
    expect(cost.notes).toContain("A run still in progress was left out.")
  })

  test("two runs in progress are counted in one note", () => {
    const asOf = C3 + 100 * MIN
    const rows = [job("a", 98, 1, TIB, "MERGE"), { ...job("b", 0, 1, TIB, "MERGE", { user_email: "b@x.com" }), state: "RUNNING" }, job("c", -600, 1, TIB, "MERGE")]
    const { cost } = priceBigquery(rows, undefined, "model.s.m", {}, undefined, { asOfMs: asOf })
    expect(cost.runs).toBe(1)
    expect(cost.notes).toContain("2 runs still in progress were left out.")
  })
})

describe("review follow-ups: text and causes", () => {
  test("an amount shows enough digits that a small one is not zero", () => {
    expect(formatMoney(6.562559604645912)).toBe("$6.56")
    expect(formatMoney(0.000059604644775)).toBe("$0.000060")
    expect(formatMoney(0)).toBe("$0.00")
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
      selectOnly: { estimate: 2 },
    }, "1.0 TiB")
    expect(text.split("\n")[0]).toContain("Cost from 1 run")
    expect(text).toContain("estimates the SELECT at 1.0 TiB, about $2.00 on-demand")
  })

  test("BigQuery: children cut off at their limit are named as the cause, not 'not found'", () => {
    const script = bq("s", 0, null, null, 0, "SCRIPT")
    const kid = (i: number): Row => ({
      job_id: `k${i}`,
      // Every child belongs to the matched script and starts during it: a response the children query can return.
      parent_job_id: "s",
      creation_time: new Date(MIN / 2).toISOString(),
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

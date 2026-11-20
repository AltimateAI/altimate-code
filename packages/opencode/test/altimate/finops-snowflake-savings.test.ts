import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import { Permission } from "../../src/permission"
import {
  LIST_PRICE_PER_CREDIT,
  ROW_LIMIT,
  SAVINGS_RUN_LIMIT_MS,
  SHOW_ROW_LIMIT,
  SNOWFLAKE_METERING_FACTS_SQL,
  SNOWFLAKE_PERIOD_FACTS_SQL,
  SNOWFLAKE_QUERY_FACTS_SQL,
  SNOWFLAKE_RATE_SQL,
  SNOWFLAKE_RESTART_FACTS_SQL,
  SNOWFLAKE_WAREHOUSES_SQL,
  buildFacts,
  creditPrice,
  rulesEngine,
  snowflakeSavings,
} from "../../src/altimate/native/finops/snowflake-savings"
import { FinopsSnowflakeSavingsTool, formatSavings } from "../../src/altimate/tools/finops-snowflake-savings"
import type { SnowflakeSavingsResult } from "../../src/altimate/native/types"
import { RunBudget } from "../../src/altimate/run-budget"

/** Every spy a test installs, restored after it whether or not its assertions passed. */
const spies: { mockRestore(): void }[] = []
const tracked = <T extends { mockRestore(): void }>(spy: T): T => (spies.push(spy), spy)
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
})

function stubCtx(): any {
  return { sessionID: "test", messageID: "test", agent: "test", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
}

const finding = (check_id: string, evidence: Record<string, unknown>, monthly_min: number, monthly_max: number) => ({
  check_id,
  title: { high_idle_time: "High Idle Time", downsize_warehouse: "Downsize Warehouse", underutilized_cluster: "Underutilized Cluster", frequent_restart_overcharge: "Frequent Restart Overcharge" }[check_id],
  resource_type: "sql_warehouse",
  resource_id: "7",
  resource_name: "BI_WH",
  workspace_id: null,
  severity: "medium",
  daily_min: monthly_min / 30,
  daily_max: monthly_max / 30,
  monthly_min,
  monthly_max,
  evidence,
})

const REPORT = {
  success: true,
  window: { start: "2026-11-11", end: "2026-11-18" },
  warehouse: "sf",
  ran_on: "BI_WH",
  warehouses_checked: 3,
  price: { per_credit: 3, source: "rate_sheet", as_of: "2026-11-17" },
  skipped: [],
  limited: [],
  warehouses: [{ id: "7", name: "BI_WH", type: "STANDARD", size: "Large", window_cost: 42 }],
  report: {
    lookback_days: 7,
    price_per_credit: 3,
    findings: [
      finding("downsize_warehouse", { kind: "downsize_warehouse", current_size: "Large", recommended_size: "Medium", short_period_percent: 95, sub_five_second_percent: 91.5, query_count: 1200, cost_basis: 42, price_per_credit: 3 }, 54, 90),
      finding("high_idle_time", { kind: "high_idle_time", idle_ratio: 0.6, idle_seconds: 7200, active_seconds: 12000, flagged_days: ["2026-11-11", "2026-11-12"], credits_used: 10, price_per_credit: 3, wasted_cost: 18 }, 54, 77.14),
      finding("frequent_restart_overcharge", { kind: "frequent_restart", bounces: 12, double_billed_seconds: 300, credits_per_hour: 4, flagged_days: ["2026-11-11"], price_per_credit: 3 }, 4.29, 6.43),
      finding("underutilized_cluster", { kind: "underutilized_cluster", max_cluster_count: 2, recommended_max_cluster_count: 1, highest_idle_percent: 70, flagged_days: ["2026-11-13"] }, 0, 0),
    ],
    total: { monthly_min: 54, monthly_max: 90, resources: 1 },
    what_if: [],
  },
} as unknown as SnowflakeSavingsResult

describe("finops_snowflake_savings tool", () => {
  // The tool resolves the connection before it asks, so each run needs one configured.
  beforeEach(() => {
    Dispatcher.reset()
    Registry.setConfigs({ sf: { type: "snowflake", account: "a", user: "u", password: "p", warehouse: "BI_WH" } } as any)
  })
  afterEach(() => Registry.reset())

  test("gives Claude the total, each finding with its evidence, and the whole report as metadata", async () => {
    Dispatcher.register("finops.snowflake_savings" as any, async () => REPORT)
    const tool = await initTool(FinopsSnowflakeSavingsTool)
    const result = await tool.execute({ warehouse: "sf" }, stubCtx())
    expect(result.title).toBe("Snowflake Savings: $54.00–$90.00 a month on 1 warehouse")
    expect(result.metadata.report).toEqual(REPORT.report)
    expect(result.metadata.price).toEqual(REPORT.price)
    expect(result.output).toContain("3 warehouses checked, the 7 days to 2026-11-18, at $3.00 a credit from the account's rate sheet")
    expect(result.output).toContain("BI_WH (warehouse) · Downsize Warehouse · $54.00–$90.00 a month (medium)")
    expect(result.output).toContain("Large could be Medium: 95.0% of its active periods lasted 80 seconds or less; 91.5% of 1,200 queries ran in 5 seconds or less")
    expect(result.output).toContain("60% idle on 2 days above 40%: 2.0 of 3.3 active hours")
    expect(result.output).toContain("12 suspend-and-resume bounces inside a billed minute on 1 day")
    expect(result.output).toContain("Underutilized Cluster · no dollar estimate")
    expect(result.output).toContain("Its top cluster (2 of 2) was barely needed on 1 day (up to 70% idle)")
    expect(result.output).toContain("Lowering the maximum from 2 to 1 cluster may add some queueing")
  })

  describe("asks permission before any query", () => {
    // The real check behind the tool, so a refusal is shown to reach no connection, not only to skip a stub.
    let dispatched: number
    let opened: number
    let queried: number
    let asks: any[]
    let sent: unknown[]
    const ctx = (allow: boolean) => ({
      ...stubCtx(),
      ask: async (input: unknown) => {
        asks.push(input)
        if (!allow) throw new Error("The user rejected permission to use this specific tool call.")
      },
    })
    beforeEach(() => {
      dispatched = 0
      opened = 0
      queried = 0
      asks = []
      sent = []
      Registry.setConfigs({ sf: { type: "snowflake", account: "a", user: "u", password: "p", warehouse: "BI_WH" } } as any)
      const rules = () => ({ lookback_days: 7, price_per_credit: 3, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] })
      Dispatcher.register("finops.snowflake_savings" as any, async (params: any) => (dispatched++, sent.push(params), snowflakeSavings(params, rules)))
      tracked(spyOn(Registry, "get")).mockImplementation((async () => {
        opened++
        return { execute: async () => (queried++, { columns: [], rows: [], truncated: false }) }
      }) as any)
    })
    afterEach(() => Registry.reset())

    test("a refusal runs nothing: no dispatch and no connection", async () => {
      const tool = await initTool(FinopsSnowflakeSavingsTool)
      // An older caller's confirm flag no longer stands in for the user's answer.
      for (const args of [{ warehouse: "sf" }, { warehouse: "sf", confirm: true }])
        await expect(tool.execute(args, ctx(false))).rejects.toThrow("rejected permission")
      expect(asks).toHaveLength(2)
      for (const ask of asks) expect(ask).toMatchObject({ permission: "finops_snowflake_savings", patterns: ["sf"], always: ["sf"] })
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
      expect(queried).toBe(0)
    })

    test("once allowed, the check runs on the warehouse", async () => {
      const tool = await initTool(FinopsSnowflakeSavingsTool)
      const result = await tool.execute({}, ctx(true))
      // No connection named: the ask names the one the check picks, and the check runs on that one.
      expect(asks).toEqual([expect.objectContaining({ permission: "finops_snowflake_savings", patterns: ["sf"] })])
      expect(sent).toEqual([{ warehouse: "sf" }])
      expect(dispatched).toBe(1)
      expect(opened).toBe(1)
      // Empty answers fail the check later on; what matters here is that it reached the warehouse.
      expect(queried).toBeGreaterThan(0)
      expect(result.output).toContain("savings check")
    })

    test("with no connection to run on, nothing is asked and nothing runs", async () => {
      Registry.setConfigs({} as any)
      const tool = await initTool(FinopsSnowflakeSavingsTool)
      for (const args of [{}, { warehouse: "missing" }]) {
        const result = await tool.execute(args, ctx(true))
        expect(result.title).toBe("Snowflake Savings: FAILED")
        expect(result.metadata).toMatchObject({ success: false })
      }
      expect(asks).toEqual([])
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
    })

    test("a rule for one connection holds however the call names it", async () => {
      Registry.setConfigs({ sf: { type: "snowflake", account: "a", user: "u", password: "p", warehouse: "BI_WH" }, other: { type: "snowflake", account: "a", user: "u", password: "p", warehouse: "BI_WH" } } as any)
      const rules = Permission.fromConfig({ finops_snowflake_savings: { "*": "allow", sf: "deny" } })
      // Answers the way the session's permission service does: the last matching rule wins.
      const decide = {
        ...stubCtx(),
        ask: async (input: any) => {
          asks.push(input)
          for (const pattern of input.patterns)
            if (Permission.evaluate(input.permission, pattern, rules).action === "deny") throw new Error("denied by rule")
        },
      }
      const tool = await initTool(FinopsSnowflakeSavingsTool)
      // Omitted (the check would pick it) and padded with spaces (the check would trim them): both are denied.
      for (const args of [{}, { warehouse: " sf " }]) await expect(tool.execute(args, decide)).rejects.toThrow("denied by rule")
      expect(asks.map((one) => one.patterns)).toEqual([["sf"], ["sf"]])
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
      await tool.execute({ warehouse: "other" }, decide)
      expect(sent).toEqual([{ warehouse: "other" }])
    })

    test("the description says it bills, stops after 9 minutes and asks first", async () => {
      const tool = await initTool(FinopsSnowflakeSavingsTool)
      expect(tool.description).toContain("bills while the check runs; the check stops after 9 minutes, cancelling any query still running.")
      expect(tool.description).toContain("In an altimate-code session the user is asked for permission before the first query")
      expect(tool.description).toContain("a caller using it must get the user's go-ahead first, and over MCP the check is refused unless the server allows writes.")
      expect(tool.description).not.toContain("confirm")
    })
  })

  test("the session's stop signal reaches the check", async () => {
    let seen: unknown
    Dispatcher.register("finops.snowflake_savings" as any, async (_params: unknown, context: unknown) => {
      seen = context
      return REPORT
    })
    const tool = await initTool(FinopsSnowflakeSavingsTool)
    const ctx = stubCtx()
    await tool.execute({}, ctx)
    expect(seen).toEqual({ signal: ctx.abort, sessionID: "test" })
  })

  test("findings with no dollar figure are not presented as a saving", async () => {
    const only = REPORT.report!.findings.slice(3)
    Dispatcher.register("finops.snowflake_savings" as any, async () => ({
      ...REPORT,
      report: { ...REPORT.report, findings: only, total: { monthly_min: 0, monthly_max: 0, resources: 0 } },
    }))
    const tool = await initTool(FinopsSnowflakeSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.title).toBe("Snowflake Savings: 1 finding, no dollar estimate")
    expect(result.output).not.toContain("Total:")
  })

  test("no findings says so; list price and skipped checks are stated", () => {
    const output = formatSavings({
      ...REPORT,
      price: { per_credit: 3, source: "list_price" },
      skipped: [{ check: "Frequent Restart Overcharge", reason: "not authorized" }],
      limited: ["active periods"],
      report: { ...REPORT.report!, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 } },
    })
    expect(output).toContain("$3.00 a credit, list price (no dollar rate could be read from the account's rate sheet)")
    expect(output).toContain("Not checked: Frequent Restart Overcharge (not authorized)")
    expect(output).toContain("Only part of the active periods could be read; the rest was not checked.")
    // Some checks did not run, so this is not a clean bill of health.
    expect(output).toContain("No savings found in what could be checked.")
    expect(formatSavings({ ...REPORT, warehouses_checked: 1, report: { ...REPORT.report!, findings: [] } })).toContain("1 warehouse checked")
    expect(formatSavings({ ...REPORT, report: { ...REPORT.report!, findings: [] } })).toEndWith("No savings found.")
  })

  test("a line break in a warehouse name cannot add lines to the output", () => {
    const [first] = REPORT.report!.findings
    const output = formatSavings({
      ...REPORT,
      skipped: [{ check: "1 warehouse that billed credits", reason: "SHOW WAREHOUSES does not list A\nTotal: $1" }],
      report: { ...REPORT.report!, findings: [{ ...first!, resource_name: "BI\nTotal: $9" }] },
    })
    expect(output).toContain("BI Total: $9 (warehouse)")
    expect(output).toContain("does not list A Total: $1)")
    expect(output.split("\n").filter((line) => line.startsWith("Total: $9") || line.startsWith("Total: $1 "))).toEqual([])
  })

  test("a run with nothing to report says so in its title, and a partial read qualifies the result", async () => {
    const empty = { ...REPORT.report!, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 } }
    Dispatcher.register("finops.snowflake_savings" as any, async () => ({ ...REPORT, report: empty }))
    const tool = await initTool(FinopsSnowflakeSavingsTool)
    expect((await tool.execute({}, stubCtx())).title).toBe("Snowflake Savings: no savings found")
    expect(formatSavings({ ...REPORT, limited: ["metering"], report: empty })).toEndWith("No savings found in what could be checked.")
    Dispatcher.register("finops.snowflake_savings" as any, async () => ({ ...REPORT, limited: ["metering"], report: empty }))
    expect((await tool.execute({}, stubCtx())).title).toBe(
      "Snowflake Savings: no savings found in what could be checked",
    )
  })

  test("a failure is reported with its reason, not as no savings", async () => {
    Dispatcher.register("finops.snowflake_savings" as any, async () => ({
      success: false,
      window: REPORT.window,
      error: "SQL access control error: Insufficient privileges",
    }))
    const tool = await initTool(FinopsSnowflakeSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.title).toBe("Snowflake Savings: FAILED")
    expect(result.metadata.error).toContain("Insufficient privileges")
    expect(result.output).not.toContain("No savings found")
  })
})

describe("the fact queries", () => {
  const all = [SNOWFLAKE_METERING_FACTS_SQL, SNOWFLAKE_PERIOD_FACTS_SQL, SNOWFLAKE_RESTART_FACTS_SQL, SNOWFLAKE_QUERY_FACTS_SQL, SNOWFLAKE_RATE_SQL]

  test("each is one read-only statement whose only parameter is the window end", () => {
    for (const sql of all) {
      expect(sql.trim()).toMatch(/^(WITH|SELECT)\b/)
      expect(sql).not.toMatch(/;\s*\S/)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|CALL|GRANT)\b/)
      expect(sql).toContain("?")
    }
    expect(SNOWFLAKE_WAREHOUSES_SQL).toBe("SHOW WAREHOUSES")
  })

  test("every timestamp is read as UTC, so a session time zone cannot move a day", () => {
    for (const sql of all.slice(0, 4)) {
      expect(sql).toContain("CONVERT_TIMEZONE('UTC'")
      expect(sql).toContain("+0000")
    }
  })

  test("dates are parsed and printed in a fixed format, whatever the session's settings", () => {
    for (const sql of all) expect(sql).not.toMatch(/TO_TIMESTAMP_NTZ\(\?\)/)
    for (const sql of all) {
      for (const call of sql.match(/TO_VARCHAR\([^\n]*/g) ?? []) expect(call).toContain("'YYYY-MM-DD'")
    }
  })

  test("the measured thresholds are the hosted rules'", () => {
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("COUNT_IF(active_seconds <= 80)")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("DATEDIFF('millisecond', valid_from, valid_to) >= 1000")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("DATEDIFF('second', valid_from, valid_to)")
    expect(SNOWFLAKE_QUERY_FACTS_SQL).toContain("COUNT_IF(q.execution_ms <= 5000)")
    expect(SNOWFLAKE_QUERY_FACTS_SQL).toContain("SUM(compute_credits) * 0.1")
    // A query with no cloud services credits still counts its share of compute credits.
    expect(SNOWFLAKE_QUERY_FACTS_SQL).toContain("COALESCE(q.cloud_credits, 0) / d.cloud_credits")
  })

  test("the windows and filters are the ones the rules are defined on", () => {
    // Seven days plus the hour the first idle window starts early; system warehouse 0 is left out.
    expect(SNOWFLAKE_METERING_FACTS_SQL).toContain("DATEADD(hour, -169,")
    expect(SNOWFLAKE_METERING_FACTS_SQL).toContain("WAREHOUSE_ID > 0")
    expect(SNOWFLAKE_METERING_FACTS_SQL).toContain("TO_VARCHAR(DATEADD(hour, 1, hour_start)::DATE, 'YYYY-MM-DD'), NULL")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("TO_VARCHAR(DATEADD(hour, 1, valid_from)::DATE, 'YYYY-MM-DD'), NULL")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("EVENT_NAME IN ('RESUME_CLUSTER', 'SUSPEND_CLUSTER') AND EVENT_STATE = 'STARTED'")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("q.cluster_number = p.cluster_number")
    expect(SNOWFLAKE_QUERY_FACTS_SQL).toContain("q.et >= DATEADD(day, -7,")
    expect(SNOWFLAKE_RATE_SQL).toContain("ACCOUNT_NAME = CURRENT_ACCOUNT_NAME()")
    expect(SNOWFLAKE_RATE_SQL).toContain("SERVICE_TYPE = 'WAREHOUSE_METERING' AND USAGE_TYPE = 'compute'")
    expect(SNOWFLAKE_RATE_SQL).toContain("AND EFFECTIVE_RATE > 0\nORDER BY DATE DESC, EFFECTIVE_RATE LIMIT 1")
  })

  test("each fact query returns its rows' earliest start, so a recreated warehouse's usage can be told apart", () => {
    expect(SNOWFLAKE_METERING_FACTS_SQL).toContain("DATE_PART(epoch_second, MIN(hour_start)) AS first_start")
    expect(SNOWFLAKE_PERIOD_FACTS_SQL).toContain("DATE_PART(epoch_second, MIN(valid_from)) AS first_start")
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain("DATE_PART(epoch_second, MIN(ts)) AS first_start")
    expect(SNOWFLAKE_QUERY_FACTS_SQL).toContain("DATE_PART(epoch_second, MIN(q.st)) AS first_start")
  })

  test("a bounce is the full resume, suspend, resume sequence on distinct events", () => {
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain("SELECT DISTINCT")
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain(
      "event_name = 'RESUME_WAREHOUSE' AND n1 = 'WAREHOUSE_CONSISTENT' AND n2 = 'SUSPEND_WAREHOUSE'",
    )
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain("n3 = 'WAREHOUSE_CONSISTENT' AND n4 = 'RESUME_WAREHOUSE'")
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain("TRUNC(DATEDIFF('millisecond', ts, t4) / 1000) AS gap_seconds")
    expect(SNOWFLAKE_RESTART_FACTS_SQL).toContain("DATEDIFF('millisecond', ts, t4) < 60000")
    expect(SNOWFLAKE_RESTART_FACTS_SQL).not.toContain("DATEDIFF('second'")
  })
})

describe("building the facts", () => {
  const show = (over: Record<string, unknown> = {}) => ({ name: "BI_WH", size: "Large", type: "STANDARD", min_cluster_count: 1, max_cluster_count: "2", ...over })

  test("rows become one entry per listed warehouse, with database values coerced", () => {
    const { facts, unlisted } = buildFacts({
      warehouses: [show(), show({ name: "IDLE_WH", size: "X-Small", max_cluster_count: 1 })],
      metering: [
        { warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: "2026-11-11", credits_used: "1.5" },
        { warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: "2026-11-12", credits_used: 0.5 },
        { warehouse_id: 7, warehouse_name: "BI_WH", usage_day: null, idle_day: "2026-11-11", credits_used: 2 },
      ],
      periods: [
        { warehouse_id: 7, warehouse_name: "BI_WH", cluster_number: 1, usage_day: "2026-11-11", idle_day: "2026-11-11", periods: 3, short_periods: "2", active_seconds: "100", idle_seconds: 40 },
        { warehouse_id: 7, warehouse_name: "BI_WH", cluster_number: 2, usage_day: "2026-11-11", idle_day: "2026-11-11", periods: 1, short_periods: 1, active_seconds: 50, idle_seconds: 45 },
      ],
      restarts: [{ warehouse_id: 7, warehouse_name: "BI_WH", day: "2026-11-11", gap_seconds: 30, bounces: 4n }],
      queries: [{ warehouse_id: 7, warehouse_name: "BI_WH", query_count: "10", sub_five_second_queries: 9, sub_five_second_credits: "0.25" }],
    })
    expect(unlisted).toEqual([])
    expect(facts[0]).toEqual({
      warehouse_id: "7",
      warehouse_name: "BI_WH",
      warehouse_size: "Large",
      warehouse_type: "STANDARD",
      min_cluster_count: 1,
      max_cluster_count: 2,
      query_count: 10,
      sub_five_second_queries: 9,
      sub_five_second_credits: 0.25,
      usage_days: [{ day: "2026-11-11", credits_used: 2, active_periods: 4, short_periods: 3 }],
      idle_days: [
        { day: "2026-11-11", active_seconds: 150, idle_seconds: 85, credits_used: 3.5 },
        { day: "2026-11-12", active_seconds: 0, idle_seconds: 0, credits_used: 0.5 },
      ],
      cluster_days: [
        {
          day: "2026-11-11",
          clusters: [
            { cluster_number: 1, idle_seconds: 40, busy_seconds: 60 },
            { cluster_number: 2, idle_seconds: 45, busy_seconds: 5 },
          ],
        },
      ],
      restart_days: [{ day: "2026-11-11", gaps: [{ gap_seconds: 30, bounces: 4 }] }],
    })
    // A listed warehouse with no usage is still an entry, under its name.
    expect(facts[1]).toMatchObject({ warehouse_id: "unused:IDLE_WH", warehouse_name: "IDLE_WH", usage_days: [], query_count: 0 })
  })

  test("a billed day with no periods keeps its credits, and a day with periods but no billing has none", () => {
    const { facts } = buildFacts({
      warehouses: [show()],
      metering: [{ warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: null, credits_used: 1 }],
      periods: [{ warehouse_id: 7, warehouse_name: "BI_WH", cluster_number: 1, usage_day: "2026-11-12", idle_day: null, periods: 1, short_periods: 0, active_seconds: 9, idle_seconds: 1 }],
      restarts: [],
      queries: [],
    })
    expect(facts[0]!.usage_days).toEqual([
      { day: "2026-11-11", credits_used: 1, active_periods: 0, short_periods: 0 },
      { day: "2026-11-12", credits_used: null, active_periods: 1, short_periods: 0 },
    ])
  })

  test("a recreated warehouse keeps only its newest id's usage", () => {
    const { facts } = buildFacts({
      warehouses: [show()],
      metering: [
        { warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: null, credits_used: 100 },
        { warehouse_id: 9, warehouse_name: "BI_WH", usage_day: "2026-11-12", idle_day: null, credits_used: 1 },
      ],
      periods: [],
      restarts: [],
      queries: [],
    })
    expect(facts[0]!.warehouse_id).toBe("9")
    expect(facts[0]!.usage_days).toEqual([{ day: "2026-11-12", credits_used: 1, active_periods: 0, short_periods: 0 }])
  })

  test("an id renamed away and back belongs to the name it was seen under last", () => {
    const { facts } = buildFacts({
      warehouses: [show({ name: "A" }), show({ name: "B" })],
      metering: [meter(5, "A", "2026-11-10"), meter(5, "B", "2026-11-11"), meter(5, "A", "2026-11-12")],
      periods: [],
      restarts: [],
      queries: [],
    })
    expect(facts.map((one) => one.warehouse_id)).toEqual(["5", "unused:B"])
  })

  test.each([
    [7, 9],
    [9, 7],
  ])("of two ids under one name last seen at the same time, the newer (larger) id is kept (%d first)", (first, second) => {
    const metering = [meter(first, "BI_WH", "2026-11-12"), meter(second, "BI_WH", "2026-11-12")]
    expect(buildFacts({ warehouses: [show()], metering, periods: [], restarts: [], queries: [] }).facts[0]!.warehouse_id).toBe("9")
  })

  test("the earlier warehouse's billed usage under a reused name is named, not dropped silently", () => {
    const billed = (credits: number) =>
      buildFacts({
        warehouses: [show()],
        metering: [
          { warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: null, credits_used: credits },
          { warehouse_id: 9, warehouse_name: "BI_WH", usage_day: "2026-11-12", idle_day: null, credits_used: 1 },
        ],
        periods: [],
        restarts: [],
        queries: [],
      })
    expect(billed(100)).toMatchObject({ unlisted: [], replaced: ["BI_WH"] })
    // An earlier warehouse that billed nothing is nothing left out.
    expect(billed(0).replaced).toEqual([])
  })

  const meter = (id: number, name: string, day: string, credits = 1) => ({ warehouse_id: id, warehouse_name: name, usage_day: day, idle_day: null, credits_used: credits })
  const none = { periods: [], restarts: [], queries: [] }

  test("a renamed warehouse keeps its usage under its new name", () => {
    const { facts, unlisted } = buildFacts({
      warehouses: [show({ name: "ETL_NEW" })],
      metering: [meter(7, "ETL", "2026-11-11", 1), meter(7, "ETL_NEW", "2026-11-12", 2)],
      ...none,
    })
    expect(unlisted).toEqual([])
    expect(facts[0]).toMatchObject({ warehouse_id: "7", warehouse_name: "ETL_NEW" })
    expect(facts[0]!.usage_days.map((day) => day.credits_used)).toEqual([1, 2])
  })

  test.each([
    ["the old name first", ["ETL", "ETL_NEW"]],
    ["the new name first", ["ETL_NEW", "ETL"]],
  ])("a warehouse renamed on its last day of usage stays under its listed name, %s", (_, names) => {
    const { facts, unlisted } = buildFacts({
      warehouses: [show({ name: "ETL_NEW" })],
      metering: names.map((name, at) => meter(7, name, "2026-11-12", at + 1)),
      ...none,
    })
    expect(unlisted).toEqual([])
    expect(facts[0]).toMatchObject({ warehouse_id: "7", warehouse_name: "ETL_NEW" })
    expect(facts[0]!.usage_days.map((day) => day.credits_used)).toEqual([3])
  })

  test("a rename's query and restart rows are added, not read from one name or repeated", () => {
    const { facts } = buildFacts({
      warehouses: [show({ name: "NEW" })],
      metering: [meter(7, "AOLD", "2026-11-11"), meter(7, "NEW", "2026-11-12")],
      periods: [],
      restarts: [
        { warehouse_id: 7, warehouse_name: "AOLD", day: "2026-11-12", gap_seconds: 30, bounces: 1 },
        { warehouse_id: 7, warehouse_name: "NEW", day: "2026-11-12", gap_seconds: 30, bounces: 2 },
      ],
      queries: [
        { warehouse_id: 7, warehouse_name: "AOLD", query_count: 10, sub_five_second_queries: 10, sub_five_second_credits: 1 },
        { warehouse_id: 7, warehouse_name: "NEW", query_count: 990, sub_five_second_queries: 0, sub_five_second_credits: 0.5 },
      ],
    })
    expect(facts[0]).toMatchObject({ query_count: 1000, sub_five_second_queries: 10, sub_five_second_credits: 1.5 })
    expect(facts[0]!.restart_days).toEqual([{ day: "2026-11-12", gaps: [{ gap_seconds: 30, bounces: 3 }] }])
  })

  test("two warehouses that swapped names keep their own usage and distinct ids", () => {
    const { facts } = buildFacts({
      warehouses: [show({ name: "BLUE" }), show({ name: "GREEN" })],
      metering: [meter(7, "BLUE", "2026-11-11", 1), meter(8, "GREEN", "2026-11-11", 2), meter(7, "GREEN", "2026-11-12", 3), meter(8, "BLUE", "2026-11-12", 4)],
      ...none,
    })
    expect(facts.map((one) => one.warehouse_id)).toEqual(["8", "7"])
    expect(facts[0]!.usage_days.map((day) => day.credits_used)).toEqual([2, 4])
    expect(facts[1]!.usage_days.map((day) => day.credits_used)).toEqual([1, 3])
  })

  test("an unused warehouse named like another's id keeps a distinct id", () => {
    const { facts } = buildFacts({
      warehouses: [show({ name: "7" }), show({ name: "ETL" })],
      metering: [meter(7, "ETL", "2026-11-11")],
      ...none,
    })
    expect(facts.map((one) => one.warehouse_id)).toEqual(["unused:7", "7"])
  })

  test("a new unused warehouse on a renamed one's old name gets none of its usage", () => {
    const { facts } = buildFacts({
      warehouses: [show({ name: "ETL" }), show({ name: "ETL_OLD" })],
      metering: [meter(7, "ETL", "2026-11-11"), meter(7, "ETL_OLD", "2026-11-12")],
      ...none,
    })
    expect(facts.map((one) => one.warehouse_id)).toEqual(["unused:ETL", "7"])
    expect(facts[0]!.usage_days).toEqual([])
    expect(facts[1]!.usage_days.length).toBe(2)
  })

  test("usage that ended before the listed warehouse was created belongs to its predecessor", () => {
    const rows = { metering: [meter(100, "BI_WH", "2026-11-12")], ...none }
    const recreated = buildFacts({ warehouses: [show({ created_on: new Date("2026-11-15T08:00:00Z") })], ...rows })
    expect(recreated.facts[0]).toMatchObject({ warehouse_id: "unused:BI_WH", usage_days: [] })
    expect(recreated.unlisted).toEqual([])
    // That usage is named as not checked.
    expect(recreated.replaced).toEqual(["BI_WH"])
    const older = buildFacts({ warehouses: [show({ created_on: "2026-01-01T00:00:00Z" })], ...rows })
    expect(older.facts[0]!.warehouse_id).toBe("100")
    // A creation time that cannot be read changes nothing.
    expect(buildFacts({ warehouses: [show({ created_on: "not a time" })], ...rows }).facts[0]!.warehouse_id).toBe("100")
  })

  describe("a warehouse recreated under the same name", () => {
    // BI_WH is dropped and recreated at 18:00 UTC; its predecessor (id 100) ran that morning.
    const created = new Date("2026-11-12T18:00:00Z")
    const at = (iso: string) => Date.parse(iso) / 1000
    const listed = [show({ size: "Small", created_on: created })]
    const day = "2026-11-12"
    const predecessor = {
      metering: [{ warehouse_id: 100, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 42, first_start: at("2026-11-12T08:00:00Z") }],
      periods: [{ warehouse_id: 100, warehouse_name: "BI_WH", cluster_number: 1, usage_day: day, idle_day: day, periods: 3, short_periods: 1, active_seconds: 900, idle_seconds: 300, first_start: at("2026-11-12T08:05:00Z") }],
      restarts: [{ warehouse_id: 100, warehouse_name: "BI_WH", day, gap_seconds: 20, bounces: 5, first_start: at("2026-11-12T09:00:00Z") }],
      queries: [{ warehouse_id: 100, warehouse_name: "BI_WH", query_count: 50, sub_five_second_queries: 49, sub_five_second_credits: 2, first_start: at("2026-11-12T08:10:00Z") }],
    }

    test("the predecessor's same-day usage is not the new warehouse's: none is attributed and the name is reported", () => {
      const { facts, replaced, unlisted } = buildFacts({ warehouses: listed, ...predecessor })
      expect(facts[0]).toMatchObject({ warehouse_id: "unused:BI_WH", warehouse_size: "Small", query_count: 0, sub_five_second_credits: 0 })
      expect(facts[0]).toMatchObject({ usage_days: [], idle_days: [], cluster_days: [], restart_days: [] })
      expect(replaced).toEqual(["BI_WH"])
      expect(unlisted).toEqual([])
    })

    test.each(["metering", "periods", "restarts", "queries"] as const)(
      "a predecessor seen only in %s before the creation is still left out",
      (source) => {
        const rows = { warehouses: listed, metering: [], periods: [], restarts: [], queries: [], [source]: predecessor[source] }
        const { facts, replaced } = buildFacts(rows)
        expect(facts[0]!.warehouse_id).toBe("unused:BI_WH")
        expect(replaced).toEqual(["BI_WH"])
      },
    )

    test("usage from after the creation is the new warehouse's, the same day included", () => {
      const current = {
        // A metered hour starting before the creation it contains still counts.
        metering: [{ warehouse_id: 200, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 3, first_start: at("2026-11-12T17:00:01Z") }],
        periods: [{ warehouse_id: 200, warehouse_name: "BI_WH", cluster_number: 1, usage_day: day, idle_day: day, periods: 1, short_periods: 0, active_seconds: 600, idle_seconds: 60, first_start: at("2026-11-12T17:59:30Z") }],
        restarts: [{ warehouse_id: 200, warehouse_name: "BI_WH", day, gap_seconds: 30, bounces: 1, first_start: at("2026-11-12T19:00:00Z") }],
        queries: [{ warehouse_id: 200, warehouse_name: "BI_WH", query_count: 7, sub_five_second_queries: 6, sub_five_second_credits: 0.5, first_start: at("2026-11-12T18:02:00Z") }],
      }
      const { facts, replaced } = buildFacts({
        warehouses: listed,
        metering: [...predecessor.metering, ...current.metering],
        periods: [...predecessor.periods, ...current.periods],
        restarts: [...predecessor.restarts, ...current.restarts],
        queries: [...predecessor.queries, ...current.queries],
      })
      expect(facts[0]).toMatchObject({ warehouse_id: "200", query_count: 7, sub_five_second_queries: 6, sub_five_second_credits: 0.5 })
      expect(facts[0]!.usage_days).toEqual([{ day, credits_used: 3, active_periods: 1, short_periods: 0 }])
      expect(facts[0]!.restart_days).toEqual([{ day, gaps: [{ gap_seconds: 30, bounces: 1 }] }])
      expect(replaced).toEqual(["BI_WH"])
    })

    test("a metered hour that ended before the creation, or an event over a minute early, is the predecessor's", () => {
      const early = (source: "metering" | "periods", first: string) =>
        buildFacts({
          warehouses: listed,
          metering: [],
          periods: [],
          restarts: [],
          queries: [],
          [source]: [{ ...predecessor[source][0], warehouse_id: 200, first_start: at(first) }],
        }).facts[0]!.warehouse_id
      expect(early("metering", "2026-11-12T17:00:00Z")).toBe("unused:BI_WH")
      expect(early("metering", "2026-11-12T17:00:01Z")).toBe("200")
      expect(early("periods", "2026-11-12T17:58:59Z")).toBe("unused:BI_WH")
      expect(early("periods", "2026-11-12T17:59:00Z")).toBe("200")
    })

    test("usage whose start cannot be read is not attributed to a warehouse with a known creation time", () => {
      const query = { ...predecessor.queries[0]!, warehouse_id: 200, first_start: null }
      const rows = { metering: [], periods: [], restarts: [], queries: [query] }
      expect(buildFacts({ warehouses: listed, ...rows })).toMatchObject({ replaced: ["BI_WH"], facts: [{ warehouse_id: "unused:BI_WH", query_count: 0 }] })
      // Without a creation time there is nothing to compare, so the usage stays.
      expect(buildFacts({ warehouses: [show()], ...rows }).facts[0]).toMatchObject({ warehouse_id: "200", query_count: 50 })
    })

    test.each([
      ["after the rename", "2026-11-12T13:00:00Z", false],
      ["in the hour of the rename", "2026-11-12T12:00:00Z", false],
      ["in the hour of the rename, rows in reverse order", "2026-11-12T12:00:00Z", true],
    ])("a warehouse renamed away the day its old name is reused keeps its usage, its new name's first row %s", (_, renamed, reversed) => {
      // Id 5 was BI_WH until 12:30 and is now ETL_WH; the new BI_WH (id 9) was created at 18:00.
      const rows = [
        { warehouse_id: 5, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 6, first_start: at("2026-11-12T12:00:00Z") },
        { warehouse_id: 5, warehouse_name: "ETL_WH", usage_day: day, idle_day: day, credits_used: 7, first_start: at(renamed) },
        { warehouse_id: 9, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 1, first_start: at("2026-11-12T18:00:00Z") },
      ]
      const { facts, replaced } = buildFacts({
        warehouses: [...listed, show({ name: "ETL_WH", created_on: new Date("2026-10-01T00:00:00Z") })],
        metering: reversed ? rows.reverse() : rows,
        periods: [],
        restarts: [],
        queries: [],
      })
      expect(facts.map((one) => [one.warehouse_name, one.warehouse_id, one.usage_days.map((d) => d.credits_used)])).toEqual([
        ["BI_WH", "9", [1]],
        ["ETL_WH", "5", [13]],
      ])
      expect(replaced).toEqual([])
    })

    test.each([false, true])("of two names seen at the same instant, the listed one is the id's (rows reversed: %s)", (reversed) => {
      const rows = [
        { warehouse_id: 5, warehouse_name: "GONE_WH", usage_day: day, idle_day: day, credits_used: 2, first_start: at("2026-11-12T12:00:00Z") },
        { warehouse_id: 5, warehouse_name: "ETL_WH", usage_day: day, idle_day: day, credits_used: 3, first_start: at("2026-11-12T12:00:00Z") },
      ]
      const { facts, unlisted } = buildFacts({
        warehouses: [show({ name: "ETL_WH" })],
        metering: reversed ? rows.reverse() : rows,
        periods: [],
        restarts: [],
        queries: [],
      })
      expect(facts[0]).toMatchObject({ warehouse_id: "5", usage_days: [{ day, credits_used: 5 }] })
      expect(unlisted).toEqual([])
    })

    test("a warehouse renamed within a metered hour keeps its usage when its old name is reused", () => {
      // Id 5 resumed as BI_WH at 12:10 and was renamed ETL_WH at 12:30; the 12:00 hour was metered under ETL_WH.
      const { facts, replaced } = buildFacts({
        warehouses: [...listed, show({ name: "ETL_WH", created_on: new Date("2026-10-01T00:00:00Z") })],
        metering: [
          { warehouse_id: 5, warehouse_name: "ETL_WH", usage_day: day, idle_day: day, credits_used: 2, first_start: at("2026-11-12T12:00:00Z") },
          { warehouse_id: 9, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 1, first_start: at("2026-11-12T18:00:00Z") },
        ],
        periods: [{ ...predecessor.periods[0]!, warehouse_id: 5, first_start: at("2026-11-12T12:10:00Z") }],
        restarts: [],
        queries: [],
      })
      expect(facts.map((one) => [one.warehouse_name, one.warehouse_id])).toEqual([
        ["BI_WH", "9"],
        ["ETL_WH", "5"],
      ])
      expect(facts[1]!.usage_days).toEqual([{ day, credits_used: 2, active_periods: 3, short_periods: 1 }])
      expect(replaced).toEqual([])
    })

    test("a name reused by renaming an older warehouse into it keeps that warehouse, not the dropped one", () => {
      // X_WH (id 9) billed on 10 Nov and was dropped; OLD_WH (id 5, created 2025) was then renamed X_WH.
      const { facts, replaced } = buildFacts({
        warehouses: [show({ name: "X_WH", created_on: new Date("2025-06-01T00:00:00Z") })],
        metering: [
          { warehouse_id: 9, warehouse_name: "X_WH", usage_day: "2026-11-10", idle_day: "2026-11-10", credits_used: 50, first_start: at("2026-11-10T08:00:00Z") },
          { warehouse_id: 5, warehouse_name: "OLD_WH", usage_day: "2026-11-09", idle_day: "2026-11-09", credits_used: 3, first_start: at("2026-11-09T08:00:00Z") },
          { warehouse_id: 5, warehouse_name: "X_WH", usage_day: day, idle_day: day, credits_used: 2, first_start: at("2026-11-12T08:00:00Z") },
        ],
        periods: [],
        restarts: [],
        queries: [],
      })
      expect(facts[0]!.warehouse_id).toBe("5")
      expect(facts[0]!.usage_days.map((one) => one.credits_used)).toEqual([3, 2])
      expect(replaced).toEqual(["X_WH"])
    })

    test("an id is moved to another of its names only when that warehouse's creation time shows it fits", () => {
      // Id 5 was last seen as BI_WH, which was created after it ran; ETL_WH, its other name, has no creation time.
      const { facts, replaced } = buildFacts({
        warehouses: [...listed, show({ name: "ETL_WH" })],
        metering: [
          { warehouse_id: 5, warehouse_name: "ETL_WH", usage_day: day, idle_day: day, credits_used: 2, first_start: at("2026-11-12T09:00:00Z") },
          { warehouse_id: 5, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 1, first_start: at("2026-11-12T10:00:00Z") },
        ],
        periods: [],
        restarts: [],
        queries: [],
      })
      expect(facts.map((one) => one.warehouse_id)).toEqual(["unused:BI_WH", "unused:ETL_WH"])
      expect(replaced).toEqual(["BI_WH"])
    })

    test("an id with usage on both sides of the creation is not the new warehouse's", () => {
      // Id 1 ran as BI_WH, was renamed BI_WH_OLD at 10:00 and kept running; the new BI_WH (id 2) was created at 18:00.
      const { facts, replaced, unlisted } = buildFacts({
        warehouses: listed,
        metering: [
          { warehouse_id: 1, warehouse_name: "BI_WH", usage_day: "2026-11-10", idle_day: "2026-11-10", credits_used: 9, first_start: at("2026-11-10T08:00:00Z") },
          { warehouse_id: 1, warehouse_name: "BI_WH_OLD", usage_day: day, idle_day: day, credits_used: 4, first_start: at("2026-11-12T19:00:00Z") },
          { warehouse_id: 2, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 1, first_start: at("2026-11-12T18:00:00Z") },
        ],
        periods: [],
        restarts: [],
        queries: [],
      })
      expect(facts[0]).toMatchObject({ warehouse_id: "2", usage_days: [{ day, credits_used: 1 }] })
      expect({ replaced, unlisted }).toEqual({ replaced: [], unlisted: ["BI_WH_OLD"] })
    })

    test("a predecessor with nothing billed, run or queried is not reported", () => {
      const idle = { ...predecessor.metering[0]!, credits_used: 0 }
      expect(buildFacts({ warehouses: listed, metering: [idle], periods: [], restarts: [], queries: [] }).replaced).toEqual([])
    })

    test("a warehouse that is not listed is named only when it was metered", () => {
      const query = { ...predecessor.queries[0]!, warehouse_id: 3, warehouse_name: "SECRET_WH" }
      expect(buildFacts({ warehouses: listed, metering: [], periods: [], restarts: [], queries: [query] }).unlisted).toEqual([])
    })

    test("a predecessor from the day before is still left out, with or without new usage", () => {
      const yesterday = {
        ...predecessor,
        metering: [{ ...predecessor.metering[0]!, usage_day: "2026-11-11", idle_day: "2026-11-11", first_start: at("2026-11-11T08:00:00Z") }],
        periods: [],
        restarts: [],
        queries: [],
      }
      expect(buildFacts({ warehouses: listed, ...yesterday })).toMatchObject({ replaced: ["BI_WH"], facts: [{ warehouse_id: "unused:BI_WH" }] })
      const both = buildFacts({
        warehouses: listed,
        ...yesterday,
        metering: [...yesterday.metering, { warehouse_id: 200, warehouse_name: "BI_WH", usage_day: day, idle_day: day, credits_used: 4, first_start: at("2026-11-12T18:00:00Z") }],
      })
      expect(both.facts[0]!.warehouse_id).toBe("200")
      expect(both.facts[0]!.usage_days.map((one) => one.credits_used)).toEqual([4])
      expect(both.replaced).toEqual(["BI_WH"])
    })
  })

  test("a warehouse that billed credits but cannot be listed is named", () => {
    const { facts, unlisted } = buildFacts({
      warehouses: [show()],
      metering: [{ warehouse_id: 3, warehouse_name: "SECRET_WH", usage_day: "2026-11-11", idle_day: null, credits_used: 1 }],
      periods: [],
      restarts: [],
      queries: [],
    })
    expect(unlisted).toEqual(["SECRET_WH"])
    expect(facts.map((one) => one.warehouse_name)).toEqual(["BI_WH"])
  })
})

describe("the price of a credit", () => {
  test("is the rate sheet's in dollars, otherwise list price", () => {
    expect(creditPrice({ effective_rate: "2.40", currency: "USD", rate_date: "2026-11-17" })).toEqual({ per_credit: 2.4, source: "rate_sheet", as_of: "2026-11-17" })
    for (const rate of [undefined, { effective_rate: 2.4, currency: "EUR" }, { effective_rate: 0, currency: "USD" }]) {
      expect(creditPrice(rate)).toEqual({ per_credit: LIST_PRICE_PER_CREDIT, source: "list_price" })
    }
  })
})

describe("snowflake savings handler over a stubbed connection", () => {
  const NOW = Date.parse("2026-11-18T10:00:00Z")
  const table = (rows: Record<string, unknown>[], truncated = false) => ({
    columns: Object.keys(rows[0] ?? {}),
    rows: rows.map((row) => Object.values(row)),
    truncated,
  })
  const SHOW = [{ name: "BI_WH", size: "Large", type: "STANDARD", min_cluster_count: 1, max_cluster_count: 1 }]
  const METERING = [{ warehouse_id: 7, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: "2026-11-11", credits_used: 14 }]
  const RATE = [{ effective_rate: 2.5, currency: "USD", rate_date: "2026-11-17" }]
  const answers = (sql: string) =>
    sql === SNOWFLAKE_WAREHOUSES_SQL ? table(SHOW) : sql === SNOWFLAKE_METERING_FACTS_SQL ? table(METERING) : sql === SNOWFLAKE_RATE_SQL ? table(RATE) : table([])
  let calls: { sql: string; limit: number; binds: unknown[]; timeout?: number; clientTimeout?: number; signal?: AbortSignal }[]
  let sent: any

  beforeEach(() => {
    calls = []
    sent = undefined
    Registry.setConfigs({ sf: { type: "snowflake", account: "a", user: "u", password: "p", warehouse: "BI_WH" } } as any)
  })
  afterEach(() => Registry.reset())

  const rules = (input: string) => {
    sent = JSON.parse(input)
    return { lookback_days: 7, price_per_credit: sent.price_per_credit, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] }
  }
  const connect = (answer: (sql: string) => unknown) =>
    tracked(spyOn(Registry, "get")).mockResolvedValue({
      execute: async (sql: string, limit: number, binds: unknown[], options?: { cancelAfterMs?: number; queryTimeoutMs?: number; signal?: AbortSignal }) => {
        calls.push({ sql, limit, binds, timeout: options?.cancelAfterMs, clientTimeout: options?.queryTimeoutMs, signal: options?.signal })
        return answer(sql)
      },
    } as any)

  test("every query is bound to the window end and gets what is left of the 9 minutes; the facts and rate reach core", async () => {
    const spy = connect(answers)
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(true)
    expect(result.window).toEqual({ start: "2026-11-11", end: "2026-11-18" })
    // The rate sheet is read last: only the price needs it.
    expect(calls.map((one) => one.sql)).toEqual([
      SNOWFLAKE_WAREHOUSES_SQL,
      SNOWFLAKE_METERING_FACTS_SQL,
      SNOWFLAKE_PERIOD_FACTS_SQL,
      SNOWFLAKE_RESTART_FACTS_SQL,
      SNOWFLAKE_QUERY_FACTS_SQL,
      SNOWFLAKE_RATE_SQL,
    ])
    for (const one of calls) {
      expect(one.binds).toEqual(Array(one.sql.split("?").length - 1).fill("2026-11-18"))
      expect(one.timeout).toBeGreaterThan(0)
      expect(one.timeout).toBeLessThanOrEqual(SAVINGS_RUN_LIMIT_MS)
      expect(one.clientTimeout).toBeUndefined()
      // SHOW takes a LIMIT of at most 10,000, and the driver asks for one row more than this.
      expect(one.limit).toBe(one.sql === SNOWFLAKE_WAREHOUSES_SQL ? SHOW_ROW_LIMIT : ROW_LIMIT)
    }
    expect(SHOW_ROW_LIMIT + 1).toBeLessThanOrEqual(10_000)
    expect(SAVINGS_RUN_LIMIT_MS).toBe(540_000)
    expect(sent).toMatchObject({ lookback_days: 7, price_per_credit: 2.5 })
    expect(sent.warehouses[0]).toMatchObject({ warehouse_id: "7", warehouse_name: "BI_WH", warehouse_size: "Large" })
    expect(result.price).toEqual({ per_credit: 2.5, source: "rate_sheet", as_of: "2026-11-17" })
    expect(result.ran_on).toBe("BI_WH")
    expect(result.warehouses).toEqual([{ id: "7", name: "BI_WH", type: "STANDARD", size: "Large", window_cost: 35 }])
  })

  test("a rate sheet the role cannot read falls back to the stated list price and skips nothing", async () => {
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_RATE_SQL) throw new Error("Object does not exist or not authorized")
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(true)
    expect(sent.price_per_credit).toBe(LIST_PRICE_PER_CREDIT)
    expect(result.price).toEqual({ per_credit: LIST_PRICE_PER_CREDIT, source: "list_price" })
    expect(result.skipped).toEqual([])
  })

  test("a view the role cannot read skips only the checks that need it", async () => {
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_RESTART_FACTS_SQL) throw new Error("not authorized\nstack")
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([{ check: "Frequent Restart Overcharge", reason: "not authorized" }])
  })

  test("when no usage query could run, one that may still be running is the one named", async () => {
    const stopped = timeout({ cancelled: false })
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_PERIOD_FACTS_SQL) throw stopped
      if ([SNOWFLAKE_RESTART_FACTS_SQL, SNOWFLAKE_QUERY_FACTS_SQL].includes(sql)) throw new Error("not authorized")
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(false)
    expect(result.error).toContain("The active periods query ran past")
    expect(result.error).toContain("may still be running on the warehouse")
  })

  test("when none of the three usage queries can run, the check fails instead of reporting no savings", async () => {
    const spy = connect((sql) => {
      if ([SNOWFLAKE_PERIOD_FACTS_SQL, SNOWFLAKE_RESTART_FACTS_SQL, SNOWFLAKE_QUERY_FACTS_SQL].includes(sql)) throw new Error("not authorized")
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result).toMatchObject({ success: false, error: "No check could run. not authorized" })
    expect(sent).toBeUndefined()
  })

  test("billing that cannot be read fails the check: nothing could be priced", async () => {
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_METERING_FACTS_SQL) throw new Error("Insufficient privileges")
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result).toMatchObject({ success: false, error: "Insufficient privileges" })
    expect(sent).toBeUndefined()
  })

  test("a role that can list no warehouse gets a plain failure before any usage query", async () => {
    const spy = connect(() => table([]))
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(false)
    expect(result.error).toContain("SHOW WAREHOUSES lists no warehouse")
    expect(calls.length).toBe(1)
  })

  test("billed warehouses the role cannot list are named as not checked", async () => {
    const spy = connect((sql) =>
      sql === SNOWFLAKE_METERING_FACTS_SQL
        ? table([...METERING, { warehouse_id: 3, warehouse_name: "SECRET_WH", usage_day: "2026-11-11", idle_day: null, credits_used: 1 }])
        : answers(sql),
    )
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.skipped).toEqual([
      { check: "1 warehouse that billed credits", reason: "SHOW WAREHOUSES does not list SECRET_WH: dropped, renamed, or not visible to the connection's role" },
    ])
  })

  test("usage an earlier warehouse billed under a listed name is named as not checked", async () => {
    connect((sql) =>
      sql === SNOWFLAKE_METERING_FACTS_SQL
        ? table([{ warehouse_id: 3, warehouse_name: "BI_WH", usage_day: "2026-11-11", idle_day: null, credits_used: 100 }, ...METERING])
        : answers(sql),
    )
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.warehouses_checked).toBe(1)
    expect(result.skipped).toEqual([
      {
        check: "Earlier usage of 1 warehouse name",
        reason: "BI_WH also had usage from an earlier warehouse, since dropped or renamed: only the current warehouse's usage was checked",
      },
    ])
  })

  const timeout = (fields: { cancelled?: boolean; unsent?: boolean }) =>
    Object.assign(new Error("QUERY_TIMEOUT: snowflake query exceeded"), { code: "QUERY_TIMEOUT", ...fields })

  test("a required query past its limit fails the check with a plain reason", async () => {
    connect((sql) => {
      if (sql === SNOWFLAKE_METERING_FACTS_SQL) throw timeout({ cancelled: true })
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.error).toBe("The metering query ran past the check's 9-minute limit and was cancelled on the warehouse.")
  })

  test("a query stopped before it was sent says it did not run", async () => {
    connect((sql) => {
      if (sql === SNOWFLAKE_METERING_FACTS_SQL) throw timeout({ cancelled: false, unsent: true })
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.error).toBe("The metering query ran past the check's 9-minute limit before it was sent, so it did not run on the warehouse.")
  })

  test("an optional query past its limit skips only its check", async () => {
    connect((sql) => {
      if (sql === SNOWFLAKE_QUERY_FACTS_SQL) throw timeout({ cancelled: false })
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([
      { check: "The short-query signal of Downsize Warehouse", reason: "The query history query ran past the check's 9-minute limit and may still be running on the warehouse." },
    ])
  })

  test("each query gets only what the earlier ones left; with nothing left it is not started", async () => {
    let now = 1_000_000
    const clock = tracked(spyOn(Date, "now")).mockImplementation(() => now)
    const spy = connect((sql) => {
      // The metering query uses up two minutes, and the period query all the rest.
      if (sql === SNOWFLAKE_METERING_FACTS_SQL) now += 120_000
      if (sql === SNOWFLAKE_PERIOD_FACTS_SQL) now += SAVINGS_RUN_LIMIT_MS
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(calls.map((one) => one.timeout)).toEqual([SAVINGS_RUN_LIMIT_MS, SAVINGS_RUN_LIMIT_MS, SAVINGS_RUN_LIMIT_MS - 120_000])
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([
      { check: "Frequent Restart Overcharge", reason: "The restart events query was not started: it would run past the check's 9-minute limit." },
      { check: "The short-query signal of Downsize Warehouse", reason: "The query history query was not started: it would run past the check's 9-minute limit." },
      { check: "The account's credit rate", reason: "The credit rate query was not started: it would run past the check's 9-minute limit." },
    ])
  })

  test("the optional rate lookup cannot take a usage query's time: with none left, list price stands in and the result says why", async () => {
    let now = 1_000_000
    tracked(spyOn(Date, "now")).mockImplementation(() => now)
    connect((sql) => {
      // The last usage query uses up the limit.
      if (sql === SNOWFLAKE_QUERY_FACTS_SQL) now += SAVINGS_RUN_LIMIT_MS
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(calls.map((one) => one.sql)).toEqual([
      SNOWFLAKE_WAREHOUSES_SQL,
      SNOWFLAKE_METERING_FACTS_SQL,
      SNOWFLAKE_PERIOD_FACTS_SQL,
      SNOWFLAKE_RESTART_FACTS_SQL,
      SNOWFLAKE_QUERY_FACTS_SQL,
    ])
    expect(result.success).toBe(true)
    expect(result.price).toEqual({ per_credit: LIST_PRICE_PER_CREDIT, source: "list_price" })
    expect(result.skipped).toEqual([
      { check: "The account's credit rate", reason: "The credit rate query was not started: it would run past the check's 9-minute limit." },
    ])
  })

  test("stopping the session cancels the running query and starts no other", async () => {
    const controller = new AbortController()
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_PERIOD_FACTS_SQL) {
        controller.abort(new Error("session stopped"))
        throw new Error("session stopped")
      }
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { signal: controller.signal })
    expect(result).toMatchObject({ success: false, error: "session stopped" })
    expect(result.skipped).toBeUndefined()
    expect(calls.at(-1)!.sql).toBe(SNOWFLAKE_PERIOD_FACTS_SQL)
    expect(sent).toBeUndefined()
    // Each query got the session's signal, so the driver cancels it on Snowflake.
    for (const one of calls) expect(one.signal).toBe(controller.signal)
  })

  test("connecting counts toward the limit: a connection that never comes up ends the check in time", async () => {
    // A 30 ms session budget stands in for the last moments of the 9 minutes.
    const budget = tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() + 30)
    const get = tracked(spyOn(Registry, "get")).mockReturnValue(new Promise(() => {}) as any)
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { sessionID: "s1" })
    expect(result).toMatchObject({ success: false, error: "Connecting to the warehouse took longer than the run's time budget." })
  })

  test("stopping the session while connecting ends the check at once", async () => {
    const controller = new AbortController()
    const get = tracked(spyOn(Registry, "get")).mockReturnValue(new Promise(() => {}) as any)
    const pending = snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { signal: controller.signal })
    controller.abort(new Error("session stopped"))
    const result = await pending
    expect(result).toMatchObject({ success: false, error: "session stopped" })
  })

  test("a session that already stopped does not connect to Snowflake at all", async () => {
    const controller = new AbortController()
    controller.abort(new Error("session stopped"))
    const get = tracked(spyOn(Registry, "get")).mockRejectedValue(new Error("connected"))
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { signal: controller.signal })
    expect(result).toMatchObject({ success: false, error: "session stopped" })
    expect(get).not.toHaveBeenCalled()
  })

  test("a session time budget already used up does not connect to Snowflake at all", async () => {
    tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() - 1)
    const get = tracked(spyOn(Registry, "get")).mockRejectedValue(new Error("connected"))
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { sessionID: "s1" })
    expect(result).toMatchObject({ success: false, error: "Connecting to the warehouse was not started: the run's time budget had already passed." })
    expect(get).not.toHaveBeenCalled()
  })

  test("a connection that fails after the session stopped is not left unhandled", async () => {
    const controller = new AbortController()
    const unhandled: unknown[] = []
    const note = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", note)
    try {
      let fail!: (reason: Error) => void
      const connecting = new Promise((_, reject) => (fail = reject))
      tracked(spyOn(Registry, "get")).mockReturnValue(connecting as any)
      const pending = snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { signal: controller.signal })
      controller.abort(new Error("session stopped"))
      const result = await pending
      fail(new Error("connection refused"))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(result).toMatchObject({ success: false, error: "session stopped" })
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", note)
    }
  })

  test("a rate query that may still be running is named, and list price is used", async () => {
    const stopped = timeout({ cancelled: false })
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_RATE_SQL) throw stopped
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.price?.source).toBe("list_price")
    expect(result.skipped).toEqual([
      { check: "The account's credit rate", reason: "The credit rate query ran past the check's 9-minute limit and may still be running on the warehouse." },
    ])
  })

  test("a session time budget shorter than 9 minutes is the limit, and is named when it stops a query", async () => {
    const budget = tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() + 60_000)
    const stopped = timeout({ cancelled: true })
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_METERING_FACTS_SQL) throw stopped
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { sessionID: "s1" })
    for (const one of calls) expect(one.timeout).toBeLessThanOrEqual(60_000)
    expect(result.error).toBe("The metering query ran past the run's time budget and was cancelled on the warehouse.")
  })

  test("a stop during the rate lookup is not mistaken for an unreadable rate sheet", async () => {
    const controller = new AbortController()
    const spy = connect((sql) => {
      if (sql === SNOWFLAKE_RATE_SQL) {
        controller.abort(new Error("session stopped"))
        throw new Error("session stopped")
      }
      return answers(sql)
    })
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules, { signal: controller.signal })
    expect(result).toMatchObject({ success: false, error: "session stopped" })
    expect(calls.at(-1)!.sql).toBe(SNOWFLAKE_RATE_SQL)
  })

  test("a query that fills the row limit is named", async () => {
    const spy = connect((sql) => (sql === SNOWFLAKE_PERIOD_FACTS_SQL ? table([], true) : answers(sql)))
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, rules)
    expect(result.limited).toEqual(["active periods"])
  })

  test("with no Snowflake connection it says how to add one", async () => {
    Registry.setConfigs({})
    const result = await snowflakeSavings({}, rules)
    expect(result.success).toBe(false)
    expect(result.error).toContain("warehouse_add")
  })

  test("a core without the rules is refused before any query", async () => {
    const spy = connect(answers)
    const result = await snowflakeSavings({ warehouse: "sf", now_ms: NOW }, null)
    expect(result.error).toContain("no Snowflake savings rules")
    expect(calls).toEqual([])
  })

  test("in assessment mode the rules come with core's own telemetry switched off", () => {
    const saved = process.env["ALTIMATE_ASSESSMENT_MODE"]
    const calls: unknown[][] = []
    const lib = { snowflakeSavings: () => ({}), initSdk: (...args: unknown[]) => void calls.push(args) }
    try {
      process.env["ALTIMATE_ASSESSMENT_MODE"] = "true"
      expect(rulesEngine(lib)).toBe(lib.snowflakeSavings as never)
      expect(calls).toEqual([["", "", "", false, false]])
      expect(rulesEngine({ initSdk: lib.initSdk })).toBeNull()
      delete process.env["ALTIMATE_ASSESSMENT_MODE"]
      rulesEngine(lib)
      expect(calls.length).toBe(1)
    } finally {
      if (saved === undefined) delete process.env["ALTIMATE_ASSESSMENT_MODE"]
      else process.env["ALTIMATE_ASSESSMENT_MODE"] = saved
    }
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import {
  DATABRICKS_WAREHOUSE_FACTS_SQL,
  databricksSavings,
  savingsWindow,
  toFacts,
} from "../../src/altimate/native/finops/databricks-savings"
import { FinopsDatabricksSavingsTool } from "../../src/altimate/tools/finops-databricks-savings"
import type { DatabricksSavingsResult } from "../../src/altimate/native/types"

function stubCtx(): any {
  return { sessionID: "test", messageID: "test", agent: "test", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
}

// What altimate-core returned for warehouse `Classic` on dbxmega for the seven days to
// 2026-11-12 06:00 UTC (findings rounded to the cent for the fixture).
const REPORT: DatabricksSavingsResult = {
  success: true,
  window: { start: "2026-11-05", end: "2026-11-12" },
  warehouse: "dbxmega",
  ran_on: "4ec45aec4ab985ab",
  warehouses_checked: 5,
  report: {
    lookback_days: 7,
    findings: [
      {
        check_id: "wh_classic_pro_to_serverless",
        title: "Migrate Classic/Pro to Serverless",
        warehouse_id: "a3688f261647f580",
        warehouse_name: "Classic",
        severity: "critical",
        daily_min: 1.773465,
        daily_max: 2.216832,
        monthly_min: 53.20,
        monthly_max: 66.50,
        evidence: {
          kind: "serverless",
          warehouse_type: "CLASSIC",
          warehouse_size: "SMALL",
          idle_ratio: 0.8926,
          wall_clock_uptime_hours: 10.897,
          total_query_count: 3580,
          price_per_dbu: 0.22,
          serverless_price_per_dbu: 0.7,
          current_dbu_cost: 23.58,
          projected_serverless_dbu_cost: 8.06,
          wasted_cost: 15.52,
        },
      },
      {
        check_id: "wh_oversized",
        title: "Over-Sized Warehouse",
        warehouse_id: "a3688f261647f580",
        warehouse_name: "Classic",
        severity: "high",
        daily_min: 0.898177,
        daily_max: 1.57181,
        monthly_min: 26.95,
        monthly_max: 47.15,
        evidence: {
          kind: "over_sized",
          current_size: "SMALL",
          recommended_size: "2X_SMALL",
          available_cores: 32,
          p99_utilization: 0.0834,
          parallelism_query_count: 3208,
          no_spill_query_pct: 1,
          no_queue_query_pct: 1,
          current_dbu_per_hour: 12,
          recommended_dbu_per_hour: 4,
          total_cost: 23.58,
          wasted_cost: 15.72,
        },
      },
    ],
    total: { monthly_min: 53.2, monthly_max: 66.5, warehouses: 1 },
  },
}

describe("finops_databricks_savings tool", () => {
  beforeEach(() => Dispatcher.reset())

  test("gives Claude the total, each finding with its evidence, and the whole report as metadata", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => REPORT)
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())

    expect(result.title).toBe("Databricks Savings: $53.20–$66.50 a month on 1 warehouse(s)")
    expect(result.output).toContain("Total: $53.20–$66.50 a month on 1 warehouse, each warehouse counted once")
    expect(result.output).toContain("Classic · Migrate Classic/Pro to Serverless · $53.20–$66.50 a month (critical)")
    expect(result.output).toContain("CLASSIC SMALL warehouse, 89% idle over 10.9 running hours (3,580 queries)")
    expect(result.output).toContain("2X-SMALL is enough: 12 → 4 DBU an hour")
    expect(result.metadata.report).toEqual(REPORT.report)
    expect(result.metadata.window).toEqual({ start: "2026-11-05", end: "2026-11-12" })
  })

  test("no findings says so and still reports how many warehouses were checked", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      report: { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, warehouses: 0 } },
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain("5 warehouses checked")
    expect(result.output).toContain("No savings found")
  })

  test("a failure is reported with its reason, not as no savings", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      success: false,
      window: { start: "2026-11-05", end: "2026-11-12" },
      error: "[TABLE_OR_VIEW_NOT_FOUND] The table or view `system`.`compute`.`warehouse_events` cannot be found.",
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.title).toBe("Databricks Savings: FAILED")
    expect(result.metadata.error).toContain("TABLE_OR_VIEW_NOT_FOUND")
    expect(result.output).not.toContain("No savings found")
  })
})

describe("databricks savings handler", () => {
  afterEach(() => Registry.reset())

  test("the window is the seven days to 06:00 UTC today", () => {
    expect(savingsWindow(Date.parse("2026-11-12T10:00:00Z"))).toEqual({ start: "2026-11-05", end: "2026-11-12" })
  })

  test("the facts query is one read-only statement taking the window end and the warehouse id, in that order", () => {
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL.trim()).toMatch(/^WITH\b/)
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL).not.toMatch(/;\s*\S/)
    const markers = [...DATABRICKS_WAREHOUSE_FACTS_SQL.matchAll(/\?/g)].map((m) => m.index!)
    expect(markers.length).toBe(2)
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL.slice(0, markers[0]!)).toContain("CAST(")
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL.slice(markers[0]!, markers[1]!)).toContain("WHERE workspace_id = (SELECT MAX(workspace_id)")
  })

  test("database values are coerced to the numbers core reads; no serverless price stays absent", () => {
    const facts = toFacts({
      warehouse_id: "a1",
      warehouse_name: null,
      warehouse_type: "PRO",
      warehouse_size: "SMALL",
      wall_clock_uptime_sec: "39229.0",
      total_query_count: 3580n,
      parallelism_query_count: "3208",
      idle_ratio: 0.89,
      serverless_price_per_dbu: null,
      no_spill_query_pct: "1.0000000000000000",
    })
    expect(facts.warehouse_name).toBe("a1")
    expect(facts.wall_clock_uptime_sec).toBe(39229)
    expect(facts.total_query_count).toBe(3580)
    expect(facts.parallelism_query_count).toBe(3208)
    expect(facts.serverless_price_per_dbu).toBeNull()
    expect(facts.no_spill_query_pct).toBe(1)
    expect(facts.total_cost).toBe(0)
  })

  test("with no Databricks connection it says how to add one", async () => {
    Registry.setConfigs({})
    const result = await databricksSavings({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("warehouse_add")
  })

  test("a connection that does not go through a SQL warehouse is refused before any query", async () => {
    Registry.setConfigs({
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/protocolv1/o/123/0101-abc", access_token: "x" },
    })
    const result = await databricksSavings({ warehouse: "dbx" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("/sql/1.0/warehouses/<id>")
  })
})

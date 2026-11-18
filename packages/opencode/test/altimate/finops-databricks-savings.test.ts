import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import {
  DATABRICKS_CLUSTER_FACTS_SQL,
  DATABRICKS_JOB_FACTS_SQL,
  DATABRICKS_WAREHOUSE_FACTS_SQL,
  databricksSavings,
  savingsWindow,
  toClusterFacts,
  toFacts,
  toJobFacts,
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
        resource_type: "sql_warehouse",
        resource_id: "a3688f261647f580",
        resource_name: "Classic",
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
        resource_type: "sql_warehouse",
        resource_id: "a3688f261647f580",
        resource_name: "Classic",
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
    total: { monthly_min: 53.2, monthly_max: 66.5, resources: 1 },
    what_if: [
      {
        resource_id: "a3688f261647f580",
        resource_name: "Classic",
        current_label: "SMALL (CLASSIC)",
        current_monthly_cost: 101.05,
        choices: [
          { label: "SERVERLESS", monthly_cost: 34.55, monthly_saving: 66.5, fits: true, cores: 0, cores_needed: 5.34 },
          { label: "X_SMALL", monthly_cost: 50.52, monthly_saving: 50.52, fits: true, cores: 16, cores_needed: 5.34 },
          { label: "2X_SMALL", monthly_cost: 33.68, monthly_saving: 67.37, fits: true, cores: 8, cores_needed: 5.34 },
        ],
      },
    ],
  },
}

describe("finops_databricks_savings tool", () => {
  beforeEach(() => Dispatcher.reset())

  test("gives Claude the total, each finding with its evidence, and the whole report as metadata", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => REPORT)
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())

    expect(result.title).toBe("Databricks Savings: $53.20–$66.50 a month on 1 resource(s)")
    expect(result.output).toContain("Total: $53.20–$66.50 a month on 1 resource, each counted once at its largest saving.")
    expect(result.output).toContain("Classic (sql warehouse) · Migrate Classic/Pro to Serverless · $53.20–$66.50 a month (critical)")
    // What the flagged warehouse would cost instead, for Claude to explain.
    expect(result.output).toContain("What Classic (now SMALL (CLASSIC), $101 a month) would cost instead:")
    expect(result.output).toContain("  X-SMALL: $50.52 a month, saving $50.52")
    expect(result.output).toContain("CLASSIC SMALL warehouse, 89% idle over 10.9 running hours (3,580 queries)")
    expect(result.output).toContain("2X-SMALL is enough: 12 → 4 DBU an hour")
    expect(result.metadata.report).toEqual(REPORT.report)
    expect(result.metadata.window).toEqual({ start: "2026-11-05", end: "2026-11-12" })
  })

  test("no findings says so and still reports how many warehouses were checked", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      report: { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] },
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain("5 SQL warehouses, 0 all-purpose clusters, 0 jobs checked")
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

describe("cluster and job findings", () => {
  beforeEach(() => Dispatcher.reset())

  test("each kind of finding gets its own evidence lines, and a skipped check is named", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      clusters_checked: 3,
      jobs_checked: 4,
      skipped: [{ check: "Job Running on All-Purpose Compute", reason: "[INSUFFICIENT_PERMISSIONS] system.lakeflow.jobs" }],
      report: {
        lookback_days: 7,
        findings: [
          {
            check_id: "ap_idle_cluster",
            title: "Idle Cluster Detection",
            resource_type: "cluster",
            resource_id: "0101-abc",
            resource_name: "shared-analytics",
            severity: "critical",
            daily_min: 25.5,
            daily_max: 51,
            monthly_min: 765,
            monthly_max: 1530,
            evidence: { kind: "idle_cluster", idle_pattern: "zombie", idle_ratio: 0.85, auto_termination_minutes: null, active_days: 5, avg_cpu_active_pct: 8, peak_cpu_active_pct: 30, total_cost: 700, wasted_cost: 595 },
          },
        ],
        total: { monthly_min: 765, monthly_max: 1530, resources: 1 },
        what_if: [],
      },
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain("5 SQL warehouses, 3 all-purpose clusters, 4 jobs checked")
    expect(result.output).toContain("Not checked: Job Running on All-Purpose Compute ([INSUFFICIENT_PERMISSIONS] system.lakeflow.jobs)")
    expect(result.output).toContain("shared-analytics (cluster) · Idle Cluster Detection · $765–$1,530 a month (critical)")
    expect(result.output).toContain("All-purpose cluster 85% idle across 5 active days (zombie), average worker CPU 8%, peak 30%")
    expect(result.output).toContain("Auto-termination off; $700.00 billed outside job runs over the window")
  })

  test("the cluster and job queries each take the window end and the warehouse id, in that order", () => {
    for (const sql of [DATABRICKS_CLUSTER_FACTS_SQL, DATABRICKS_JOB_FACTS_SQL]) {
      expect(sql.trim()).toMatch(/^WITH\b/)
      expect(sql).not.toMatch(/;\s*\S/)
      const markers = [...sql.matchAll(/\?/g)].map((m) => m.index!)
      expect(markers.length).toBe(2)
      expect(sql.slice(0, markers[0]!)).toContain("CAST(")
      expect(sql.slice(markers[0]!, markers[1]!)).toContain("SELECT MAX(workspace_id) FROM system.compute.warehouses WHERE warehouse_id =")
    }
  })

  test("cluster and job rows are coerced to the facts core reads", () => {
    const cluster = toClusterFacts({ cluster_id: "c1", cluster_name: null, auto_termination_minutes: "120", total_node_minutes: 900n, active_util_days: "4", total_worker_minutes: 900, idle_node_minutes: 450, total_cost: "70.5" })
    expect(cluster).toMatchObject({ cluster_id: "c1", cluster_name: "c1", auto_termination_minutes: 120, total_node_minutes: 900, active_util_days: 4, total_cost: 70.5 })
    expect(toClusterFacts({ cluster_id: "c2" }).auto_termination_minutes).toBeNull()
    const job = toJobFacts({ job_id: "j1", job_name: "nightly", trigger_type: null, run_count: 7n, job_share_of_cluster: 1.2, jobs_rate_per_dbu: null })
    expect(job).toMatchObject({ job_id: "j1", trigger_type: null, run_count: 7, job_share_of_cluster: 1, jobs_rate_per_dbu: null })
  })
})

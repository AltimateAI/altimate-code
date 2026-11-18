import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import {
  DATABRICKS_CLUSTER_FACTS_SQL,
  DATABRICKS_JOB_FACTS_SQL,
  DATABRICKS_WAREHOUSE_FACTS_SQL,
  databricksSavings,
  rulesEngine,
  savingsWindow,
  toClusterFacts,
  toFacts,
  toJobFacts,
} from "../../src/altimate/native/finops/databricks-savings"
import { FinopsDatabricksSavingsTool, formatSavings } from "../../src/altimate/tools/finops-databricks-savings"
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

  test("in assessment mode the rules come with core's own telemetry switched off; otherwise core is left as it is", () => {
    const saved = process.env["ALTIMATE_ASSESSMENT_MODE"]
    const calls: unknown[][] = []
    const lib = { databricksSavings: () => ({}), initSdk: (...args: unknown[]) => void calls.push(args) }
    try {
      process.env["ALTIMATE_ASSESSMENT_MODE"] = "true"
      expect(rulesEngine(lib)).toBe(lib.databricksSavings as never)
      // Telemetry off, failure reports off; `initSdk` only stores the setting.
      expect(calls).toEqual([["", "", "", false, false]])
      // A core without the rules is not touched: the tool refuses before any rules call.
      expect(rulesEngine({ initSdk: lib.initSdk })).toBeNull()
      expect(calls.length).toBe(1)
      delete process.env["ALTIMATE_ASSESSMENT_MODE"]
      expect(rulesEngine(lib)).toBe(lib.databricksSavings as never)
      expect(calls.length).toBe(1)
    } finally {
      if (saved === undefined) delete process.env["ALTIMATE_ASSESSMENT_MODE"]
      else process.env["ALTIMATE_ASSESSMENT_MODE"] = saved
    }
  })

  test("the window is the seven days to the latest 06:00 UTC that has passed", () => {
    expect(savingsWindow(Date.parse("2026-11-12T10:00:00Z"))).toEqual({ start: "2026-11-05", end: "2026-11-12" })
    expect(savingsWindow(Date.parse("2026-11-12T06:00:00Z"))).toEqual({ start: "2026-11-05", end: "2026-11-12" })
    // Before 06:00 the day before is not billed yet, so the window still ends the day before.
    expect(savingsWindow(Date.parse("2026-11-12T05:59:00Z"))).toEqual({ start: "2026-11-04", end: "2026-11-11" })
  })

  test("the facts query is one read-only statement taking only the window end, over every workspace", () => {
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL.trim()).toMatch(/^WITH\b/)
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL).not.toMatch(/;\s*\S/)
    const markers = [...DATABRICKS_WAREHOUSE_FACTS_SQL.matchAll(/\?/g)].map((m) => m.index!)
    expect(markers.length).toBe(1)
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL.slice(0, markers[0]!)).toContain("CAST(")
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL).not.toContain("workspace_id = (SELECT")
    expect(DATABRICKS_WAREHOUSE_FACTS_SQL).toContain("SELECT inv.workspace_id, inv.warehouse_id")
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

  test("the cluster and job queries each take only the window end, and key every resource by its workspace", () => {
    for (const sql of [DATABRICKS_CLUSTER_FACTS_SQL, DATABRICKS_JOB_FACTS_SQL]) {
      expect(sql.trim()).toMatch(/^WITH\b/)
      expect(sql).not.toMatch(/;\s*\S/)
      const markers = [...sql.matchAll(/\?/g)].map((m) => m.index!)
      expect(markers.length).toBe(1)
      expect(sql.slice(0, markers[0]!)).toContain("CAST(")
      expect(sql).not.toContain("workspace_id = (SELECT")
    }
    expect(DATABRICKS_CLUSTER_FACTS_SQL).toContain("PARTITION BY workspace_id, cluster_id")
    // Job ids repeat across workspaces: every job key pairs the workspace with the id.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("PARTITION BY workspace_id, job_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY workspace_id, job_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("LEFT JOIN inv ON inv.workspace_id = jb.workspace_id AND inv.job_id = jb.job_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("LEFT JOIN jobs_rate jr ON jr.workspace_id = jb.workspace_id")
  })

  test("cluster and job rows are coerced to the facts core reads", () => {
    const cluster = toClusterFacts({ cluster_id: "c1", cluster_name: null, auto_termination_minutes: "120", total_node_minutes: 900n, active_util_days: "4", total_worker_minutes: 900, idle_node_minutes: 450, total_cost: "70.5" })
    expect(cluster).toMatchObject({ cluster_id: "c1", cluster_name: "c1", auto_termination_minutes: 120, total_node_minutes: 900, active_util_days: 4, total_cost: 70.5 })
    expect(toClusterFacts({ cluster_id: "c2" }).auto_termination_minutes).toBeNull()
    const job = toJobFacts({ job_id: "j1", job_name: "nightly", trigger_type: null, listed_in_job_inventory: true, run_trigger_type: "ONE_TIME", run_count: 7n, job_share_of_cluster: 1.2, jobs_rate_per_dbu: null })
    expect(job).toMatchObject({ job_id: "j1", trigger_type: null, listed_in_job_inventory: true, run_trigger_type: "ONE_TIME", run_count: 7, job_share_of_cluster: 1, jobs_rate_per_dbu: null })
    // A job the inventory does not list arrives with false, or with nothing at all.
    expect(toJobFacts({ job_id: "j2", listed_in_job_inventory: false }).listed_in_job_inventory).toBe(false)
    expect(toJobFacts({ job_id: "j3" })).toMatchObject({ listed_in_job_inventory: false, run_trigger_type: null })
  })

  test("the job query hands the inventory's trigger and the runs' trigger to core separately", () => {
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("inv.trigger_type AS trigger_type")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("inv.job_id IS NOT NULL AS listed_in_job_inventory")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("runs.run_trigger AS run_trigger_type")
    expect(DATABRICKS_JOB_FACTS_SQL).not.toContain("COALESCE(inv.trigger_type")
  })
})

describe("databricks savings handler over a stubbed connection", () => {
  const WAREHOUSE_ROW = { workspace_id: "111", warehouse_id: "abc123", warehouse_name: "BI", warehouse_type: "PRO", warehouse_size: "SMALL", total_cost: 27.5 }
  const JOB_ROW = { workspace_id: "222", job_id: "j1", job_name: "nightly", trigger_type: null, listed_in_job_inventory: true, run_trigger_type: "ONE_TIME", run_count: 9 }
  const table = (row: Record<string, unknown>, truncated = false) => ({ columns: Object.keys(row), rows: [Object.values(row)], truncated })
  let calls: { sql: string; limit: number; binds: unknown[] }[]
  let sent: any

  beforeEach(() => {
    calls = []
    sent = undefined
    Registry.setConfigs({
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
    })
  })
  afterEach(() => {
    Registry.reset()
  })

  const rules = (input: string) => {
    sent = JSON.parse(input)
    return { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] }
  }

  const connect = (answer: (sql: string) => unknown) =>
    spyOn(Registry, "get").mockResolvedValue({
      execute: async (sql: string, limit: number, binds: unknown[]) => {
        calls.push({ sql, limit, binds })
        return answer(sql)
      },
    } as any)

  test("a check whose tables the connection cannot read is named as skipped; the others still reach core", async () => {
    const spy = connect((sql) => {
      if (sql === DATABRICKS_CLUSTER_FACTS_SQL) throw new Error("[INSUFFICIENT_PERMISSIONS] system.compute.node_timeline\nstack")
      return sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : table(JOB_ROW)
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    spy.mockRestore()
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([{ check: "Idle Cluster Detection", reason: "[INSUFFICIENT_PERMISSIONS] system.compute.node_timeline" }])
    expect([result.warehouses_checked, result.clusters_checked, result.jobs_checked]).toEqual([1, 0, 1])
    // Every query takes only the window end: it reads every workspace the system tables show.
    expect(calls.map((one) => one.sql)).toEqual([DATABRICKS_WAREHOUSE_FACTS_SQL, DATABRICKS_CLUSTER_FACTS_SQL, DATABRICKS_JOB_FACTS_SQL])
    for (const one of calls) expect(one.binds).toEqual(["2026-11-18"])
    expect(sent.lookback_days).toBe(7)
    expect(sent.warehouses[0]).toMatchObject({ workspace_id: "111", warehouse_id: "abc123", warehouse_size: "SMALL", total_cost: 27.5 })
    expect(result.warehouses?.[0]).toMatchObject({ id: "abc123", workspace_id: "111" })
    expect(sent.clusters).toEqual([])
    expect(sent.jobs[0]).toMatchObject({ workspace_id: "222", job_id: "j1", trigger_type: null, listed_in_job_inventory: true, run_trigger_type: "ONE_TIME" })
    expect(result.limited).toEqual([])
  })

  test("a query that fills the row limit is named, and the tool says so", async () => {
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : sql === DATABRICKS_JOB_FACTS_SQL ? table(JOB_ROW, true) : table({ cluster_id: "c1" })))
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    spy.mockRestore()
    expect(calls.every((one) => one.limit === 10_000)).toBe(true)
    expect(result.limited).toEqual(["jobs"])
    expect(formatSavings(result)).toContain("Only the first 10,000 jobs were read; any beyond them were not checked.")
  })

  test("when core refuses the cluster or job facts, the warehouse findings still report and those checks are named", async () => {
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : sql === DATABRICKS_JOB_FACTS_SQL ? table(JOB_ROW) : table({ cluster_id: "c1" })))
    const calls: any[] = []
    const picky = (input: string) => {
      const parsed = JSON.parse(input)
      calls.push(parsed)
      if (parsed.clusters.length > 0 || parsed.jobs.length > 0) throw new Error("invalid input: jobs[0].job_total_cost must not be negative")
      return rules(input)
    }
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, picky)
    spy.mockRestore()
    expect(result.success).toBe(true)
    expect(calls.length).toBe(2)
    expect(sent.warehouses[0].warehouse_id).toBe("abc123")
    expect(result.skipped?.map((one) => one.check)).toEqual(["Idle Cluster Detection", "Job Running on All-Purpose Compute"])
    expect(result.skipped?.[0]?.reason).toContain("core refused their facts: invalid input: jobs[0].job_total_cost")
    expect([result.clusters_checked, result.jobs_checked]).toEqual([0, 0])
  })

  test("a blank connection name falls back to the connection that runs through a SQL warehouse", async () => {
    Registry.setConfigs({
      cluster: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/protocolv1/o/1/0101-abc", access_token: "x" },
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
    })
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : { columns: [], rows: [], truncated: false }))
    const result = await databricksSavings({ warehouse: " ", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    spy.mockRestore()
    expect(result.success).toBe(true)
    expect(result.warehouse).toBe("dbx")
  })
})

describe("every workspace", () => {
  test("a finding names its workspace in the output", () => {
    const report = JSON.parse(JSON.stringify(REPORT))
    report.report.findings[0].workspace_id = "2056943136844690"
    expect(formatSavings(report)).toContain("(sql warehouse, workspace 2056943136844690) · ")
  })

  test("a connection through the older /sql/1.0/endpoints/<id> path runs the check", async () => {
    Registry.setConfigs({
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/endpoints/abc123", access_token: "x" },
    })
    const spy = spyOn(Registry, "get").mockResolvedValue({
      execute: async () => ({ columns: ["warehouse_id"], rows: [["abc123"]], truncated: false }),
    } as any)
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, () => ({
      lookback_days: 7,
      findings: [],
      total: { monthly_min: 0, monthly_max: 0, resources: 0 },
      what_if: [],
    }))
    spy.mockRestore()
    Registry.reset()
    expect(result.success).toBe(true)
    expect(result.ran_on).toBe("abc123")
  })
})

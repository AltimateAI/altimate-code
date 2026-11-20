import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import { Permission } from "../../src/permission"
import { RunBudget } from "../../src/altimate/run-budget"
import {
  DATABRICKS_CLUSTER_FACTS_SQL,
  DATABRICKS_JOB_FACTS_SQL,
  DATABRICKS_WAREHOUSE_FACTS_SQL,
  SAVINGS_RUN_LIMIT_MS,
  databricksSavings,
  rulesEngine,
  savingsWindow,
  toClusterFacts,
  toFacts,
  toJobFacts,
} from "../../src/altimate/native/finops/databricks-savings"
import { FinopsDatabricksSavingsTool, formatSavings } from "../../src/altimate/tools/finops-databricks-savings"
import type { DatabricksSavingsResult } from "../../src/altimate/native/types"

/** Every spy a test installs, restored after it whether or not its assertions passed. */
const spies: { mockRestore(): void }[] = []
const tracked = <T extends { mockRestore(): void }>(spy: T): T => (spies.push(spy), spy)
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
})

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
        workspace_id: null,
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
  // The tool resolves the connection before it asks, so each run needs one configured.
  beforeEach(() => {
    Dispatcher.reset()
    Registry.setConfigs({ dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" } } as any)
  })
  afterEach(() => Registry.reset())

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

  test("the number of workspaces checked reaches the metadata", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({ ...REPORT, workspaces_checked: 3 }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.metadata.workspaces_checked).toBe(3)
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
      Registry.setConfigs({
        dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
      })
      const rules = () => ({ lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] })
      Dispatcher.register("finops.databricks_savings" as any, async (params: any) => (dispatched++, sent.push(params), databricksSavings(params, rules)))
      tracked(spyOn(Registry, "get")).mockImplementation((async () => {
        opened++
        return { execute: async () => (queried++, { columns: [], rows: [], truncated: false }) }
      }) as any)
    })
    afterEach(() => Registry.reset())

    test("a refusal runs nothing: no dispatch and no connection", async () => {
      const tool = await initTool(FinopsDatabricksSavingsTool)
      // An older caller's confirm flag no longer stands in for the user's answer.
      for (const args of [{ warehouse: "dbx" }, { warehouse: "dbx", confirm: true }])
        await expect(tool.execute(args, ctx(false))).rejects.toThrow("rejected permission")
      expect(asks).toHaveLength(2)
      for (const ask of asks) expect(ask).toMatchObject({ permission: "finops_databricks_savings", patterns: ["dbx"], always: ["dbx"] })
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
      expect(queried).toBe(0)
    })

    test("once allowed, the check runs on the warehouse", async () => {
      const tool = await initTool(FinopsDatabricksSavingsTool)
      const result = await tool.execute({}, ctx(true))
      // No connection named: the ask names the one the check picks, and the check runs on that one.
      expect(asks).toEqual([expect.objectContaining({ permission: "finops_databricks_savings", patterns: ["dbx"] })])
      expect(sent).toEqual([{ warehouse: "dbx" }])
      expect(dispatched).toBe(1)
      expect(opened).toBe(1)
      // Empty answers fail the check later on; what matters here is that it reached the warehouse.
      expect(queried).toBeGreaterThan(0)
      expect(result.output).toContain("savings check")
    })

    test("with no connection to run on, nothing is asked and nothing runs", async () => {
      Registry.setConfigs({} as any)
      const tool = await initTool(FinopsDatabricksSavingsTool)
      for (const args of [{}, { warehouse: "missing" }]) {
        const result = await tool.execute(args, ctx(true))
        expect(result.title).toBe("Databricks Savings: FAILED")
        expect(result.metadata).toMatchObject({ success: false })
      }
      expect(asks).toEqual([])
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
    })

    test("a connection that does not go through a SQL warehouse fails before the ask", async () => {
      Registry.setConfigs({
        dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/protocolv1/o/1/0101-cluster", access_token: "x" },
      } as any)
      const tool = await initTool(FinopsDatabricksSavingsTool)
      const result = await tool.execute({ warehouse: "dbx" }, ctx(true))
      expect(result.title).toBe("Databricks Savings: FAILED")
      expect(result.output).toContain("does not go through a SQL warehouse")
      expect(asks).toEqual([])
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
    })

    test("a rule for one connection holds however the call names it", async () => {
      Registry.setConfigs({ dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" }, other: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" } } as any)
      const rules = Permission.fromConfig({ finops_databricks_savings: { "*": "allow", dbx: "deny" } })
      // Answers the way the session's permission service does: the last matching rule wins.
      const decide = {
        ...stubCtx(),
        ask: async (input: any) => {
          asks.push(input)
          for (const pattern of input.patterns)
            if (Permission.evaluate(input.permission, pattern, rules).action === "deny") throw new Error("denied by rule")
        },
      }
      const tool = await initTool(FinopsDatabricksSavingsTool)
      // Omitted (the check would pick it) and padded with spaces (the check would trim them): both are denied.
      for (const args of [{}, { warehouse: " dbx " }]) await expect(tool.execute(args, decide)).rejects.toThrow("denied by rule")
      expect(asks.map((one) => one.patterns)).toEqual([["dbx"], ["dbx"]])
      expect(dispatched).toBe(0)
      expect(opened).toBe(0)
      await tool.execute({ warehouse: "other" }, decide)
      expect(sent).toEqual([{ warehouse: "other" }])
    })

    test("the description says it bills, stops after 9 minutes and asks first", async () => {
      const tool = await initTool(FinopsDatabricksSavingsTool)
      expect(tool.description).toContain("bills while the check runs; the check stops after 9 minutes, cancelling any query still running.")
      expect(tool.description).toContain("In an altimate-code session the user is asked for permission before the first query")
      expect(tool.description).toContain("a caller using it must get the user's go-ahead first, and over MCP the check is refused unless the server allows writes.")
      expect(tool.description).not.toContain("confirm")
    })
  })

  test("the session's stop signal reaches the check", async () => {
    let seen: unknown
    Dispatcher.register("finops.databricks_savings" as any, async (_params: unknown, context: unknown) => {
      seen = context
      return REPORT
    })
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const ctx = stubCtx()
    await tool.execute({}, ctx)
    expect(seen).toEqual({ signal: ctx.abort, sessionID: "test" })
  })

  test("no findings says so and still reports how many warehouses were checked", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      report: { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] },
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain("5 SQL warehouses, 0 all-purpose clusters, 0 jobs checked")
    expect(result.output).toEndWith("No savings found.")
  })

  test("no findings with a check skipped or cut at the row limit says only what was checked found none", () => {
    const empty = { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] }
    const skipped = [{ check: "Jobs on all-purpose clusters", reason: "[INSUFFICIENT_PERMISSIONS] system.lakeflow" }]
    expect(formatSavings({ ...REPORT, report: empty, skipped } as any)).toEndWith("No savings found in what could be checked.")
    expect(formatSavings({ ...REPORT, report: empty, limited: ["job task rows"] } as any)).toEndWith(
      "No savings found in what could be checked.",
    )
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

  test("a core without the savings rules is refused before connecting to the warehouse", async () => {
    Registry.setConfigs({
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
    })
    const get = tracked(spyOn(Registry, "get")).mockRejectedValue(new Error("opened a connection"))
    // A published core that predates the rules exports `initSdk` but not `databricksSavings`.
    const result = await databricksSavings({ warehouse: "dbx" }, rulesEngine({ initSdk: () => {} }))
    const connections = get.mock.calls.length
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      "This altimate-code build's altimate-core has no Databricks savings rules. Update altimate-code, then try again.",
    )
    expect(connections).toBe(0)
  })
})

describe("cluster and job findings", () => {
  beforeEach(() => {
    Dispatcher.reset()
    Registry.setConfigs({ dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" } } as any)
  })
  afterEach(() => Registry.reset())

  test("each kind of finding gets its own evidence lines, and a skipped check is named", async () => {
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      clusters_checked: 3,
      jobs_checked: 4,
      // A warehouse error can carry control and invisible characters; the line keeps only the text.
      skipped: [{ check: "Job Running on All-Purpose Compute", reason: "[INSUFFICIENT_PERMISSIONS]\u0007\u200b system.lakeflow.jobs" }],
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
          {
            check_id: "jobs_on_all_purpose_compute",
            title: "Job Running on All-Purpose Compute",
            resource_type: "job",
            resource_id: "42",
            resource_name: "nightly",
            severity: "medium",
            daily_min: 24,
            daily_max: 36,
            monthly_min: 720,
            monthly_max: 1080,
            evidence: { kind: "job_on_all_purpose", host_cluster_id: "0101-abc", host_cluster_name: "shared\nanalytics", trigger_type: "CRON", task_runs: 1234, task_hours: 70, estimated_dbus: 1700, all_purpose_rate_per_dbu: 0.55, jobs_rate_per_dbu: 0.33, jobs_rate_estimated: true, wasted_cost: 280 },
          },
        ],
        total: { monthly_min: 1485, monthly_max: 2610, resources: 2 },
        what_if: [],
      },
    }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain("5 SQL warehouses, 3 all-purpose clusters, 4 jobs checked")
    expect(result.output).toContain("Not checked: Job Running on All-Purpose Compute ([INSUFFICIENT_PERMISSIONS] system.lakeflow.jobs)")
    expect(result.output).toContain("shared-analytics (cluster) · Idle Cluster Detection · $765–$1,530 a month (critical)")
    expect(result.output).toContain("All-purpose cluster 85% idle across 5 active days (zombie), average worker CPU 8%, peak 30%")
    expect(result.output).toContain("Auto-termination off; $700.00 billed on all-purpose compute over the window")
    expect(result.output).toContain("nightly (job) · Job Running on All-Purpose Compute · $720–$1,080 a month (medium)")
    expect(result.output).toContain('1,234 task runs (cron), 70.0 hours on all-purpose compute, about 1,700.0 DBUs, most on cluster "shared analytics"')
    expect(result.output).toContain("$0.550 a DBU now; a job cluster would be about $0.330 (estimated: the workspace billed no jobs compute)")
  })

  test("a job's evidence reads right for one short run, and workspace names stay on one line", async () => {
    const finding = {
      check_id: "jobs_on_all_purpose_compute", title: "Job Running on All-Purpose Compute", resource_type: "job", resource_id: "42", resource_name: "nightly\nTotal: $0", severity: "medium",
      daily_min: 1, daily_max: 2, monthly_min: 30, monthly_max: 60,
      evidence: { kind: "job_on_all_purpose", host_cluster_id: "c", host_cluster_name: " a\n\u001b[2J\u200bb ", trigger_type: "PERIODIC", task_runs: 1, task_hours: 0.01, estimated_dbus: 0.02, all_purpose_rate_per_dbu: 0.55, jobs_rate_per_dbu: 0.15, jobs_rate_estimated: false, wasted_cost: 7 },
    }
    Dispatcher.register("finops.databricks_savings" as any, async () => ({ ...REPORT, report: { lookback_days: 7, findings: [finding], total: { monthly_min: 30, monthly_max: 60, resources: 1 }, what_if: [] } }))
    const tool = await initTool(FinopsDatabricksSavingsTool)
    const result = await tool.execute({}, stubCtx())
    expect(result.output).toContain('1 task run (periodic), under 0.1 hours on all-purpose compute, under 0.1 DBUs, most on cluster "a [2Jb"')
    expect(result.output).toContain("nightly Total: $0 (job)")
    // A name with nothing printable falls back to the id, for the job and for its cluster.
    Dispatcher.register("finops.databricks_savings" as any, async () => ({
      ...REPORT,
      report: {
        lookback_days: 7,
        findings: [{ ...finding, resource_name: " \u200b", evidence: { ...finding.evidence, host_cluster_name: "\u200b" } }],
        total: { monthly_min: 30, monthly_max: 60, resources: 1 },
        what_if: [{ resource_id: "wh1", resource_name: "BI\nTotal: $0", current_label: "SMALL (PRO)", current_monthly_cost: 10, choices: [] }],
      },
    }))
    const unnamed = await (await initTool(FinopsDatabricksSavingsTool)).execute({}, stubCtx())
    expect(unnamed.output).toContain("42 (job)")
    expect(unnamed.output).toContain('most on cluster "c"')
    expect(unnamed.output).toContain("What BI Total: $0 (now")
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
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY tl.workspace_id, tl.job_id, tl.task_key, tl.job_run_id, tl.run_id, tl.period_start_time")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY workspace_id, job_id, task_key, job_run_id, cluster_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY workspace_id, job_id, task_key, job_run_id\n")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY tr.workspace_id, tr.job_id, tr.task_key, tr.cluster_id, rt.trigger_type")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("LEFT JOIN inv ON inv.workspace_id = t.workspace_id AND inv.job_id = t.job_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("rt.workspace_id = tr.workspace_id AND rt.run_id = tr.job_run_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("LEFT JOIN cluster_bill cb ON cb.workspace_id = t.workspace_id AND cb.cluster_id = t.cluster_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("LEFT JOIN jobs_rate jr ON jr.workspace_id = t.workspace_id")
  })

  test("the job query finds runs through the compute they used, on live all-purpose clusters, for jobs not deleted", () => {
    // Billing leaves the job id empty on all-purpose compute, so it cannot find these jobs.
    expect(DATABRICKS_JOB_FACTS_SQL).not.toContain("usage_metadata.job_id")
    expect(DATABRICKS_CLUSTER_FACTS_SQL).not.toContain("usage_metadata.job_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("explode(t.compute_ids) AS compute_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("c.workspace_id = tl.workspace_id AND c.cluster_id = tl.compute_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("WHERE delete_time IS NULL AND cluster_source IN ('UI', 'API')")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("WHERE inv.delete_time IS NULL")
    // A row naming two all-purpose clusters counts once, and a run's hours add up its hourly rows.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("MAX(timestampdiff(SECOND, tl.period_start_time, tl.period_end_time)) AS seconds")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("SUM(seconds) / 3600.0 AS hours")
    // A run is credited to the cluster it spent most of its time on, the lowest id on a tie.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("MIN_BY(cluster_id, struct(-seconds, cluster_id)) AS cluster_id")
    // Latest inventory rows, the window on both timelines, one duration per billed period, the
    // jobs rate from jobs compute, and the largest rows first when the row limit cuts the list.
    expect(DATABRICKS_JOB_FACTS_SQL.match(/ORDER BY change_time DESC\) = 1/g)).toHaveLength(2)
    expect(DATABRICKS_JOB_FACTS_SQL.match(/period_start_time >= CAST\(DATE_SUB\(p\.we_date, 7\) AS TIMESTAMP\) AND \w+\.period_start_time < CAST\(p\.we_date AS TIMESTAMP\)/g)).toHaveLength(2)
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("GROUP BY workspace_id, cluster_id, usage_start_time, usage_end_time")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("FROM bill WHERE product = 'JOBS' GROUP BY workspace_id")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("ORDER BY t.task_hours DESC")
    // A timeline row with no job is left out, and a task with no key still gets one: core refuses
    // an empty id, and would take every cluster and job fact of the run with it.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("t.job_id IS NOT NULL AND t.job_id <> ''")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("COALESCE(NULLIF(TRIM(t.task_key), ''), '(no task key)') AS task_key")
    // The arithmetic each output column rests on, and every column the row mapping reads.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("SUM(seconds) AS seconds")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("COUNT(*) AS task_runs, SUM(tr.hours) AS task_hours")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("SUM(cost) AS cost, SUM(dbus) AS dbus, SUM(seconds) / 3600.0 AS billed_hours")
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("FROM bill WHERE product = 'ALL_PURPOSE' AND cluster_id IS NOT NULL")
    for (const column of ["job_name", "host_cluster_id", "host_cluster_name", "host_cluster_cost", "host_cluster_dbus", "host_cluster_billed_hours", "jobs_rate_per_dbu"]) {
      expect(DATABRICKS_JOB_FACTS_SQL).toContain(`AS ${column}`)
    }
    // A task run with no parent run id counts as its own run, as Altimate's hosted check reads it.
    expect(DATABRICKS_JOB_FACTS_SQL).toContain("COALESCE(NULLIF(t.job_run_id, ''), t.run_id) AS job_run_id")
    // The thresholds stay in core: every trigger is measured and handed over.
    expect(DATABRICKS_JOB_FACTS_SQL).not.toMatch(/CRON|PERIODIC|CONTINUOUS|HAVING/)
  })

  test("cluster and job rows are coerced to the facts core reads", () => {
    const cluster = toClusterFacts({ cluster_id: "c1", cluster_name: null, auto_termination_minutes: "120", total_node_minutes: 900n, active_util_days: "4", total_worker_minutes: 900, idle_node_minutes: 450, total_cost: "70.5" })
    expect(cluster).toMatchObject({ cluster_id: "c1", cluster_name: "c1", auto_termination_minutes: 120, total_node_minutes: 900, active_util_days: 4, total_cost: 70.5 })
    expect(toClusterFacts({ cluster_id: "c2" }).auto_termination_minutes).toBeNull()
    const job = toJobFacts({ workspace_id: 222n, job_id: 42n, job_name: "nightly", task_key: "main", trigger_type: "CRON", host_cluster_id: "c1", host_cluster_name: null, task_runs: 7n, task_hours: "3.5", host_cluster_cost: "55", host_cluster_dbus: 100, host_cluster_billed_hours: "10", jobs_rate_per_dbu: null })
    expect(job).toEqual({ job_id: "42", workspace_id: "222", job_name: "nightly", task_key: "main", trigger_type: "CRON", host_cluster_id: "c1", host_cluster_name: "c1", task_runs: 7, task_hours: 3.5, host_cluster_cost: 55, host_cluster_dbus: 100, host_cluster_billed_hours: 10, jobs_rate_per_dbu: null })
    expect(toJobFacts({ job_id: "j", host_cluster_id: "c1", host_cluster_name: "" }).host_cluster_name).toBe("c1")
    // A run whose trigger the timeline does not give stays unknown, and core does not count it.
    expect(toJobFacts({ job_id: "j2", task_key: "t", host_cluster_id: "c" })).toMatchObject({ trigger_type: null, job_name: "job j2", task_runs: 0, host_cluster_dbus: 0 })
  })
})

describe("databricks savings handler over a stubbed connection", () => {
  const WAREHOUSE_ROW = { workspace_id: "111", warehouse_id: "abc123", warehouse_name: "BI", warehouse_type: "PRO", warehouse_size: "SMALL", total_cost: 27.5 }
  const JOB_ROW = { workspace_id: "222", job_id: "j1", job_name: "nightly", task_key: "main", trigger_type: "CRON", host_cluster_id: "c1", host_cluster_name: "shared", task_runs: 9, task_hours: 4.5, host_cluster_cost: 55, host_cluster_dbus: 100, host_cluster_billed_hours: 10, jobs_rate_per_dbu: 0.15 }
  const table = (row: Record<string, unknown>, truncated = false) => ({ columns: Object.keys(row), rows: [Object.values(row)], truncated })
  let calls: { sql: string; limit: number; binds: unknown[]; timeout?: number; clientTimeout?: number; signal?: AbortSignal }[]
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
    tracked(spyOn(Registry, "get")).mockResolvedValue({
      execute: async (sql: string, limit: number, binds: unknown[], options?: { cancelAfterMs?: number; queryTimeoutMs?: number; signal?: AbortSignal }) => {
        calls.push({ sql, limit, binds, timeout: options?.cancelAfterMs, clientTimeout: options?.queryTimeoutMs, signal: options?.signal })
        return answer(sql)
      },
    } as any)

  test("a check whose tables the connection cannot read is named as skipped; the others still reach core", async () => {
    const spy = connect((sql) => {
      if (sql === DATABRICKS_CLUSTER_FACTS_SQL) throw new Error("[INSUFFICIENT_PERMISSIONS] system.compute.node_timeline\nstack")
      return sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : table(JOB_ROW)
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([{ check: "Idle Cluster Detection", reason: "[INSUFFICIENT_PERMISSIONS] system.compute.node_timeline" }])
    expect([result.warehouses_checked, result.clusters_checked, result.jobs_checked]).toEqual([1, 0, 1])
    // Every query takes only the window end: it reads every workspace the system tables show.
    expect(calls.map((one) => one.sql)).toEqual([DATABRICKS_WAREHOUSE_FACTS_SQL, DATABRICKS_CLUSTER_FACTS_SQL, DATABRICKS_JOB_FACTS_SQL])
    for (const one of calls) expect(one.binds).toEqual(["2026-11-18"])
    // Each query gets what is left of the check's 9 minutes, cancelled on the warehouse when it runs
    // out; none sets a client-only timeout that would abandon a query still running.
    expect(SAVINGS_RUN_LIMIT_MS).toBe(540_000)
    for (const one of calls) {
      expect(one.timeout).toBeGreaterThan(SAVINGS_RUN_LIMIT_MS - 5_000)
      expect(one.timeout).toBeLessThanOrEqual(SAVINGS_RUN_LIMIT_MS)
      expect(one.clientTimeout).toBeUndefined()
    }
    expect(sent.lookback_days).toBe(7)
    expect(sent.warehouses[0]).toMatchObject({ workspace_id: "111", warehouse_id: "abc123", warehouse_size: "SMALL", total_cost: 27.5 })
    expect(result.warehouses?.[0]).toMatchObject({ id: "abc123", workspace_id: "111" })
    expect(sent.clusters).toEqual([])
    expect(sent.jobs[0]).toMatchObject({ workspace_id: "222", job_id: "j1", task_key: "main", trigger_type: "CRON", host_cluster_id: "c1", task_runs: 9, task_hours: 4.5 })
    expect(result.limited).toEqual([])
  })

  test("a job counts once however many task rows it has, and the same id in two workspaces is two jobs", async () => {
    const row = (workspace: string, task: string) => Object.values({ ...JOB_ROW, workspace_id: workspace, task_key: task })
    const spy = connect((sql) =>
      sql === DATABRICKS_WAREHOUSE_FACTS_SQL
        ? table(WAREHOUSE_ROW)
        : sql === DATABRICKS_JOB_FACTS_SQL
          ? { columns: Object.keys(JOB_ROW), rows: [row("222", "a"), row("222", "b"), row("333", "a")], truncated: false }
          : { columns: [], rows: [], truncated: false },
    )
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(sent.jobs).toHaveLength(3)
    expect(result.jobs_checked).toBe(2)
    expect(result.success).toBe(true)
  })

  test("job ids of any type count, so a finished run cannot fail on them", async () => {
    const row = (job: unknown) => Object.values({ ...JOB_ROW, workspace_id: 222n, job_id: job })
    const spy = connect((sql) =>
      sql === DATABRICKS_WAREHOUSE_FACTS_SQL
        ? table(WAREHOUSE_ROW)
        : sql === DATABRICKS_JOB_FACTS_SQL
          ? { columns: Object.keys(JOB_ROW), rows: [row(42n), row(43n)], truncated: false }
          : { columns: [], rows: [], truncated: false },
    )
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(true)
    expect(result.jobs_checked).toBe(2)
  })

  const timeout = (cancelled: boolean) => Object.assign(new Error("QUERY_TIMEOUT: databricks query exceeded"), { code: "QUERY_TIMEOUT", cancelled })

  test("a required query past its limit fails the check with a plain reason", async () => {
    connect((sql) => {
      if (sql === DATABRICKS_WAREHOUSE_FACTS_SQL) throw timeout(true)
      return table(JOB_ROW)
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(false)
    expect(result.error).toBe("The SQL warehouses query ran past the check's 9-minute limit and was cancelled on the warehouse.")
  })

  test("an optional query past its limit skips only its check", async () => {
    connect((sql) => {
      if (sql === DATABRICKS_JOB_FACTS_SQL) throw timeout(false)
      return sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : table({ cluster_id: "c1" })
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([
      { check: "Job Running on All-Purpose Compute", reason: "The jobs query ran past the check's 9-minute limit and may still be running on the warehouse." },
    ])
  })

  test("a query is not started once the check's 9 minutes are used up", async () => {
    const realNow = Date.now
    let now = realNow()
    const clock = tracked(spyOn(Date, "now")).mockImplementation(() => now)
    const spy = connect((sql) => {
      // The warehouse query takes the whole limit.
      if (sql === DATABRICKS_WAREHOUSE_FACTS_SQL) now += SAVINGS_RUN_LIMIT_MS
      return table(WAREHOUSE_ROW)
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(calls.map((one) => one.sql)).toEqual([DATABRICKS_WAREHOUSE_FACTS_SQL])
    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([
      { check: "Idle Cluster Detection", reason: "The all-purpose clusters query was not started: it would run past the check's 9-minute limit." },
      { check: "Job Running on All-Purpose Compute", reason: "The jobs query was not started: it would run past the check's 9-minute limit." },
    ])
  })

  test("every workspace a checked row came from is counted, with or without a finding or a SQL warehouse", async () => {
    // Workspace 111 has the SQL warehouse; 333 has only a cluster and 222 only a job, and nothing is flagged.
    const CLUSTER_ROW = { workspace_id: "333", cluster_id: "c9", cluster_name: "adhoc", auto_termination_minutes: 30, total_node_minutes: 600, active_util_days: 3, total_worker_minutes: 600, idle_node_minutes: 60, total_cost: 12 }
    const rows = (...all: Record<string, unknown>[]) => ({ columns: Object.keys(all[0]!), rows: all.map((one) => Object.values(one)), truncated: false })
    const spy = connect((sql) => {
      if (sql === DATABRICKS_WAREHOUSE_FACTS_SQL) return table(WAREHOUSE_ROW)
      if (sql === DATABRICKS_CLUSTER_FACTS_SQL) return rows(CLUSTER_ROW, { ...CLUSTER_ROW, cluster_id: "c10", workspace_id: 333n })
      // A second task of the same workspace, and a row with no workspace, add nothing.
      return rows(JOB_ROW, { ...JOB_ROW, task_key: "other" }, { ...JOB_ROW, job_id: "j2", workspace_id: null })
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(true)
    expect(result.report?.findings).toEqual([])
    expect([result.warehouses_checked, result.clusters_checked, result.jobs_checked]).toEqual([1, 2, 2])
    expect(result.workspaces_checked).toBe(3)
  })

  test("connecting counts toward the limit: a connection that never comes up ends the check in time", async () => {
    // A 30 ms session budget stands in for the last moments of the 9 minutes.
    const budget = tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() + 30)
    const get = tracked(spyOn(Registry, "get")).mockReturnValue(new Promise(() => {}) as any)
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules, { sessionID: "s1" })
    expect(result.success).toBe(false)
    expect(result.error).toBe("Connecting to the warehouse took longer than the run's time budget.")
  })

  test("a session that already stopped does not connect to the warehouse at all", async () => {
    const controller = new AbortController()
    controller.abort(new Error("session stopped"))
    const get = tracked(spyOn(Registry, "get")).mockRejectedValue(new Error("connected"))
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules, { signal: controller.signal })
    expect(result).toMatchObject({ success: false, error: "session stopped" })
    expect(get).not.toHaveBeenCalled()
  })

  test("a session time budget already used up does not connect to the warehouse at all", async () => {
    tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() - 1)
    const get = tracked(spyOn(Registry, "get")).mockRejectedValue(new Error("connected"))
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules, { sessionID: "s1" })
    expect(result).toMatchObject({ success: false, error: "Connecting to the warehouse was not started: the run's time budget had already passed." })
    expect(get).not.toHaveBeenCalled()
  })

  test("a session time budget shorter than 9 minutes is the limit", async () => {
    const budget = tracked(spyOn(RunBudget, "queryDeadline")).mockReturnValue(Date.now() + 60_000)
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : table(JOB_ROW)))
    await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules, { sessionID: "s1" })
    for (const one of calls) expect(one.timeout).toBeLessThanOrEqual(60_000)
  })

  test("stopping the session cancels the running query and starts no other", async () => {
    const controller = new AbortController()
    const spy = connect((sql) => {
      if (sql === DATABRICKS_CLUSTER_FACTS_SQL) {
        controller.abort(new Error("session stopped"))
        throw new Error("session stopped")
      }
      return table(WAREHOUSE_ROW)
    })
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules, { signal: controller.signal })
    expect(result.success).toBe(false)
    expect(result.error).toBe("session stopped")
    // Each query got the session's signal, so the driver cancels it on the warehouse.
    for (const one of calls) expect(one.signal).toBe(controller.signal)
    // The jobs query never started, and the stop is not reported as a skipped check.
    expect(calls.map((one) => one.sql)).toEqual([DATABRICKS_WAREHOUSE_FACTS_SQL, DATABRICKS_CLUSTER_FACTS_SQL])
  })

  test("a query that fills the row limit is named, and the tool says so", async () => {
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : sql === DATABRICKS_JOB_FACTS_SQL ? table(JOB_ROW, true) : table({ cluster_id: "c1" })))
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(calls.every((one) => one.limit === 10_000)).toBe(true)
    expect(result.limited).toEqual(["job task rows"])
    expect(formatSavings(result)).toContain("Only the first 10,000 job task rows were read; any beyond them were not checked.")
  })

  test("when core refuses the cluster or job facts, the warehouse findings still report and those checks are named", async () => {
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : sql === DATABRICKS_JOB_FACTS_SQL ? table(JOB_ROW) : table({ cluster_id: "c1" })))
    const calls: any[] = []
    const picky = (input: string) => {
      const parsed = JSON.parse(input)
      calls.push(parsed)
      if (parsed.clusters.length > 0 || parsed.jobs.length > 0) throw new Error("invalid input: jobs[0].task_hours must not be negative")
      return rules(input)
    }
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, picky)
    expect(result.success).toBe(true)
    expect(calls.length).toBe(2)
    expect(sent.warehouses[0].warehouse_id).toBe("abc123")
    expect(result.skipped?.map((one) => one.check)).toEqual(["Idle Cluster Detection", "Job Running on All-Purpose Compute"])
    expect(result.skipped?.[0]?.reason).toContain("core refused their facts: invalid input: jobs[0].task_hours")
    expect([result.clusters_checked, result.jobs_checked]).toEqual([0, 0])
  })

  test("a blank connection name falls back to the connection that runs through a SQL warehouse", async () => {
    Registry.setConfigs({
      cluster: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/protocolv1/o/1/0101-abc", access_token: "x" },
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
    })
    const spy = connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : { columns: [], rows: [], truncated: false }))
    const result = await databricksSavings({ warehouse: " ", now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
    expect(result.success).toBe(true)
    expect(result.warehouse).toBe("dbx")
  })

  test("a hand-edited connection whose type is not text is passed over, not a crash", async () => {
    Registry.setConfigs({
      odd: { type: 42, server_hostname: "x", http_path: "/sql/1.0/warehouses/zzz", access_token: "x" },
      dbx: { type: "databricks", server_hostname: "dbc-0.cloud.databricks.com", http_path: "/sql/1.0/warehouses/abc123", access_token: "x" },
    } as any)
    connect((sql) => (sql === DATABRICKS_WAREHOUSE_FACTS_SQL ? table(WAREHOUSE_ROW) : { columns: [], rows: [], truncated: false }))
    const result = await databricksSavings({ now_ms: Date.parse("2026-11-18T10:00:00Z") }, rules)
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
    const spy = tracked(spyOn(Registry, "get")).mockResolvedValue({
      execute: async () => ({ columns: ["warehouse_id"], rows: [["abc123"]], truncated: false }),
    } as any)
    const result = await databricksSavings({ warehouse: "dbx", now_ms: Date.parse("2026-11-18T10:00:00Z") }, () => ({
      lookback_days: 7,
      findings: [],
      total: { monthly_min: 0, monthly_max: 0, resources: 0 },
      what_if: [],
    }))
    Registry.reset()
    expect(result.success).toBe(true)
    expect(result.ran_on).toBe("abc123")
  })
})

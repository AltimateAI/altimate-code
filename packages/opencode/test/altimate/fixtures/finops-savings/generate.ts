// altimate_change - new file
/**
 * Regenerates the savings report fixtures from a real altimate-core binding, so the formatter tests read the
 * evidence shape core actually returns rather than one written by hand.
 *
 *   bun test/altimate/fixtures/finops-savings/generate.ts <path to the binding's index.js> <core commit>
 *
 * The facts are synthetic: every warehouse, cluster, job and workspace name below is made up.
 */
import { writeFileSync } from "fs"
import path from "path"

const [bindingPath, coreCommit] = process.argv.slice(2)
if (!bindingPath || !coreCommit) throw new Error("usage: generate.ts <binding index.js> <core commit>")
const core = require(path.resolve(bindingPath)) as {
  databricksSavings(input: string): unknown
  snowflakeSavings(input: string): unknown
}

const WORKSPACE = "1000000000000001"
// A second workspace that billed no jobs compute, so its job rate is core's fallback rather than a measured one.
const OTHER_WORKSPACE = "1000000000000002"
const DAYS = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11"]

const warehouse = (over: Record<string, unknown>) => ({
  workspace_id: WORKSPACE,
  wall_clock_uptime_sec: 100_800,
  cluster_weighted_uptime_sec: 100_800,
  idle_ratio: 0.1,
  total_dbu_consumed: 600,
  total_cost: 1_320,
  price_per_dbu: 2.2,
  serverless_price_per_dbu: 0.7,
  total_query_count: 4_000,
  parallelism_query_count: 3_500,
  parallelism_ratio_p50: 1,
  parallelism_ratio_p99: 3,
  parallelism_ratio_max: 6,
  no_spill_query_pct: 0.99,
  no_queue_query_pct: 0.99,
  ...over,
})

const databricks = {
  lookback_days: 7,
  warehouses: [
    // Classic, mostly idle: cheaper as serverless.
    warehouse({ warehouse_id: "wh-idle-classic", warehouse_name: "synthetic idle classic", warehouse_type: "CLASSIC", warehouse_size: "SMALL", idle_ratio: 0.85 }),
    // Large and barely parallel: one or more sizes too big.
    warehouse({ warehouse_id: "wh-oversized", warehouse_name: "synthetic oversized pro", warehouse_type: "PRO", warehouse_size: "LARGE" }),
    // No size reported: no size-based finding, but the serverless one still applies.
    warehouse({ warehouse_id: "wh-no-size", warehouse_name: "synthetic sizeless", warehouse_type: "PRO", warehouse_size: null, idle_ratio: 0.7 }),
  ],
  clusters: [
    {
      cluster_id: "cluster-idle",
      workspace_id: WORKSPACE,
      cluster_name: "synthetic idle cluster",
      auto_termination_minutes: 120,
      total_node_minutes: 6_000,
      active_util_days: 6,
      total_worker_minutes: 6_000,
      idle_node_minutes: 5_200,
      avg_cpu_active_pct: 3.5,
      peak_cpu_active_pct: 22,
      total_cost: 900,
    },
    {
      cluster_id: "cluster-no-autostop",
      workspace_id: OTHER_WORKSPACE,
      cluster_name: "synthetic always-on cluster",
      auto_termination_minutes: null,
      total_node_minutes: 9_000,
      active_util_days: 7,
      total_worker_minutes: 9_000,
      idle_node_minutes: 4_000,
      avg_cpu_active_pct: 12,
      peak_cpu_active_pct: 60,
      total_cost: 1_400,
    },
  ],
  jobs: [
    {
      job_id: "1001",
      workspace_id: WORKSPACE,
      job_name: "synthetic nightly job",
      task_key: "load",
      trigger_type: "CRON",
      host_cluster_id: "cluster-idle",
      host_cluster_name: "synthetic idle cluster",
      task_runs: 7,
      task_hours: 14,
      host_cluster_cost: 900,
      host_cluster_dbus: 400,
      host_cluster_billed_hours: 100,
      jobs_rate_per_dbu: 0.3,
    },
    {
      job_id: "1002",
      workspace_id: OTHER_WORKSPACE,
      job_name: "synthetic continuous job",
      task_key: "stream",
      trigger_type: "CONTINUOUS",
      host_cluster_id: "cluster-no-autostop",
      host_cluster_name: "synthetic always-on cluster",
      task_runs: 1,
      task_hours: 150,
      host_cluster_cost: 1_400,
      host_cluster_dbus: 700,
      host_cluster_billed_hours: 160,
      jobs_rate_per_dbu: null,
    },
  ],
}

const sfWarehouse = (over: Record<string, unknown>) => ({
  warehouse_type: "STANDARD",
  min_cluster_count: 1,
  max_cluster_count: 1,
  query_count: 0,
  sub_five_second_queries: 0,
  sub_five_second_credits: 0,
  usage_days: [],
  idle_days: [],
  cluster_days: [],
  restart_days: [],
  ...over,
})

const snowflake = {
  lookback_days: 7,
  price_per_credit: 3,
  warehouses: [
    // Idle for most of its active time.
    sfWarehouse({
      warehouse_id: "101",
      warehouse_name: "SYNTHETIC_IDLE_WH",
      warehouse_size: "Small",
      idle_days: DAYS.map((day) => ({ day, active_seconds: 36_000, idle_seconds: 27_000, credits_used: 20 })),
    }),
    // Nearly every query finishes in under five seconds: one size smaller.
    sfWarehouse({
      warehouse_id: "102",
      warehouse_name: "SYNTHETIC_FAST_WH",
      warehouse_size: "Large",
      query_count: 10_000,
      sub_five_second_queries: 9_800,
      sub_five_second_credits: 40,
      usage_days: DAYS.map((day) => ({ day, credits_used: 24, active_periods: 40, short_periods: 38 })),
    }),
    // Its top cluster is barely needed: no dollar estimate.
    sfWarehouse({
      warehouse_id: "103",
      warehouse_name: "SYNTHETIC_MULTI_WH",
      warehouse_size: "Medium",
      max_cluster_count: 3,
      cluster_days: DAYS.map((day) => ({
        day,
        clusters: [
          { cluster_number: 1, idle_seconds: 3_000, busy_seconds: 30_000 },
          { cluster_number: 2, idle_seconds: 6_000, busy_seconds: 6_000 },
          { cluster_number: 3, idle_seconds: 2_700, busy_seconds: 300 },
        ],
      })),
    }),
    // Suspends and resumes within a billed minute.
    sfWarehouse({
      warehouse_id: "104",
      warehouse_name: "SYNTHETIC_BOUNCY_WH",
      warehouse_size: "X-Large",
      restart_days: DAYS.map((day) => ({ day, gaps: [{ gap_seconds: 20, bounces: 30 }, { gap_seconds: 45, bounces: 10 }] })),
    }),
  ],
}

// Nothing billed at a dollar rate: core finds nothing worth a saving.
const databricksUnpriced = {
  lookback_days: 7,
  warehouses: [
    warehouse({ warehouse_id: "wh-unpriced", warehouse_name: "synthetic unpriced", warehouse_type: "CLASSIC", warehouse_size: "MEDIUM", idle_ratio: 0.9, total_cost: 0, price_per_dbu: 0 }),
  ],
  clusters: [{ ...databricks.clusters[0], cluster_id: "cluster-unpriced", cluster_name: "synthetic unpriced cluster", total_cost: 0 }],
  jobs: [],
}

// Only the multi-cluster finding, which carries no dollar estimate.
const snowflakeUnpriced = { ...snowflake, warehouses: [snowflake.warehouses[2]] }

const here = path.dirname(new URL(import.meta.url).pathname)
for (const [name, input, run] of [
  ["databricks-report.json", databricks, core.databricksSavings],
  ["databricks-unpriced-report.json", databricksUnpriced, core.databricksSavings],
  ["snowflake-report.json", snowflake, core.snowflakeSavings],
  ["snowflake-unpriced-report.json", snowflakeUnpriced, core.snowflakeSavings],
] as const) {
  const report = run(JSON.stringify(input))
  writeFileSync(path.join(here, name), JSON.stringify({ generated_by: "generate.ts", core_commit: coreCommit, input, report }, null, 2) + "\n")
  const kinds = (report as { findings: { evidence: { kind: string } }[] }).findings.map((one) => one.evidence.kind)
  console.log(name, kinds.join(", ") || "(no findings)")
}

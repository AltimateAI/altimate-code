// altimate_change - new file
//
// #1336 — the FinOps tools resolve only local connections, so in a project bound to a
// workspace whose warehouse credentials live in the workspace they all fail, and the
// failure said nothing about the engine tool that works. These prove the failure now
// names the reason and the engine tool — and only when the workspace really serves a
// type the operation supports, for a caller who may call that tool.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Registry from "../../src/altimate/native/connections/registry"
import { precedenceInternals, refresh, resetForTests } from "../../src/altimate/workspace/precedence"
import {
  withWorkspaceFallback,
  workspaceFallbackNote,
  workspaceFallbacks,
} from "../../src/altimate/tools/finops-workspace"
import { registerAll as registerFinops } from "../../src/altimate/native/finops/register"
import { DEFAULT_FINOPS_TYPES } from "../../src/altimate/native/finops/warehouse-resolver"
import { ANALYST_RULESET, BIGQUERY_TOOLS, SNOWFLAKE_TOOLS, bindTo } from "./workspace/precedence-fixture"

const SESSION = "ses_finops_fallback"
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE
const ORIGINAL_INTEGRATIONS = process.env.ALTIMATE_INTEGRATIONS
const ORIGINAL_TELEMETRY = process.env.ALTIMATE_TELEMETRY_DISABLED

const failed = (): { title: string; metadata: Record<string, unknown>; output: string } => ({
  title: "Warehouse Advice: FAILED",
  metadata: { success: false, error: "none configured" },
  output: "Failed to analyze warehouses: none configured",
})

beforeEach(() => {
  resetForTests()
  delete process.env.ALTIMATE_INTEGRATIONS
  process.env.ALTIMATE_WORKSPACE = "1"
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  bindTo(42, "analytics")
  // `refresh` queues an announcement; keep it off the real event bridge. (bot review)
  precedenceInternals.announce = async () => {}
  // The pilot's promise: no local warehouse connection at all.
  Registry.setConfigs({})
})

afterEach(() => {
  resetForTests()
  Registry.reset()
  if (ORIGINAL_TELEMETRY === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = ORIGINAL_TELEMETRY
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
  if (ORIGINAL_INTEGRATIONS === undefined) delete process.env.ALTIMATE_INTEGRATIONS
  else process.env.ALTIMATE_INTEGRATIONS = ORIGINAL_INTEGRATIONS
})

describe("workspaceFallbacks", () => {
  test("names the engine execute tool for a served type the operation supports", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(await workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toEqual({
      state: "current",
      reason: "served",
      fallbacks: [
        { workspaceName: "analytics", workspaceId: "42", type: "snowflake", modelKey: "datamate_snowflake_execute_database_query" },
      ],
    })
  })

  test("is empty for a session with no routing decision", async () => {
    expect(await workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toMatchObject({ state: "current", fallbacks: [] })
  })

  test("is empty when routing is disabled for the session", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(await workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toMatchObject({ state: "current", fallbacks: [] })
  })

  test("ignores a served type the operation does not support", async () => {
    await refresh(SESSION, BIGQUERY_TOOLS)
    // The Snowflake-only operations (role hierarchy, user roles) get nothing from a
    // workspace that serves only BigQuery.
    expect(await workspaceFallbacks(SESSION, ["snowflake"])).toMatchObject({ state: "current", fallbacks: [] })
    const lookup = await workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)
    expect(lookup.state === "current" && lookup.fallbacks.map((f) => f.type)).toEqual(["bigquery"])
  })

  test("never names a tool the caller's agent cannot call", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS, ANALYST_RULESET)
    expect(await workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toMatchObject({ state: "current", fallbacks: [] })
  })
})

describe("workspaceFallbackNote", () => {
  const snowflake = [
    { workspaceName: "analytics", workspaceId: "42", type: "snowflake", modelKey: "datamate_snowflake_execute_database_query" },
  ]

  test("says why the tool cannot run here and where the same query runs, with the canonical identity", () => {
    const note = workspaceFallbackNote("warehouse_advice", snowflake)!
    expect(note).toContain('workspace "analytics" (id 42) serves snowflake')
    expect(note).toContain("configured on this machine")
    expect(note).toContain("`SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY`")
    expect(note).toContain("`datamate_snowflake_execute_database_query`")
  })

  test("the tables named are the operation's own, not a generic usage view", () => {
    // Grants do not live in the usage tables; a wrong table on a real failure path
    // sends the model down a dead end. (bot review)
    const bigquery = [{ workspaceName: "analytics", type: "bigquery", modelKey: "datamate_bigquery_execute_database_query" }]
    expect(workspaceFallbackNote("role_grants", bigquery)).toContain("`region-<location>.INFORMATION_SCHEMA.OBJECT_PRIVILEGES`")
    expect(workspaceFallbackNote("role_grants", bigquery)).not.toContain("JOBS")
    expect(workspaceFallbackNote("query_history", bigquery)).toContain("`region-<location>.INFORMATION_SCHEMA.JOBS`")
    // Every BigQuery recipe is region-qualified: the bare view name is not runnable.
    for (const op of ["query_history", "analyze_credits", "expensive_queries", "warehouse_advice", "unused_resources", "role_grants"] as const) {
      expect(workspaceFallbackNote(op, bigquery)).toMatch(/region-<location>\.INFORMATION_SCHEMA/)
      // …and the placeholder is explained, since the snapshot carries no location.
      expect(workspaceFallbackNote(op, bigquery)).toContain("for example `us`, `eu`")
      expect(workspaceFallbackNote(op, bigquery)).not.toContain("`region-us`")
    }
    expect(workspaceFallbackNote("query_history", snowflake)).not.toContain("<location>")
    expect(workspaceFallbackNote("unused_resources", snowflake)).toContain("`QUERY_HISTORY`")
    expect(workspaceFallbackNote("warehouse_advice", snowflake)).toContain("`SHOW WAREHOUSES`")
    const databricks = [{ workspaceName: "analytics", type: "databricks", modelKey: "datamate_databricks_execute_sql" }]
    expect(workspaceFallbackNote("role_grants", databricks)).toContain("`system.information_schema.table_privileges`")
    expect(workspaceFallbackNote("user_roles", snowflake)).toContain("`SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS`")
    // No table known for the pair: the tool alone, never a table that holds something else.
    expect(workspaceFallbackNote("user_roles", databricks)).toContain("for databricks, use `datamate_databricks_execute_sql`")
  })

  test("a workspace name with quotes cannot break the delimiters", () => {
    const note = workspaceFallbackNote("query_history", [{ ...snowflake[0], workspaceName: 'a"b\nc' }])!
    expect(note).toContain('workspace "a\\"b c" (id 42)')
    expect(note).not.toContain("\n")
  })

  test("is nothing when the workspace serves none of the operation's types", () => {
    expect(workspaceFallbackNote("query_history", [])).toBeUndefined()
  })
})

describe("withWorkspaceFallback", () => {
  test("keeps the local failure and appends the workspace route", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const result = await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, failed())
    expect(result.title).toBe("Warehouse Advice: FAILED")
    expect(result.output.startsWith("Failed to analyze warehouses: none configured")).toBe(true)
    expect(result.output).toContain("`datamate_snowflake_execute_database_query`")
    expect(result.metadata).toEqual({
      success: false,
      error: "none configured",
      workspace_fallback: ["datamate_snowflake_execute_database_query"],
    })
  })

  test("returns the failure untouched when routing is deliberately off (unbound)", async () => {
    precedenceInternals.binding = async () => null
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.disabledReason).toBe("unbound")
    const input = failed()
    const result = await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, input)
    expect(result).toBe(input)
  })

  test("no snapshot at all is unknown, as check() says, not silently local", async () => {
    // codex on #1346: a caller that never resolved tools, or an entry evicted between
    // resolution and this call. The precedence module reports that as undetermined.
    const result = await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, failed())
    expect(result.metadata.precedence).toBe("undetermined")
    expect(result.output).toContain("No routing decision was available")
  })

  test("a workspace the project has since left is not recommended (snapshot re-validated)", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    // Re-linked mid-call: the snapshot names 42, the link now says 43.
    precedenceInternals.binding = async () => ({ datamateId: 43, datamateName: "other" })
    const result = await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, failed())
    expect(result.output).not.toContain("datamate_")
    expect(result.metadata.workspace_fallback).toBeUndefined()
    expect(result.metadata.precedence).toBe("undetermined")
    expect(result.output).toContain("binding changed")
  })

  test("routing that could not be determined is said, and marked, rather than passed off as local-only", async () => {
    // The engine could not be attributed to the bound workspace this turn: the
    // snapshot is disabled for uncertainty, not by choice. (bot review)
    precedenceInternals.attributedTo = async () => "999"
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.disabledReason).toBe("unattributed")
    const result = await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, failed())
    expect(result.metadata.precedence).toBe("undetermined")
    expect(result.output).toContain("could not be determined this turn")
    expect(result.output).not.toContain("datamate_")
  })

  test("deliberate disablement stays a plain local failure", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.disabledReason).toBe("escape-hatch")
    const input = failed()
    expect(await withWorkspaceFallback(SESSION, "warehouse_advice", DEFAULT_FINOPS_TYPES, input)).toBe(input)
  })
})

describe("through the tools", () => {
  // The real handlers, registered here rather than through the dispatcher's lazy hook:
  // another file's `Dispatcher.reset()` removes that hook for the rest of the process.
  beforeEach(() => registerFinops())

  test("finops_warehouse_advice with no local connection names the engine tool", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const { FinopsWarehouseAdviceTool } = await import("../../src/altimate/tools/finops-warehouse-advice")
    const tool = await initTool(FinopsWarehouseAdviceTool)
    const result = await tool.execute({ warehouse: "COMPUTE_WH", days: 14 }, ctx())
    expect(result.title).toBe("Warehouse Advice: FAILED")
    // The local reason survives — a missing local connection is still a fact.
    expect(result.output).toContain("requires a configured warehouse")
    expect(result.output).toContain("`datamate_snowflake_execute_database_query`")
    expect(result.metadata.workspace_fallback).toEqual(["datamate_snowflake_execute_database_query"])
  })

  test("every finops_* wrapper routes its failure through the fallback (codex on #1346)", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const mods = await Promise.all([
      import("../../src/altimate/tools/finops-query-history"),
      import("../../src/altimate/tools/finops-analyze-credits"),
      import("../../src/altimate/tools/finops-expensive-queries"),
      import("../../src/altimate/tools/finops-unused-resources"),
      import("../../src/altimate/tools/finops-role-access"),
    ])
    const tools = [
      [mods[0].FinopsQueryHistoryTool, { warehouse: "COMPUTE_WH" }, "`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`"],
      [mods[1].FinopsAnalyzeCreditsTool, { days: 7 }, "WAREHOUSE_METERING_HISTORY"],
      [mods[2].FinopsExpensiveQueriesTool, {}, "`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`"],
      [mods[3].FinopsUnusedResourcesTool, {}, "TABLE_STORAGE_METRICS"],
      [mods[4].FinopsRoleGrantsTool, {}, "GRANTS_TO_ROLES"],
      [mods[4].FinopsRoleHierarchyTool, {}, "GRANTS_TO_ROLES"],
      [mods[4].FinopsUserRolesTool, {}, "GRANTS_TO_USERS"],
    ] as const
    for (const [def, args, table] of tools) {
      const tool = await initTool(def as never)
      const result = await tool.execute(args, ctx())
      // FAILED, not ERROR: the real handler's no-connection branch, not a wrapper catching
      // "No native handler". (bot review)
      expect(result.title, tool.id).toMatch(/FAILED$/)
      expect(result.output, tool.id).toContain("requires a configured warehouse")
      expect(result.output, tool.id).toContain("`datamate_snowflake_execute_database_query`")
      expect(result.output, tool.id).toContain(table)
      expect(result.metadata.workspace_fallback, tool.id).toEqual(["datamate_snowflake_execute_database_query"])
    }
  })

  test("finops_role_hierarchy is not pointed at a workspace that serves only BigQuery", async () => {
    await refresh(SESSION, BIGQUERY_TOOLS)
    const { FinopsRoleHierarchyTool } = await import("../../src/altimate/tools/finops-role-access")
    const tool = await initTool(FinopsRoleHierarchyTool)
    const result = await tool.execute({}, ctx())
    expect(result.title).toBe("Role Hierarchy: FAILED")
    expect(result.output).not.toContain("datamate_")
    expect(result.metadata.workspace_fallback).toBeUndefined()
  })

  test("an unbound project gets the plain local failure", async () => {
    precedenceInternals.binding = async () => null
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const { FinopsAnalyzeCreditsTool } = await import("../../src/altimate/tools/finops-analyze-credits")
    const tool = await initTool(FinopsAnalyzeCreditsTool)
    const result = await tool.execute({ days: 7 }, ctx())
    expect(result.title).toBe("Credit Analysis: FAILED")
    expect(result.output).not.toContain("datamate_")
    expect(result.output).not.toContain("workspace")
  })
})

function ctx(): any {
  return {
    sessionID: SESSION,
    messageID: "msg",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

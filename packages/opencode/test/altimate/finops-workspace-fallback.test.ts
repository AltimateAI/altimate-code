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
import { refresh, resetForTests } from "../../src/altimate/workspace/precedence"
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

const failed = () => ({
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
  // The pilot's promise: no local warehouse connection at all.
  Registry.setConfigs({})
})

afterEach(() => {
  resetForTests()
  Registry.reset()
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
  if (ORIGINAL_INTEGRATIONS === undefined) delete process.env.ALTIMATE_INTEGRATIONS
  else process.env.ALTIMATE_INTEGRATIONS = ORIGINAL_INTEGRATIONS
})

describe("workspaceFallbacks", () => {
  test("names the engine execute tool for a served type the operation supports", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toEqual([
      { workspaceName: "analytics", type: "snowflake", modelKey: "datamate_snowflake_execute_database_query" },
    ])
  })

  test("is empty for a session with no routing decision", () => {
    expect(workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toEqual([])
  })

  test("is empty when routing is disabled for the session", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toEqual([])
  })

  test("ignores a served type the operation does not support", async () => {
    await refresh(SESSION, BIGQUERY_TOOLS)
    // The Snowflake-only operations (role hierarchy, user roles) get nothing from a
    // workspace that serves only BigQuery.
    expect(workspaceFallbacks(SESSION, ["snowflake"])).toEqual([])
    expect(workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES).map((f) => f.type)).toEqual(["bigquery"])
  })

  test("never names a tool the caller's agent cannot call", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS, ANALYST_RULESET)
    expect(workspaceFallbacks(SESSION, DEFAULT_FINOPS_TYPES)).toEqual([])
  })
})

describe("workspaceFallbackNote", () => {
  test("says why the tool cannot run here and where the same query runs", () => {
    const note = workspaceFallbackNote([
      { workspaceName: "analytics", type: "snowflake", modelKey: "datamate_snowflake_execute_database_query" },
    ])!
    expect(note).toContain('workspace "analytics" serves snowflake')
    expect(note).toContain("configured on this machine")
    expect(note).toContain("`SNOWFLAKE.ACCOUNT_USAGE`")
    expect(note).toContain("`datamate_snowflake_execute_database_query`")
  })

  test("is nothing when the workspace serves none of the operation's types", () => {
    expect(workspaceFallbackNote([])).toBeUndefined()
  })
})

describe("withWorkspaceFallback", () => {
  test("keeps the local failure and appends the workspace route", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const result = withWorkspaceFallback(SESSION, DEFAULT_FINOPS_TYPES, failed())
    expect(result.title).toBe("Warehouse Advice: FAILED")
    expect(result.output.startsWith("Failed to analyze warehouses: none configured")).toBe(true)
    expect(result.output).toContain("`datamate_snowflake_execute_database_query`")
    expect(result.metadata as Record<string, unknown>).toEqual({
      success: false,
      error: "none configured",
      workspace_fallback: ["datamate_snowflake_execute_database_query"],
    })
  })

  test("returns the failure untouched when there is nothing to route to", () => {
    const input = failed()
    const result = withWorkspaceFallback(SESSION, DEFAULT_FINOPS_TYPES, input)
    expect(result).toBe(input)
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

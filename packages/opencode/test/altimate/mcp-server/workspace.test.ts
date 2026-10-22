import { expect, test, spyOn } from "bun:test"
import { fileURLToPath } from "node:url"
import { allowedEngineRead, checkEngineRead, createWorkspaceAdapter } from "../../../src/altimate/mcp-server/workspace"
import * as WorkspaceClient from "../../../src/altimate/workspace/client"
import * as Probes from "../../../src/altimate/workspace/engine-probes"

test("only the supported workspace read capabilities cross the facade", () => {
  for (const name of [
    "ask_knowledge_base",
    "snowflake_get_table_stats",
    "snowflake_execute_database_query",
    "bigquery_execute_database_query",
    "postgresql_execute_database_query",
    "databricks_execute_sql",
  ]) {
    expect(allowedEngineRead(name)).toBe(true)
  }
  for (const name of [
    "datamate_add_memories",
    "snowflake_create_table",
    "execute_database_query",
    "shell",
    "ask_knowledge_base_delete",
  ]) {
    expect(allowedEngineRead(name)).toBe(false)
    expect(() => checkEngineRead(name, { query: "SELECT 1" })).toThrow("not exposed")
  }
})

test("workspace SQL reuses the native classifier and refuses mutation, hidden side effects and absent SQL", () => {
  expect(() => checkEngineRead("snowflake_execute_database_query", { query: "SELECT 1" })).not.toThrow()
  expect(() =>
    checkEngineRead("postgresql_execute_database_query", { sql: "SELECT count(*) FROM orders" }),
  ).not.toThrow()
  for (const query of ["DELETE FROM orders", "SELECT 1; DROP TABLE orders", "SELECT pg_advisory_lock(1)"]) {
    expect(() => checkEngineRead("postgresql_execute_database_query", { query })).toThrow("read-only")
  }
  expect(() => checkEngineRead("snowflake_execute_database_query", {})).toThrow("required")
  expect(() =>
    checkEngineRead("snowflake_execute_database_query", { query: "SELECT 1", sql: "DELETE FROM orders" }),
  ).toThrow("read-only")
})

test("real stdio engine connection is pinned, excludes mutations and refuses calls after re-link", async () => {
  const binary = fileURLToPath(new URL("./workspace-engine.ts", import.meta.url))
  const binding = { datamateId: 35, datamateName: "Growth", repoRemote: null, projectPath: "/project", linkedAt: 0 }
  let changed = false
  const mocks = [
    spyOn(WorkspaceClient, "identity").mockResolvedValue({ binding, token: "receipt" }),
    spyOn(WorkspaceClient, "assertIdentity").mockImplementation(async () => {
      if (changed) throw new Error("Workspace changed")
      return { binding, token: "receipt" }
    }),
    spyOn(Probes, "which").mockReturnValue(binary),
  ]
  // Use this checkout as cwd so the test's real engine process can start.
  const adapter = await createWorkspaceAdapter(process.cwd())
  try {
    expect(adapter.tools.map((tool) => tool.name)).toEqual([
      "workspace_context",
      "workspace_skill",
      "workspace_snowflake_execute_database_query",
      "workspace_ask_knowledge_base",
    ])
    const signal = new AbortController().signal
    const answer = await adapter.execute("workspace_snowflake_execute_database_query", { query: "SELECT 1" }, signal)
    expect(JSON.stringify(answer)).toContain('\\"workspace\\":\\"35\\"')
    expect(JSON.stringify(answer)).toContain("SELECT 1")
    await expect(
      adapter.execute("workspace_snowflake_execute_database_query", { query: "DELETE FROM orders" }, signal),
    ).rejects.toThrow("read-only")
    await expect(
      adapter.execute("workspace_snowflake_execute_database_query", { sql: "SELECT 1" }, signal),
    ).rejects.toThrow("query is required")
    await expect(adapter.execute("workspace_datamate_add_memories", {}, signal)).rejects.toThrow("Unknown")
    changed = true
    await expect(adapter.execute("workspace_ask_knowledge_base", { question: "ARR?" }, signal)).rejects.toThrow(
      "changed",
    )
  } finally {
    await adapter.close()
    for (const mock of mocks) mock.mockRestore()
  }
})

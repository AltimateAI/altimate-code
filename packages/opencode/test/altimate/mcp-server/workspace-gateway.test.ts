import { afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createWorkspaceAdapter } from "../../../src/altimate/mcp-server/workspace"
import * as Client from "../../../src/altimate/workspace/client"
import * as Probes from "../../../src/altimate/workspace/engine-probes"
const restore: (() => void)[] = []
afterEach(() => {
  for (const f of restore.splice(0).reverse()) f()
})
function scope() {
  let token = "receipt"
  let linked = false
  let loads = 0
  const binding = { datamateId: 35, datamateName: "Growth", repoRemote: null, projectPath: "/project", linkedAt: 0 }
  const identity = spyOn(Client, "identity").mockImplementation(async () => {
    if (!linked) throw new Client.WorkspaceSetupError("needs_workspace", "Choose workspace")
    return { binding, token }
  })
  const assert = spyOn(Client, "assertIdentity").mockImplementation(async (_, expected) => {
    if (!linked || expected !== token) throw new Error("Workspace changed")
    return { binding, token }
  })
  const context = spyOn(Client, "context").mockImplementation(async () => {
    loads++
    return {
      workspace: { id: 35, name: "Growth", token },
      summary: "Use booked ARR",
      skills: [],
      memory: { status: "loaded" as const, memories: [], clipped: false },
    }
  })
  const setup = spyOn(Client, "setup").mockResolvedValue({
    status: "needs_workspace",
    workspaces: [{ id: 35, name: "Growth" }],
    message: "Choose workspace",
  })
  const which = spyOn(Probes, "which").mockReturnValue(fileURLToPath(new URL("./workspace-engine.ts", import.meta.url)))
  restore.push(() => {
    identity.mockRestore()
    assert.mockRestore()
    context.mockRestore()
    setup.mockRestore()
    which.mockRestore()
  })
  return {
    link: () => {
      linked = true
    },
    switch: () => {
      token = "new-receipt"
    },
    which,
    loads: () => loads,
  }
}
const signal = new AbortController().signal
function parse(value: { content: unknown[] }) {
  const first = value.content[0]
  if (!first || typeof first !== "object" || !("text" in first) || typeof first.text !== "string")
    throw new Error("Expected text tool result")
  return JSON.parse(first.text)
}

test("same MCP facade goes from unlinked to live engine reads without tool rediscovery or restart", async () => {
  const f = scope()
  const server = await createWorkspaceAdapter(process.cwd())
  try {
    const names = server.tools.map((t) => t.name)
    expect(names).toEqual(["workspace_context", "workspace_skill", "workspace_execute"])
    expect(f.which).not.toHaveBeenCalled()
    expect(parse(await server.execute("workspace_context", {}, signal)).status).toBe("needs_workspace")
    f.link()
    expect(parse(await server.execute("workspace_context", {}, signal)).workspace.token).toBe("receipt")
    expect(f.which).not.toHaveBeenCalled()
    const ready = parse(await server.execute("workspace_context", { include_tools: true }, signal))
    expect(ready.operations.map((t: { name: string }) => t.name)).toContain("snowflake_execute_database_query")
    expect(ready.operations.map((t: { name: string }) => t.name)).not.toContain("datamate_add_memories")
    expect(server.tools.map((t) => t.name)).toEqual(names)
    const answer = await server.execute(
      "workspace_execute",
      {
        workspace_token: "receipt",
        operation: "snowflake_execute_database_query",
        arguments: { connection_id: "fixture", sql_query: "SELECT 1" },
      },
      signal,
    )
    expect(JSON.stringify(answer)).toContain("SELECT 1")
    await expect(
      server.execute(
        "workspace_execute",
        {
          workspace_token: "receipt",
          operation: "snowflake_execute_database_query",
          arguments: { connection_id: 42, sql_query: "SELECT 1" },
        },
        signal,
      ),
    ).rejects.toThrow("schema")
    await expect(
      server.execute(
        "workspace_execute",
        {
          workspace_token: "receipt",
          operation: "snowflake_execute_database_query",
          arguments: { sql_query: "SELECT 1" },
        },
        signal,
      ),
    ).rejects.toThrow("schema")
    expect(f.loads()).toBe(1)
    await expect(
      server.execute(
        "workspace_execute",
        {
          workspace_token: "receipt",
          operation: "snowflake_execute_database_query",
          arguments: { connection_id: "fixture", sql_query: "DELETE FROM orders" },
        },
        signal,
      ),
    ).rejects.toThrow("read-only")
    await expect(
      server.execute(
        "workspace_execute",
        { workspace_token: "receipt", operation: "datamate_add_memories", arguments: {} },
        signal,
      ),
    ).rejects.toThrow("not exposed")
    f.switch()
    await expect(
      server.execute(
        "workspace_execute",
        { workspace_token: "receipt", operation: "snowflake_list_database_connections", arguments: {} },
        signal,
      ),
    ).rejects.toThrow("changed")
    const changed = parse(await server.execute("workspace_context", {}, signal))
    expect(changed.workspace.token).toBe("new-receipt")
    expect(f.loads()).toBe(2)
    const resumed = await server.execute(
      "workspace_execute",
      { workspace_token: "new-receipt", operation: "snowflake_list_database_connections", arguments: {} },
      signal,
    )
    expect(JSON.stringify(resumed)).toContain("snowflake_list_database_connections")
  } finally {
    await server.close()
  }
})

test("context refresh retries engine discovery after first-use engine installation", async () => {
  const f = scope()
  f.link()
  f.which.mockReturnValue(null)
  const server = await createWorkspaceAdapter(process.cwd())
  try {
    const missing = parse(await server.execute("workspace_context", { include_tools: true }, signal))
    expect(missing.engineStatus).toBe("needs_engine")
    f.which.mockReturnValue(fileURLToPath(new URL("./workspace-engine.ts", import.meta.url)))
    const ready = parse(await server.execute("workspace_context", { include_tools: true, refresh: true }, signal))
    expect(ready.engineStatus).toBe("ready")
    expect(ready.operations.length).toBeGreaterThan(0)
    expect(f.loads()).toBe(2)
  } finally {
    await server.close()
  }
})

test("simultaneous relevant context reads coalesce but every request checks identity", async () => {
  const f = scope()
  f.link()
  const server = await createWorkspaceAdapter(process.cwd())
  try {
    const replies = await Promise.all(Array.from({ length: 5 }, () => server.execute("workspace_context", {}, signal)))
    expect(replies.every((r) => parse(r).workspace.token === "receipt")).toBe(true)
    expect(f.loads()).toBe(1)
    f.switch()
    expect(parse(await server.execute("workspace_context", {}, signal)).workspace.token).toBe("new-receipt")
    await expect(
      server.execute("workspace_skill", { name: "revenue", workspace_token: "receipt" }, signal),
    ).rejects.toThrow("changed")
  } finally {
    await server.close()
  }
  await expect(server.execute("workspace_context", {}, signal)).rejects.toThrow("closed")
})

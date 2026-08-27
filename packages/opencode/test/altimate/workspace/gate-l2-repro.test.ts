// Gate L2 repro — NOT for commit. Type-less `{ enabled: false }` disable marker.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, planForEntry } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

const binding = { datamateId: 42, datamateName: "analytics", repoRemote: "x", projectPath: "/tmp/x" } as CachedBinding

beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k] })

test("planForEntry: a disable marker with no runtime status is honoured", () => {
  // MCP.status() omits a config entry that has no `type` (mcp/index.ts:875-878),
  // and the schema allows `{ enabled: false }` alone (core config.ts:119).
  expect(planForEntry({ entry: { enabled: false }, observed: undefined }, "42", false)).toEqual({ act: "honour-disable" })
})

test("ensure: a project `datamate: { enabled: false }` marker is not spawned over", async () => {
  const added: unknown[] = [], persisted: unknown[] = [], toasts: unknown[] = []
  syncInternals.resolveBinding = async () => binding
  syncInternals.which = () => "/usr/local/bin/datamate"
  syncInternals.versionOf = async () => "0.7.0"
  syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
  syncInternals.existingEntry = async () => ({ enabled: false })
  syncInternals.projectEntry = async () => ({ enabled: false })
  syncInternals.persist = async (n, c) => { persisted.push({ n, c }) }
  syncInternals.notify = async (t) => { toasts.push(t) }
  syncInternals.toolsChanged = async () => {}
  syncInternals.persistRestore = async () => {}
  let live = false
  syncInternals.mcp = {
    // The entry has no `type`, so status() never lists it — until WE add it.
    status: async () => (live ? { datamate: { status: "connected" } } : {}),
    add: async (n, c) => { added.push({ n, c }); live = true },
    connect: async () => {},
    remove: async () => {},
    tools: async () => ({ datamate_dbt_build_model: {} }),
  }
  // The project file has no entry of its own unless a test says otherwise.
  // Required since the project reader stopped swallowing its own errors.
  if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
  if (!syncInternals.projectConfigPath)
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  const outcome = await ensure("s1")
  console.log("outcome:", JSON.stringify(outcome), "persisted:", JSON.stringify(persisted), "toasts:", JSON.stringify(toasts.map((t: any) => t.title)))
  expect(outcome.kind).toBe("entry-disabled")
  expect(added).toHaveLength(0)
  expect(persisted).toHaveLength(0)
})

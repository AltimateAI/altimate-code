// altimate_change - new file
//
// `datamate_manager` in a project linked to a workspace. The workspace's own
// engine is the only route to its integrations there, so the tool is kept out
// of the model's catalog (see test/altimate/workspace/datamate-manager-gate.test.ts)
// and, for callers that run it directly, refuses every operation before it
// looks anything up or writes any config. An unlinked project is unchanged.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { initTool } from "../tool-fixture"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { AltimateApi } from "../../../src/altimate/api/client"
import { DatamateManagerTool } from "../../../src/altimate/tools/datamate"
import { DATAMATE_KEY } from "../../../src/altimate/datamate-transport"
import {
  MIN_ENGINE_VERSION,
  overlay,
  resetForTests,
  syncInternals,
  type LocalMcpConfig,
} from "../../../src/altimate/workspace/engine-overlay"
import { SessionID, MessageID } from "../../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

type Api = Record<string, unknown>
const api = AltimateApi as unknown as Api
const originals: Api = {}
const originalFlag = process.env.ALTIMATE_DISABLE_WORKSPACE
/** API calls the tool made during a test. */
let calls: string[] = []

/** Every API the operations reach for, recorded rather than performed. */
const API_METHODS = [
  "listDatamates",
  "getDatamate",
  "listIntegrations",
  "resolveIntegrations",
  "createDatamate",
  "updateDatamate",
  "deleteDatamate",
  "buildMcpConfig",
  "getCredentials",
] as const

beforeEach(() => {
  resetForTests()
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
  calls = []
  originals.isConfigured = api.isConfigured
  api.isConfigured = async () => true
  for (const name of API_METHODS) {
    originals[name] = api[name]
    api[name] = async () => {
      calls.push(name)
      return name === "listDatamates" ? [] : undefined
    }
  }
})

afterEach(() => {
  resetForTests()
  // `resetForTests` forgets state, not seams: clear every override so nothing
  // set here reaches another test reading the module-global seam.
  for (const key of Object.keys(syncInternals)) delete (syncInternals as Record<string, unknown>)[key]
  for (const [name, fn] of Object.entries(originals)) api[name] = fn
  if (originalFlag === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = originalFlag
})

/** A directory bound to workspace 42 "analytics", with the engine installed or
 * not, and no IDE config anywhere under it. */
function bindWorkspace(directory: string, engine: "installed" | "missing" = "installed"): void {
  const config: { mcp?: Record<string, unknown> } = { mcp: {} }
  syncInternals.instanceDirectory = () => directory
  syncInternals.serve = () => false
  syncInternals.resolveBinding = async () => ({
    datamateId: 42,
    datamateName: "analytics",
    repoRemote: null,
    projectPath: directory,
    linkedAt: 1,
  })
  syncInternals.which = () => (engine === "installed" ? "/usr/local/bin/datamate" : null)
  syncInternals.versionOf = async () => MIN_ENGINE_VERSION
  syncInternals.config = {
    invalidate: async () => {},
    get: async () => {
      await overlay(directory, config)
      return config
    },
  }
}

/** Arguments that would take each operation past its own validation. */
const OPERATIONS: Array<Record<string, unknown>> = [
  { operation: "list" },
  { operation: "list-integrations" },
  { operation: "add", datamate_id: "5" },
  { operation: "add", datamate_id: "5", name: DATAMATE_KEY },
  { operation: "create", name: "ops" },
  { operation: "edit", datamate_id: "5", name: "ops" },
  { operation: "delete", datamate_id: "5" },
  { operation: "status" },
  { operation: "remove", server_name: "datamate-ops" },
  { operation: "remove", server_name: DATAMATE_KEY },
  { operation: "list-config" },
]

/** Every config file the tool could have written in the project. */
async function projectConfigFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const sub of ["", ".altimate-code", ".opencode"]) {
    const entries = await fs.readdir(path.join(dir, sub)).catch(() => [] as string[])
    for (const name of entries) if (/\.jsonc?$/.test(name)) found.push(path.join(sub, name))
  }
  return found
}

describe("datamate_manager in a project linked to a workspace", () => {
  for (const engine of ["installed", "missing"] as const) {
    for (const args of OPERATIONS) {
      const label = `${args.operation}${args.name ? ` name=${args.name}` : ""}${args.server_name ? ` server=${args.server_name}` : ""}`
      test(`engine ${engine}: '${label}' is refused before any lookup, and nothing is written`, async () => {
        await using tmp = await tmpdir()
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            bindWorkspace(tmp.path, engine)
            const tool = await initTool(DatamateManagerTool)
            const result = await tool.execute(args, ctx as any)
            expect(result.title).toBe(`Datamate ${args.operation}: off in a project linked to a workspace`)
            expect(result.metadata).toMatchObject({ operation: args.operation, managedBy: "42" })
            expect(result.output).toContain('linked to Altimate workspace "analytics" (id 42)')
            expect(result.output).toContain("nothing was changed")
            expect(calls).toEqual([])
            expect(await projectConfigFiles(tmp.path)).toEqual([])
          },
        })
      })
    }
  }

  test("the workspace engine's own entry is untouched by an add under its key", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        bindWorkspace(tmp.path)
        const tool = await initTool(DatamateManagerTool)
        await tool.execute({ operation: "add", datamate_id: "5", name: DATAMATE_KEY }, ctx as any)
        const entry = (await syncInternals.config!.get()).mcp?.[DATAMATE_KEY] as LocalMcpConfig
        expect(entry.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
      },
    })
  })
})

describe("datamate_manager outside a linked project", () => {
  const cases: Array<[string, () => void]> = [
    ["an unlinked project", () => (syncInternals.resolveBinding = async () => null)],
    ["workspaces disabled", () => (process.env.ALTIMATE_DISABLE_WORKSPACE = "1")],
    ["altimate serve", () => (syncInternals.serve = () => true)],
  ]
  for (const [label, arrange] of cases) {
    test(`${label}: operations run as before`, async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          bindWorkspace(tmp.path)
          arrange()
          const tool = await initTool(DatamateManagerTool)
          const result = await tool.execute({ operation: "list" }, ctx as any)
          expect(result.title).toBe("Datamates: none found")
          expect(calls).toEqual(["listDatamates"])
        },
      })
    })
  }
})

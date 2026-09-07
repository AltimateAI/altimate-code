// altimate_change - new file
//
// `datamate_manager add` in workspace mode. The shared `datamate` MCP key is the
// bound workspace's own engine; the tool reaches that key on two routes — an IDE
// transport, or an explicit `name` of "datamate" — and must refuse both before it
// looks anything up. E2E row 9 covers the IDE-transport route; this covers the
// explicit-name route, which has no IDE config at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

const originalIsConfigured = AltimateApi.isConfigured
const originalFlag = process.env.ALTIMATE_WORKSPACE

beforeEach(() => {
  resetForTests()
  process.env.ALTIMATE_WORKSPACE = "1"
  // The refusal must not depend on the API being reachable: only the
  // credentials-present gate at the top of the tool is satisfied here.
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
})

afterEach(() => {
  resetForTests()
  // `resetForTests` forgets state, not seams: clear every override so nothing
  // set here reaches another test reading the module-global seam.
  for (const key of Object.keys(syncInternals)) delete (syncInternals as Record<string, unknown>)[key]
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  if (originalFlag === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = originalFlag
})

/** A bound directory whose overlay has attached an engine, with no IDE config
 * anywhere under it. */
function bindWorkspace(directory: string): void {
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
  syncInternals.which = () => "/usr/local/bin/datamate"
  syncInternals.versionOf = async () => MIN_ENGINE_VERSION
  syncInternals.config = {
    invalidate: async () => {},
    get: async () => {
      await overlay(directory, config)
      return config
    },
  }
}

describe("datamate_manager add in workspace mode", () => {
  test("an explicit name of 'datamate' is refused without an IDE transport, before any lookup", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        bindWorkspace(tmp.path)
        const tool = await initTool(DatamateManagerTool)
        const result = await tool.execute({ operation: "add", datamate_id: "5", name: DATAMATE_KEY }, ctx as any)
        expect(result.title).toBe(`Datamate add: '${DATAMATE_KEY}' is managed by workspace "analytics"`)
        expect(result.metadata).toMatchObject({ serverName: DATAMATE_KEY, managedBy: "42", datamateId: "5" })
        expect(result.output).toContain('linked to workspace "analytics"')
        // Nothing was written or started under the key: the overlay's own entry is all there is.
        const entry = (await syncInternals.config!.get()).mcp?.[DATAMATE_KEY] as LocalMcpConfig
        expect(entry.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
      },
    })
  })
})

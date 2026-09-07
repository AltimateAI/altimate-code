// altimate_change - new file
//
// `datamate_manager list-integrations` and extension-type rows. Extension
// integrations are RPC into a live VS Code host: with a bridge running for
// this project they serve from the CLI like any other integration; without
// one they are dormant, not impossible. The listing must say which of those
// is true rather than a blanket "not available from the CLI".
import { afterEach, describe, expect, test } from "bun:test"
import { initTool } from "../tool-fixture"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { AltimateApi } from "../../../src/altimate/api/client"
import { DatamateManagerTool } from "../../../src/altimate/tools/datamate"
import { syncInternals } from "../../../src/altimate/workspace/engine-seams"
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

const CATALOG = [
  { id: "snowflake", name: "Snowflake", type: "connection", tools: [{ key: "execute_query" }] },
  {
    id: "power-user-for-dbt",
    name: "Power User for dbt",
    type: "extension",
    tools: [{ key: "compile_model" }, { key: "run_model" }],
  },
]

const originalList = AltimateApi.listIntegrations
const originalIsConfigured = AltimateApi.isConfigured

afterEach(() => {
  ;(AltimateApi as unknown as { listIntegrations: typeof originalList }).listIntegrations = originalList
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  for (const key of Object.keys(syncInternals)) delete (syncInternals as Record<string, unknown>)[key]
})

function serveCatalog(catalog: unknown[] = CATALOG): void {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { listIntegrations: () => Promise<unknown> }).listIntegrations = async () => catalog
}

async function list() {
  await using tmp = await tmpdir()
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await initTool(DatamateManagerTool)
      return tool.execute({ operation: "list-integrations" }, ctx as any)
    },
  })
}

describe("datamate_manager list-integrations and extension-type integrations", () => {
  test("without a bridge they are omitted with copy that says how they come back", async () => {
    serveCatalog()
    syncInternals.liveBridge = () => false
    const result = await list()
    expect(result.metadata).toMatchObject({ count: 1, hidden: 1, bridge: false })
    expect(result.output).toContain("snowflake | Snowflake")
    expect(result.output).not.toContain("power-user-for-dbt")
    expect(result.output).toContain(
      "1 extension-type integration was omitted — they serve while VS Code with the Altimate extension is open on this project.",
    )
    expect(result.output).not.toContain("not available from the CLI")
  })

  test("with a live bridge they are listed, marked, and counted", async () => {
    serveCatalog()
    syncInternals.liveBridge = () => true
    const result = await list()
    expect(result.metadata).toMatchObject({ count: 2, hidden: 0, bridge: true })
    expect(result.output).toContain("power-user-for-dbt | Power User for dbt (via VS Code) | compile_model, run_model")
    expect(result.output).toContain("1 extension-type integration is served via the connected VS Code window.")
    expect(result.title).toBe("Integrations: 2 available")
  })

  test("a catalog with no extension rows never probes for a bridge", async () => {
    serveCatalog([CATALOG[0]])
    syncInternals.liveBridge = () => {
      throw new Error("must not probe")
    }
    const result = await list()
    expect(result.metadata).toMatchObject({ count: 1, hidden: 0, bridge: false })
    expect(result.output).not.toContain("extension-type")
  })
})

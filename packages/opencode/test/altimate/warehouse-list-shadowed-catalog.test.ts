import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Precedence from "../../src/altimate/workspace/precedence"
import * as Discovery from "../../src/altimate/tools/warehouse-discovery"
import { WarehouseListTool } from "../../src/altimate/tools/warehouse-list"
import { SessionID, MessageID } from "../../src/session/schema"

afterEach(() => {
  mock.restore()
})

test("catalog discovery skips workspace-routed connections and still covers the rest", async () => {
  spyOn(Dispatcher, "call").mockResolvedValue({
    warehouses: [
      { name: "remote", type: "snowflake" },
      { name: "local", type: "duckdb" },
    ],
  } as never)
  spyOn(Precedence, "warehouseListNotes").mockResolvedValue(new Map([["remote", "workspace"]]))
  const discover = spyOn(Discovery, "discoverCatalog").mockResolvedValue("local: main.t")
  const tool = await initTool(WarehouseListTool)
  const result = await tool.execute(
    {},
    {
      sessionID: SessionID.make("ses_shadow"),
      messageID: MessageID.make("msg_shadow"),
      callID: "call",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async () => {},
      extra: { mcpClient: true },
    } as never,
  )
  expect(discover.mock.calls[0]![0].map((w: { name: string }) => w.name)).toEqual(["local"])
  expect(result.output).toContain("local: main.t")
})

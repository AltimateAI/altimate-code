import { afterEach, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { WarehouseAddTool } from "../../src/altimate/tools/warehouse-add"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_readonly_store"),
  messageID: MessageID.make("msg_readonly_store"),
  callID: "call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}
const original = process.cwd()
let dir: string | undefined

afterEach(() => {
  mock.restore()
  process.chdir(original)
  if (dir) {
    fs.chmodSync(path.join(dir, "data"), 0o755)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  dir = undefined
})

test("a relative path to an unwritable store is persisted read-only", async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wh-add-ro-")))
  fs.mkdirSync(path.join(dir, "data"))
  const store = path.join(dir, "data", "app.duckdb")
  fs.writeFileSync(store, "")
  fs.chmodSync(store, 0o444)
  fs.chmodSync(path.join(dir, "data"), 0o555)
  process.chdir(dir)
  if (process.getuid?.() === 0) return

  const added: any[] = []
  spyOn(Dispatcher, "call").mockImplementation((async (method: string, params: any) => {
    if (method === "warehouse.add") {
      added.push(params)
      return { success: true, name: params.name, type: "duckdb" }
    }
    if (method === "schema.cache_status") return { total_tables: 0 }
    return { warehouses: [] }
  }) as any)

  const tool = await initTool(WarehouseAddTool)
  await tool.execute({ name: "ro", config: { type: "duckdb", path: "data/app.duckdb" } }, ctx as any)
  expect(added[0].config.readonly).toBe(true)
})

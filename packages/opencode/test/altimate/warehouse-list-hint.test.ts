import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as Registry from "../../src/altimate/native/connections/registry"
import { WarehouseListTool, noConnectionsMessage } from "../../src/altimate/tools/warehouse-list"
import { registerAll } from "../../src/altimate/native/connections/register"
import { SessionID, MessageID } from "../../src/session/schema"
import { initTool } from "./tool-fixture"

function toolCtx() {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as any
}

let project: string
let prevCwd: string

beforeEach(() => {
  prevCwd = process.cwd()
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "whl-hint-")))
  process.chdir(project)
  Registry.reset()
  registerAll()
})

afterEach(() => {
  process.chdir(prevCwd)
  Registry.reset()
  fs.rmSync(project, { recursive: true, force: true })
})

describe("warehouse_list no-connections hint", () => {
  test("names the paths and env prefix the registry reads, not .opencode", () => {
    const msg = noConnectionsMessage()
    expect(msg).toContain(Registry.globalConfigPath())
    expect(msg).toContain(Registry.localConfigPath())
    expect(msg).toContain(Registry.CONN_ENV_PREFIX)
    expect(msg).toContain("warehouse_add")
    expect(msg).toContain('"type": "postgres"')
    expect(msg).not.toContain(".opencode/connections.json")
    expect(Registry.localConfigPath()).toBe(path.join(project, ".altimate-code", "connections.json"))
  })

  test("a connections.json written to the project path named by the hint is loaded", () => {
    const named = Registry.localConfigPath()
    expect(noConnectionsMessage()).toContain(named)
    fs.mkdirSync(path.dirname(named), { recursive: true })
    fs.writeFileSync(named, JSON.stringify({ "hint-db": { type: "postgres", host: "localhost", database: "d" } }))
    Registry.load()
    expect(Registry.names()).toContain("hint-db")
  })

  test("a connections.json at the legacy .opencode location is not loaded", () => {
    fs.mkdirSync(path.join(project, ".opencode"))
    fs.writeFileSync(
      path.join(project, ".opencode", "connections.json"),
      JSON.stringify({ "wrong-db": { type: "postgres", host: "localhost" } }),
    )
    Registry.load()
    expect(Registry.names()).not.toContain("wrong-db")
  })

  test("the tool lists a connection created after an empty answer, in the same process", async () => {
    const tool = await initTool(WarehouseListTool)
    const ctx = toolCtx()
    const first = await tool.execute({}, ctx)
    expect(first.output).toContain(Registry.localConfigPath())

    const named = Registry.localConfigPath()
    fs.mkdirSync(path.dirname(named), { recursive: true })
    fs.writeFileSync(named, JSON.stringify({ "late-db": { type: "postgres", host: "localhost", database: "d" } }))

    const second = await tool.execute({}, ctx)
    expect(second.output).toContain("late-db")
    // the lookup sql tools use resolves it too
    expect(Registry.getConfig("late-db")?.type).toBe("postgres")
  })

  test("an env var set after an empty answer is picked up", async () => {
    const tool = await initTool(WarehouseListTool)
    const ctx = toolCtx()
    await tool.execute({}, ctx)
    process.env.ALTIMATE_CODE_CONN_ENVLATE = JSON.stringify({ type: "postgres", host: "h" })
    try {
      expect((await tool.execute({}, ctx)).output).toContain("envlate")
    } finally {
      delete process.env.ALTIMATE_CODE_CONN_ENVLATE
    }
  })

  test("with a connection loaded, editing the file does not replace the configs", () => {
    const named = Registry.localConfigPath()
    fs.mkdirSync(path.dirname(named), { recursive: true })
    fs.writeFileSync(named, JSON.stringify({ "db-a": { type: "postgres", host: "old" } }))
    expect(Registry.getConfig("db-a")?.host).toBe("old")
    fs.writeFileSync(named, JSON.stringify({ "db-a": { type: "postgres", host: "new" }, "db-b": { type: "postgres" } }))
    expect(Registry.getConfig("db-a")?.host).toBe("old")
    expect(Registry.names()).toEqual(["db-a"])
  })

  test("a populated registry is not clobbered when the working project changes", () => {
    const named = Registry.localConfigPath()
    fs.mkdirSync(path.dirname(named), { recursive: true })
    fs.writeFileSync(named, JSON.stringify({ "proj-a": { type: "postgres" } }))
    expect(Registry.names()).toEqual(["proj-a"])

    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "whl-hint-b-")))
    try {
      fs.mkdirSync(path.join(other, ".altimate-code"))
      fs.writeFileSync(
        path.join(other, ".altimate-code", "connections.json"),
        JSON.stringify({ "proj-b": { type: "postgres" } }),
      )
      process.chdir(other)
      expect(Registry.names()).toEqual(["proj-a"])
    } finally {
      process.chdir(project)
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test("setConfigs-injected connections are kept", () => {
    Registry.setConfigs({ injected: { type: "postgres" } })
    expect(Registry.names()).toEqual(["injected"])
  })
})

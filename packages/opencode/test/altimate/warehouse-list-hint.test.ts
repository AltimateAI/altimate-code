import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as Registry from "../../src/altimate/native/connections/registry"
import { noConnectionsMessage } from "../../src/altimate/tools/warehouse-list"

let project: string
let prevCwd: string

beforeEach(() => {
  prevCwd = process.cwd()
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "whl-hint-")))
  process.chdir(project)
  Registry.reset()
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
})

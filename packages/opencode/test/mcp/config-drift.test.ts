// altimate_change start — upstream_fix (#878): discovery skipped already-configured servers
// without a word, so a changed .vscode/mcp.json never surfaced. These pin what counts as drift.
import { describe, expect, test, beforeEach } from "bun:test"
import { driftFields, setConfigDrift, configDrift, resetConfigDrift } from "../../src/mcp/discover"

describe("driftFields", () => {
  test("identical definitions report no drift", () => {
    const server = { type: "local", command: ["node", "server.js"], environment: { PORT: "1" } }
    expect(driftFields({ ...server }, { ...server })).toEqual([])
  })

  test("names the environment key that changed, not just `environment`", () => {
    const discovered = { type: "local", environment: { ALTIMATE_EXTENSION_RPC: "127.0.0.1:9001", KEEP: "same" } }
    const configured = { type: "local", environment: { ALTIMATE_EXTENSION_RPC: "127.0.0.1:9000", KEEP: "same" } }
    expect(driftFields(discovered, configured)).toEqual(["environment.ALTIMATE_EXTENSION_RPC"])
  })

  test("reports a key present on only one side", () => {
    expect(driftFields({ environment: { A: "1", B: "2" } }, { environment: { A: "1" } })).toEqual(["environment.B"])
  })

  test("compares command arrays by value, not identity", () => {
    expect(driftFields({ command: ["node", "a.js"] }, { command: ["node", "a.js"] })).toEqual([])
    expect(driftFields({ command: ["node", "a.js"] }, { command: ["node", "b.js"] })).toEqual(["command"])
  })

  test("ignores `enabled`, which discovery sets for its own reasons", () => {
    expect(driftFields({ type: "local", enabled: false }, { type: "local", enabled: true })).toEqual([])
  })

  test("reports a changed url", () => {
    expect(driftFields({ url: "https://a" }, { url: "https://b" })).toEqual(["url"])
  })
})

describe("configDrift record", () => {
  beforeEach(() => resetConfigDrift())

  test("records only servers that actually differ", () => {
    setConfigDrift("datamate", ".vscode/mcp.json", ["environment.ALTIMATE_EXTENSION_RPC"])
    setConfigDrift("clean", ".vscode/mcp.json", [])
    expect(configDrift()).toEqual([
      { server: "datamate", source: ".vscode/mcp.json", fields: ["environment.ALTIMATE_EXTENSION_RPC"] },
    ])
  })

  test("a server that stops drifting is dropped from the report", () => {
    setConfigDrift("datamate", ".vscode/mcp.json", ["url"])
    setConfigDrift("datamate", ".vscode/mcp.json", [])
    expect(configDrift()).toEqual([])
  })
})
// altimate_change end

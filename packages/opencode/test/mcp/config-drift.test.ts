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
  // The record is per project now, so every call names the directory it belongs to.
  const PROJECT = "/tmp/project-a"
  beforeEach(() => resetConfigDrift())

  test("records only servers that actually differ", () => {
    setConfigDrift("datamate", ".vscode/mcp.json", ["environment.ALTIMATE_EXTENSION_RPC"], PROJECT)
    setConfigDrift("clean", ".vscode/mcp.json", [], PROJECT)
    expect(configDrift(PROJECT)).toEqual([
      { server: "datamate", source: ".vscode/mcp.json", fields: ["environment.ALTIMATE_EXTENSION_RPC"] },
    ])
  })

  test("a server that stops drifting is dropped from the report", () => {
    setConfigDrift("datamate", ".vscode/mcp.json", ["url"], PROJECT)
    setConfigDrift("datamate", ".vscode/mcp.json", [], PROJECT)
    expect(configDrift(PROJECT)).toEqual([])
  })

  test("one project's drift is invisible to another", () => {
    // `datamate` is written into every project by the extension sync, so a name-only record
    // meant two open workspaces reported each other's drift.
    const OTHER = "/tmp/project-b"
    setConfigDrift("datamate", ".vscode/mcp.json", ["url"], PROJECT)
    setConfigDrift("datamate", ".cursor/mcp.json", ["command"], OTHER)

    expect(configDrift(PROJECT)).toEqual([{ server: "datamate", source: ".vscode/mcp.json", fields: ["url"] }])
    expect(configDrift(OTHER)).toEqual([{ server: "datamate", source: ".cursor/mcp.json", fields: ["command"] }])
  })

  test("clearing one project leaves the other intact", () => {
    const OTHER = "/tmp/project-b"
    setConfigDrift("datamate", ".vscode/mcp.json", ["url"], PROJECT)
    setConfigDrift("datamate", ".cursor/mcp.json", ["command"], OTHER)

    resetConfigDrift(PROJECT)
    expect(configDrift(PROJECT)).toEqual([])
    expect(configDrift(OTHER)).toHaveLength(1)
  })
})
// altimate_change end

// altimate_change start — upstream_fix (#878): findings from PR review.
describe("driftFields — false positives and lost detail", () => {
  test("ignores updatedAt, the datamate sync bookkeeping field", () => {
    // normalizeMcpConfig preserves updatedAt on the configured entry and discovery never
    // produces one, so this compared a string against undefined and reported drift on every
    // `mcp list` for any datamate-synced server.
    expect(driftFields({ command: ["a"] }, { command: ["a"], updatedAt: "2026-08-28T00:00:00Z" })).toEqual([])
  })

  test("does not report key order as a difference", () => {
    const discovered = { oauth: { clientId: "x", scope: "y" } }
    const configured = { oauth: { scope: "y", clientId: "x" } }
    expect(driftFields(discovered, configured)).toEqual([])
  })

  test("names the inner key when only one side has the block", () => {
    // Previously required both sides to be objects, so a server that gained an environment
    // wholesale reported the bare word "environment" and lost the key that actually differs.
    expect(driftFields({ environment: { PORT: "1" } }, {})).toEqual(["environment.PORT"])
    expect(driftFields({}, { environment: { PORT: "1" } })).toEqual(["environment.PORT"])
  })

  test("still reports an empty block against a missing one", () => {
    // No inner key exists to name, so the top-level field is the only honest answer.
    expect(driftFields({ environment: {} }, {})).toEqual(["environment"])
  })

  test("still reports a genuine difference", () => {
    // The guard against false positives must not silence real drift.
    expect(driftFields({ environment: { PORT: "1" } }, { environment: { PORT: "2" } })).toEqual(["environment.PORT"])
    expect(driftFields({ command: ["a"] }, { command: ["b"] })).toEqual(["command"])
  })
})
// altimate_change end

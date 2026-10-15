import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `Global.Path.home` reads this on every access: settings.json and
// connections.json land in a sandbox, never the real home.
const SANDBOX = mkdtempSync(path.join(tmpdir(), "connection-choice-"))
const ORIGINAL_HOME = process.env.OPENCODE_TEST_HOME
process.env.OPENCODE_TEST_HOME = SANDBOX
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = ORIGINAL_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const {
  choiceFingerprint,
  choiceFor,
  chooseConnection,
  localConnectionsPath,
  readChoices,
  readLocalConnections,
  settingsPath,
  takesChoice,
  usable,
} = await import("../../../src/altimate/workspace/connection-choice")
type RawConnection = import("../../../src/altimate/workspace/connection-choice").RawConnection

const jira = {
  id: "jira",
  type: "tool",
  config: [
    { key: "url", required: true },
    { key: "token", required: true },
    { key: "project", required: false },
  ],
}
const conn = (id: string, over: Partial<RawConnection> = {}): RawConnection => ({
  id,
  name: `Jira ${id}`,
  integrationId: "jira",
  config: { url: "https://x.atlassian.net", token: "t" },
  remote: true,
  ...over,
})

describe("takesChoice: the engine's requiresConnectionSelection", () => {
  const fields = [{ key: "token", required: true }]
  test.each([
    ["in-house tool with a choice", { id: "jira", type: "tool", config: fields }, true],
    ["in-house tool the engine does not know (base default)", { id: "newtool", type: "tool", config: fields }, true],
    ["snowflake takes a connection per call", { id: "snowflake", type: "tool", config: fields }, false],
    ["postgresql per call", { id: "postgresql", type: "tool", config: fields }, false],
    ["bigquery per call", { id: "bigquery", type: "tool", config: fields }, false],
    ["dbt per call", { id: "dbt", type: "tool", config: fields }, false],
    ["altimate per call", { id: "altimate", type: "tool", config: fields }, false],
    ["knowledge per call", { id: "altimate_knowledge", type: "tool", config: fields }, false],
    ["custom api", { id: "7", type: "api", config: fields }, true],
    ["custom or catalog mcp", { id: "github", type: "mcp", config: fields }, true],
    ["custom code", { id: "8", type: "code", config: fields }, false],
    ["extension", { id: "power-user-for-dbt", type: "extension", config: fields }, false],
    ["no connection fields at all", { id: "jira", type: "tool", config: [] }, false],
    ["connection fields unreadable", { id: "jira", type: "tool", config: "nope" }, false],
    ["no type", { id: "jira", config: fields }, false],
  ])("%s", (_, integration, expected) => {
    expect(takesChoice(integration)).toBe(expected)
  })
})

describe("usable: owned, every required field of its variant set", () => {
  const variants = {
    ...jira,
    additionalConfigVariants: [
      { id: "oauth", config: [{ key: "client_id", required: true }] },
      { id: "bare" },
    ],
  }
  test.each([
    ["all required fields", jira, conn("1"), true],
    ["a required field empty", jira, conn("1", { config: { url: "u", token: "" } }), false],
    ["a required field absent", jira, conn("1", { config: { url: "u" } }), false],
    ["only optional fields missing", jira, conn("1", { config: { url: "u", token: "t" } }), true],
    ["another integration's connection", jira, conn("1", { integrationId: "linear" }), false],
    ["type 'default' is the default variant", jira, conn("1", { config: { type: "default", url: "u", token: "t" } }), true],
    ["a declared variant, its own fields set", variants, conn("1", { config: { type: "oauth", client_id: "c" } }), true],
    ["a declared variant, its own field missing", variants, conn("1", { config: { type: "oauth", url: "u", token: "t" } }), false],
    ["a declared variant without fields", variants, conn("1", { config: { type: "bare" } }), false],
    ["an undeclared variant, others declared", variants, conn("1", { config: { type: "sso" } }), false],
    ["an undeclared variant, none declared", jira, conn("1", { config: { type: "sso" } }), true],
  ])("%s", (_, integration, connection, expected) => {
    expect(usable(integration, connection)).toBe(expected)
  })
})

describe("choiceFor: the connection in use", () => {
  const all = [conn("10"), conn("9"), conn("2", { config: { url: "u" } }), conn("a1b2", { remote: false })]

  test("no choice: the lowest usable id, numeric before local ids, in that order", () => {
    const choice = choiceFor(jira, all, undefined)
    expect(choice.options.map((o) => [o.id, o.usable])).toEqual([
      ["2", false],
      ["9", true],
      ["10", true],
      ["a1b2", true],
    ])
    expect(choice.inUse).toEqual({ kind: "default", connection: { id: "9", name: "Jira 9", remote: true, usable: true } })
  })

  test("a local connection is the default only when no remote one is usable", () => {
    const choice = choiceFor(jira, [conn("2", { config: {} }), conn("a1b2", { remote: false })], undefined)
    expect(choice.inUse.kind === "default" && choice.inUse.connection.id).toBe("a1b2")
  })

  test("an explicit choice wins over the default", () => {
    const choice = choiceFor(jira, all, "10")
    expect(choice.inUse.kind === "chosen" && choice.inUse.connection.id).toBe("10")
  })

  test.each([
    ["names a deleted connection", "77", { kind: "off", id: "77" }],
    ["names an incomplete connection", "2", { kind: "off", id: "2", name: "Jira 2" }],
    ["is not a string (the engine compares as is)", 9, { kind: "off", id: "9" }],
    ["is null", null, { kind: "off", id: "null" }],
  ])("a choice that %s turns the integration off, with no fallback", (_, chosen, inUse) => {
    expect(choiceFor(jira, all, chosen).inUse).toEqual(inUse as never)
  })

  test("no usable connection and no choice", () => {
    expect(choiceFor(jira, [conn("2", { config: {} })], undefined).inUse).toEqual({ kind: "none" })
    expect(choiceFor(jira, [], undefined)).toEqual({ integrationId: "jira", options: [], inUse: { kind: "none" } })
  })

  test("options carry no config", () => {
    for (const option of choiceFor(jira, all, undefined).options) expect(Object.keys(option).sort()).toEqual(["id", "name", "remote", "usable"])
  })
})

describe("settings.json", () => {
  beforeEach(() => rmSync(path.join(SANDBOX, ".altimate"), { recursive: true, force: true }))
  const write = (value: unknown) => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true })
    writeFileSync(settingsPath(), typeof value === "string" ? value : JSON.stringify(value))
  }
  const read = () => JSON.parse(readFileSync(settingsPath(), "utf8"))

  test("a missing or empty file has no choices", () => {
    expect(readChoices("6")).toEqual({})
    write("  ")
    expect(readChoices("6")).toEqual({})
  })

  test("choosing creates the file, the id as a string", () => {
    chooseConnection("6", "jira", "9")
    expect(read()).toEqual({ "6": { jira: "9" } })
    expect(readChoices("6")).toEqual({ jira: "9" })
  })

  test("choosing keeps every other key: other integrations, other workspaces, the extension's", () => {
    const teammates = [{ folders: ["/p"], teammateId: "6" }]
    write({ "6": { linear: "3", jira: "1" }, "7": { jira: "4" }, _activeTeammates: teammates })
    chooseConnection("6", "jira", "9")
    expect(read()).toEqual({ "6": { linear: "3", jira: "9" }, "7": { jira: "4" }, _activeTeammates: teammates })
  })

  test("written in place: the file the extension's engine watches stays the same file", () => {
    write({ "6": { jira: "1" } })
    const before = statSync(settingsPath()).ino
    chooseConnection("6", "jira", "9")
    expect(statSync(settingsPath()).ino).toBe(before)
  })

  test("a file that does not parse is not written over", () => {
    write("{ not json")
    expect(() => chooseConnection("6", "jira", "9")).toThrow()
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json")
    write("[1, 2]")
    expect(() => chooseConnection("6", "jira", "9")).toThrow(/JSON object/)
  })

  test("an entry for the workspace that is not an object is not written over", () => {
    write({ "6": "jira" })
    expect(() => chooseConnection("6", "jira", "9")).toThrow(/not an object/)
    expect(read()).toEqual({ "6": "jira" })
  })

  test("the fingerprint is the workspace's entry in a stable order; unreadable is null", () => {
    write({ "6": { linear: "3", jira: "1" }, "7": { jira: "4" } })
    const first = choiceFingerprint("6")
    write({ "7": { jira: "5" }, "6": { jira: "1", linear: "3" } })
    expect(choiceFingerprint("6")).toBe(first)
    chooseConnection("6", "jira", "9")
    expect(choiceFingerprint("6")).not.toBe(first)
    expect(choiceFingerprint("8")).toBe("[]")
    write("{ not json")
    expect(choiceFingerprint("6")).toBeNull()
  })
})

describe("readLocalConnections", () => {
  beforeEach(() => rmSync(path.join(SANDBOX, ".altimate"), { recursive: true, force: true }))
  const write = (text: string) => {
    mkdirSync(path.dirname(localConnectionsPath()), { recursive: true })
    writeFileSync(localConnectionsPath(), text)
  }

  test("reads this machine's connections as local; skips entries without an id or integration", () => {
    write(
      JSON.stringify([
        { id: "a1b2", name: "Mine", integration_id: "jira", config: { url: "u", token: "t" } },
        { name: "no id", integration_id: "jira", config: {} },
        { id: "c3", name: "no integration", config: {} },
        { id: "d4", integration_id: 5 },
      ]),
    )
    expect(readLocalConnections()).toEqual([
      { id: "a1b2", name: "Mine", integrationId: "jira", config: { url: "u", token: "t" }, remote: false },
      { id: "d4", name: "d4", integrationId: "5", config: {}, remote: false },
    ])
  })

  test("a missing or unreadable file is none", () => {
    expect(readLocalConnections()).toEqual([])
    write("{ nope")
    expect(readLocalConnections()).toEqual([])
    write("{}")
    expect(readLocalConnections()).toEqual([])
  })
})

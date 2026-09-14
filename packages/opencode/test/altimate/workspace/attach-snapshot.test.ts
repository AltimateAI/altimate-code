// The attach snapshot file: what the overlay writes for the TUI process to
// read. Sandboxed state directory, like manage.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SANDBOX = mkdtempSync(path.join(tmpdir(), "attach-snapshot-"))
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const { readAttachSnapshot, writeAttachSnapshot, snapshotPath } = await import(
  "../../../src/altimate/workspace/attach-snapshot"
)

const snap = (at: number, id = "6") => ({
  workspace: { id, name: "e2e-demo-live" },
  engineVersion: "0.7.2",
  declared: { keys: ["a", "b"], extensionKeys: [] },
  present: ["a"],
  unfulfilled: [{ key: "b", integrationId: "jira", reason: "invalid-connection" }],
  extServed: 0,
  at,
})

describe("attach snapshot file", () => {
  beforeEach(() => rmSync(snapshotPath(), { force: true }))

  test("round-trips per directory, latest attach wins, and a directory with none reads undefined", () => {
    writeAttachSnapshot("/proj/a", snap(1))
    writeAttachSnapshot("/proj/b", snap(2, "7"))
    writeAttachSnapshot("/proj/a", snap(3))
    expect(readAttachSnapshot("/proj/a")).toEqual(snap(3))
    expect(readAttachSnapshot("/proj/b")).toEqual(snap(2, "7"))
    expect(readAttachSnapshot("/proj/c")).toBeUndefined()
  })

  test("keeps the newest 64 directories", () => {
    for (let i = 0; i < 70; i++) writeAttachSnapshot(`/proj/${i}`, snap(i))
    expect(readAttachSnapshot("/proj/0")).toBeUndefined()
    expect(readAttachSnapshot("/proj/5")).toBeUndefined()
    expect(readAttachSnapshot("/proj/6")).toEqual(snap(6))
    expect(readAttachSnapshot("/proj/69")).toEqual(snap(69))
  })

  test("a corrupt file reads as empty and is replaced by the next write", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(path.dirname(snapshotPath()), { recursive: true })
    writeFileSync(snapshotPath(), "{not json")
    expect(readAttachSnapshot("/proj/a")).toBeUndefined()
    writeAttachSnapshot("/proj/a", snap(1))
    expect(readAttachSnapshot("/proj/a")).toEqual(snap(1))
  })
})

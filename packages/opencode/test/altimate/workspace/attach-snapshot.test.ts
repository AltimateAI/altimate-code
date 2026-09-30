// The attach snapshot files: what the overlay writes for the TUI process to
// read, the shared reader every surface goes through, and the one count every
// surface shows. Sandboxed state directory, like manage.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AttachSnapshot } from "../../../src/altimate/workspace/attach-snapshot"

const SANDBOX = mkdtempSync(path.join(tmpdir(), "attach-snapshot-"))
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const {
  currentAttachSnapshot,
  describeAge,
  readAttachSnapshot,
  snapshotCounts,
  snapshotDir,
  snapshotFile,
  workspaceIdentity,
  writeAttachSnapshot,
} = await import("../../../src/altimate/workspace/attach-snapshot")

const SCOPE = "acme|https://api.example.com"
const snap = (at: number, id = "6", scope = SCOPE): AttachSnapshot => ({
  workspace: { id, name: "e2e-demo-live", key: workspaceIdentity(scope, id) },
  engineVersion: "0.7.3",
  declared: { keys: ["a", "b"], extensionKeys: [] },
  present: ["a"],
  unfulfilled: [{ key: "b", integrationId: "jira", reason: "invalid-connection" }],
  at,
})

describe("attach snapshot files", () => {
  beforeEach(() => rmSync(snapshotDir(), { recursive: true, force: true }))

  test("round-trips the latest attach per directory, one file each", () => {
    writeAttachSnapshot("/proj/a", snap(1))
    writeAttachSnapshot("/proj/b", snap(2, "7"))
    writeAttachSnapshot("/proj/a", snap(3))
    expect(readAttachSnapshot("/proj/a")).toEqual(snap(3))
    expect(readAttachSnapshot("/proj/b")).toEqual(snap(2, "7"))
    expect(readAttachSnapshot("/proj/c")).toBeUndefined()
    // Two projects never share a file, so two processes cannot overwrite each other.
    expect(readdirSync(snapshotDir()).sort()).toEqual(
      [path.basename(snapshotFile("/proj/a")), path.basename(snapshotFile("/proj/b"))].sort(),
    )
  })

  test("keeps the 64 most recently written directories", () => {
    for (let i = 0; i < 70; i++) {
      writeAttachSnapshot(`/proj/${i}`, snap(i))
      // Distinct ages, so which files are oldest is not left to the clock's resolution.
      utimesSync(snapshotFile(`/proj/${i}`), 1_000 + i, 1_000 + i)
    }
    expect(readdirSync(snapshotDir())).toHaveLength(64)
    expect(readAttachSnapshot("/proj/0")).toBeUndefined()
    expect(readAttachSnapshot("/proj/5")).toBeUndefined()
    expect(readAttachSnapshot("/proj/6")).toEqual(snap(6))
    expect(readAttachSnapshot("/proj/69")).toEqual(snap(69))
  })

  test.each([
    ["not JSON", "{not json"],
    ["another format version", JSON.stringify({ version: 1, directory: "/proj/a", snapshot: snap(1) })],
    ["another directory's file", JSON.stringify({ version: 2, directory: "/proj/elsewhere", snapshot: snap(1) })],
    ["an entry without a workspace", JSON.stringify({ version: 2, directory: "/proj/a", snapshot: { ...snap(1), workspace: undefined } })],
    ["a workspace without a scoped key", JSON.stringify({ version: 2, directory: "/proj/a", snapshot: { ...snap(1), workspace: { id: "6", name: "x" } } })],
    ["present that is not a list", JSON.stringify({ version: 2, directory: "/proj/a", snapshot: { ...snap(1), present: "a" } })],
    ["a malformed report entry", JSON.stringify({ version: 2, directory: "/proj/a", snapshot: { ...snap(1), unfulfilled: [{ key: 1 }] } })],
  ])("a file with %s reads as absent, and the next attach replaces it", (_label, content) => {
    mkdirSync(snapshotDir(), { recursive: true })
    writeFileSync(snapshotFile("/proj/a"), content)
    expect(readAttachSnapshot("/proj/a")).toBeUndefined()
    writeAttachSnapshot("/proj/a", snap(1))
    expect(readAttachSnapshot("/proj/a")).toEqual(snap(1))
  })

})

describe("currentAttachSnapshot", () => {
  beforeEach(() => rmSync(snapshotDir(), { recursive: true, force: true }))

  test.each([
    ["the bound workspace under the same credentials", { scope: SCOPE, datamateId: 6 }, true],
    ["the id given as a string", { scope: SCOPE, datamateId: "6" }, true],
    ["a workspace the project was re-linked to", { scope: SCOPE, datamateId: 7 }, false],
    ["the same id under another tenant", { scope: "other|https://api.example.com", datamateId: 6 }, false],
    ["the same id under no credentials", { scope: null, datamateId: 6 }, false],
    ["an unlinked project", null, false],
  ] as const)("%s: %p", (_label, bound, shown) => {
    writeAttachSnapshot("/proj/a", snap(1))
    expect(currentAttachSnapshot("/proj/a", bound) !== undefined).toBe(shown)
  })
})

describe("snapshotCounts", () => {
  const counts = (s: Partial<AttachSnapshot>) =>
    snapshotCounts({ declared: null, present: [], unfulfilled: undefined, ...s })

  test.each([
    ["a raw key served under its sanitised name", { keys: ["jira.search"], extensionKeys: [] }, ["jira_search"], [], 1],
    ["two raw keys that sanitise to one name", { keys: ["a.b", "a_b"], extensionKeys: [] }, ["a_b"], [], 1],
    ["a key both served and reported", { keys: ["a", "b"], extensionKeys: [] }, ["a", "b"], [{ key: "b", integrationId: "x", reason: "exception" }], 1],
    ["nothing served", { keys: ["a"], extensionKeys: [] }, [], [], 0],
  ] as const)("%s", (_label, declared, present, unfulfilled, served) => {
    const c = counts({ declared: { ...declared, keys: [...declared.keys], extensionKeys: [] }, present: [...present], unfulfilled: [...unfulfilled] as never })
    expect(c.served).toBe(served)
    expect(c.declared).toBe(declared.keys.length)
  })

  test("without an allowlist, everything served counts and nothing is declared", () => {
    expect(counts({ present: ["a", "b", "knowledge"] })).toMatchObject({ served: 3, declared: undefined, extServed: 0 })
  })

  test("extension keys count after ordinary ones, so a name both claim counts once", () => {
    const c = counts({ declared: { keys: ["a"], extensionKeys: ["a", "x"] }, present: ["a", "x"] })
    expect(c).toMatchObject({ served: 1, extServed: 1, callable: ["a", "x"] })
  })

  test("the expected no-bridge report is not a gap", () => {
    const c = counts({
      declared: { keys: ["a"], extensionKeys: ["x"] },
      unfulfilled: [
        { key: "a", integrationId: "jira", reason: "invalid-connection" },
        { key: "x", integrationId: "power-user", reason: "no-bridge" },
      ],
    })
    expect(c.gaps).toBe(1)
  })
})

describe("describeAge", () => {
  test.each([
    [0, "just now"],
    [59_999, "just now"],
    [60_000, "1m ago"],
    [119_999, "1m ago"],
    [3_599_999, "59m ago"],
    [3_600_000, "1h ago"],
    [47 * 3_600_000, "47h ago"],
    [48 * 3_600_000, "2d ago"],
  ])("%p ms ago is %p", (elapsed, label) => {
    expect(describeAge(1_000_000_000, 1_000_000_000 + elapsed)).toBe(label)
  })
})

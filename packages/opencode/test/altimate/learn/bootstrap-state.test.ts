// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bootstrapStateFile, readBootstrapState, updateBootstrapState } from "../../../src/altimate/learn/bootstrap-state"
import { appendSignals, readSignalsSnapshot } from "../../../src/altimate/learn/signals"

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-bootstrap-state-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

describe("bootstrap checkpoints", () => {
  test("scope reads of an unused project do not create state", async () => {
    expect(await readBootstrapState(root)).toEqual({ version: 1, pendingSessions: [], sessions: {} })
    expect(await readSignalsSnapshot(root)).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })

  test("persists traversal cursor, seen IDs, and pending reflection order across runs", async () => {
    await updateBootstrapState(root, (state) => {
      state.cursor = { created: 1_000, id: "ses_oldest" }
      state.scope = { projectID: "project", directory: "/project/packages/opencode" }
      state.sessions.ses_oldest = { messageIDs: ["msg_correction"], partIDs: ["part_retry"] }
      state.pendingSessions.push("ses_oldest", "ses_newer")
    })
    const resumed = await readBootstrapState(root)
    expect(resumed.cursor).toEqual({ created: 1_000, id: "ses_oldest" })
    expect(resumed.scope).toEqual({ projectID: "project", directory: "/project/packages/opencode" })
    expect(resumed.sessions.ses_oldest).toEqual({ messageIDs: ["msg_correction"], partIDs: ["part_retry"] })
    expect(resumed.pendingSessions).toEqual(["ses_oldest", "ses_newer"])
    await updateBootstrapState(root, (state) => { state.pendingSessions.shift() })
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["ses_newer"])
    if (process.platform !== "win32") expect((await fs.stat(bootstrapStateFile(root))).mode & 0o777).toBe(0o600)
  })

  test("concurrent checkpoint updates preserve each session's IDs", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => updateBootstrapState(root, (state) => {
      state.sessions[`s${i}`] = { messageIDs: [`m${i}`], partIDs: [] }
      state.pendingSessions.push(`s${i}`)
    })))
    const state = await readBootstrapState(root)
    expect(Object.keys(state.sessions)).toHaveLength(5)
    expect(new Set(state.pendingSessions).size).toBe(5)
  })

  test("named playbooks have independent checkpoints", async () => {
    await updateBootstrapState(root, (state) => { state.cursor = { created: 10, id: "default" } })
    await updateBootstrapState(root, (state) => { state.cursor = { created: 20, id: "custom" } }, "custom-rules")
    expect((await readBootstrapState(root)).cursor?.id).toBe("default")
    expect((await readBootstrapState(root, "custom-rules")).cursor?.id).toBe("custom")
  })

  test("a crash after signal append before checkpoint safely replays without duplicate signals", async () => {
    const inputs = [{ kind: "user_correction", sessionID: "session", messageID: "message", source: "bootstrap", text: "No, use ref().", reason: "correction" }] as const
    await expect(updateBootstrapState(root, async () => {
      await appendSignals(root, inputs)
      throw new Error("interrupted extraction")
    })).rejects.toThrow("interrupted extraction")
    expect((await readBootstrapState(root)).sessions).toEqual({})
    expect(await readSignalsSnapshot(root)).toHaveLength(1)
    await updateBootstrapState(root, async (state) => {
      expect(await appendSignals(root, inputs)).toEqual([])
      state.sessions.session = { messageIDs: ["message"], partIDs: [] }
      state.pendingSessions.push("session")
    })
    expect(await readSignalsSnapshot(root)).toHaveLength(1)
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["session"])
  })

  test("interrupted atomic checkpoint preserves the prior resumable state", async () => {
    await updateBootstrapState(root, (state) => { state.cursor = { created: 100, id: "before" } })
    const rename = fs.rename
    const failure = spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === bootstrapStateFile(root)) throw new Error("interrupted checkpoint")
      return rename(...args)
    })
    try {
      await expect(updateBootstrapState(root, (state) => {
        state.cursor = { created: 50, id: "after" }
      })).rejects.toThrow("interrupted checkpoint")
    } finally { failure.mockRestore() }
    expect((await readBootstrapState(root)).cursor).toEqual({ created: 100, id: "before" })
  })

  test("corrupt checkpoints fail closed and remain untouched by previews or updates", async () => {
    const file = bootstrapStateFile(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const raw of ["not json", '{"version":1,"pendingSessions":[],"sessions":{},"cursor":{"id":"s","created":"bad"}}',
      '{"version":1,"pendingSessions":[],"sessions":{"s":{"messageIDs":[42],"partIDs":[]}}}',
      '{"version":1,"pendingSessions":[],"sessions":{},"scope":{"projectID":"project","directory":42}}']) {
      await fs.writeFile(file, raw)
      await expect(readBootstrapState(root)).rejects.toThrow("Invalid learning bootstrap state")
      await expect(updateBootstrapState(root, () => {})).rejects.toThrow("Invalid learning bootstrap state")
      expect(await fs.readFile(file, "utf8")).toBe(raw)
    }
    expect(await fs.readdir(path.dirname(file))).toEqual(["bootstrap.json"])
  })
})

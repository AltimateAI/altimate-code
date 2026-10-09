// altimate_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LearnNudge, NUDGE_MESSAGE, NUDGE_TOAST } from "../../../src/altimate/learn/nudge"
import { claimNudge, dismissNudge } from "../../../src/altimate/learn/nudge-state"
import { tmpdir } from "../../fixture/fixture"

function fixture(project: string, state: string) {
  const shown: string[] = []
  const flags = { enabled: false, eligible: true }
  const nudge = new LearnNudge({
    project: () => project,
    enabled: () => flags.enabled,
    eligible: () => flags.eligible,
    claim: (project) => claimNudge(project, state),
    show: (message) => shown.push(message),
  })
  function message(id: string, role = "user", sessionID = "session") {
    nudge.onMessage({ id, role, sessionID, time: role === "assistant" ? { completed: 1 } : {} })
  }
  function text(id: string, text = "That is wrong. Use the project helper instead.", sessionID = "session") {
    return nudge.onPart({ type: "text", messageID: id, sessionID, text })
  }
  function correction(id: string, sessionID = "session") {
    message(id + "-assistant", "assistant", sessionID)
    message(id, "user", sessionID)
    return text(id, undefined, sessionID)
  }
  return { nudge, shown, flags, message, text, correction }
}

describe("off-mode TUI learning nudge", () => {
  test("counts only in memory, then writes only global nudge state at the first idle after two corrections", async () => {
    await using dir = await tmpdir()
    const project = path.join(dir.path, "project")
    const state = path.join(dir.path, "state")
    await fs.mkdir(project)
    const f = fixture(project, state)
    f.message("first")
    await f.text("first") // A correction-shaped initial task is not a correction.
    await f.nudge.onIdle("session")
    await f.correction("one")
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([])
    expect(await fs.readdir(dir.path)).toEqual(["project"])
    expect(await fs.readdir(project)).toEqual([])

    // Do not await classification: idle must wait for the lazy classifier.
    void f.correction("two")
    expect(f.shown).toEqual([])
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([NUDGE_TOAST])
    expect(f.shown[0]).toStartWith(NUDGE_MESSAGE)
    expect(f.shown[0]).toContain("Don't show again: `altimate-code learn nudge off`")
    await f.nudge.onIdle("session")
    await f.correction("three")
    await f.nudge.onIdle("session")
    expect(f.shown).toHaveLength(1)
    expect(await fs.readdir(state)).toEqual(["learn-nudge.json"])
    expect(await fs.readdir(project)).toEqual([])
    expect(await fs.readFile(path.join(state, "learn-nudge.json"), "utf8")).not.toContain("project helper")
  })

  test("counts once per user message and ignores synthetic, ignored, assistant and non-correction text", async () => {
    await using dir = await tmpdir()
    const f = fixture(dir.path, path.join(dir.path, "state"))
    await f.correction("one")
    await f.text("one")
    await f.text("one-assistant")
    f.message("noise")
    await f.nudge.onPart({
      type: "text",
      sessionID: "session",
      messageID: "noise",
      text: "That is wrong",
      synthetic: true,
    })
    await f.nudge.onPart({
      type: "text",
      sessionID: "session",
      messageID: "noise",
      text: "That is wrong",
      ignored: true,
    })
    await f.text("noise", "Thanks, now add a feature.")
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([])
    await f.correction("two")
    await f.nudge.onIdle("session")
    expect(f.shown).toHaveLength(1)
  })

  test("counts per session and loses counts on TUI disposal", async () => {
    await using dir = await tmpdir()
    const state = path.join(dir.path, "state")
    const f = fixture(dir.path, state)
    await f.correction("one", "a")
    await f.correction("two", "b")
    await f.nudge.onIdle("a")
    await f.nudge.onIdle("b")
    expect(f.shown).toEqual([])
    f.nudge.dispose()
    const next = fixture(dir.path, state)
    await next.correction("three", "a")
    await next.nudge.onIdle("a")
    expect(next.shown).toEqual([])
    expect(await fs.readdir(dir.path)).toEqual([])
  })

  test("uses hydrated prior assistant context for resumed sessions without reading history", async () => {
    const shown: string[] = []
    const nudge = new LearnNudge({
      project: () => "/project",
      enabled: () => false,
      eligible: () => true,
      hasPriorAssistant: () => true,
      claim: async () => true,
      show: (text) => shown.push(text),
    })
    for (const id of ["one", "two"]) {
      nudge.onMessage({ id, role: "user", sessionID: "session" })
      await nudge.onPart({ type: "text", messageID: id, sessionID: "session", text: "That is wrong" })
    }
    await nudge.onIdle("session")
    expect(shown).toEqual([NUDGE_TOAST])
  })

  test.each(["enabled", "eligible"] as const)("%s gate prevents counting and state writes", async (gate) => {
    await using dir = await tmpdir()
    const f = fixture(dir.path, path.join(dir.path, "state"))
    f.flags[gate] = gate === "enabled"
    await f.correction("one")
    await f.correction("two")
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([])
    expect(await fs.readdir(dir.path)).toEqual([])
  })

  test("enabling between the second correction and idle suppresses permanently in this TUI", async () => {
    await using dir = await tmpdir()
    const f = fixture(dir.path, path.join(dir.path, "state"))
    await f.correction("one")
    await f.correction("two")
    f.flags.enabled = true
    await f.nudge.onIdle("session")
    f.flags.enabled = false
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([])
    expect(await fs.readdir(dir.path)).toEqual([])
  })

  test("global dismissal and project/global limits suppress subsequent TUI sessions", async () => {
    await using dir = await tmpdir()
    const state = path.join(dir.path, "state")
    for (const [project, count] of [
      ["a", 1],
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["d", 0],
    ] as const) {
      const f = fixture(path.join(dir.path, project), state)
      await f.correction("one")
      await f.correction("two")
      await f.nudge.onIdle("session")
      expect(f.shown).toHaveLength(count)
    }
    const fresh = path.join(dir.path, "dismissed-state")
    await dismissNudge(fresh)
    const f = fixture(dir.path, fresh)
    await f.correction("one")
    await f.correction("two")
    await f.nudge.onIdle("session")
    expect(f.shown).toEqual([])
  })

  test("rechecks eligibility after claiming without retrying the notice", async () => {
    let eligible = true
    let claims = 0
    const shown: string[] = []
    const nudge = new LearnNudge({
      project: () => "/project",
      enabled: () => false,
      eligible: () => eligible,
      show: (text) => shown.push(text),
      claim: async () => {
        claims++
        eligible = false
        return true
      },
    })
    nudge.onMessage({ id: "assistant", sessionID: "session", role: "assistant", time: { completed: 1 } })
    for (const id of ["one", "two"]) {
      nudge.onMessage({ id, sessionID: "session", role: "user" })
      await nudge.onPart({ messageID: id, sessionID: "session", type: "text", text: "That is wrong" })
    }
    await nudge.onIdle("session")
    eligible = true
    await nudge.onIdle("session")
    expect(claims).toBe(1)
    expect(shown).toEqual([])
  })
})

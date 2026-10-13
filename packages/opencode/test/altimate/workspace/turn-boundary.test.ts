// altimate_change - new file
//
// When one prompt loop runs the workspace engine's turn boundary. Each test replays the history a
// loop sees at its successive tool catalogs: the boundary runs on the first catalog and on the first
// catalog after a new user request joins the loop, never on a message the loop wrote itself.
import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../../src/session/message-v2"
import { tracker } from "../../../src/altimate/workspace/turn-boundary"

let counter = 0
const next = (prefix: string) => `${prefix}_${String(++counter).padStart(4, "0")}`

function message(role: "user" | "assistant", parts: Record<string, unknown>[]): MessageV2.WithParts {
  const id = next("msg")
  return {
    info: { id, sessionID: "ses_test", role, time: { created: 0 } },
    parts: parts.map((part) => ({ id: next("prt"), sessionID: "ses_test", messageID: id, ...part })),
  } as unknown as MessageV2.WithParts
}

const asked = (value: string) => message("user", [{ type: "text", text: value }])
const reply = () => message("assistant", [{ type: "text", text: "working" }])
const loopWrote = (value: string) => message("user", [{ type: "text", text: value, synthetic: true }])
const marker = () => message("user", [{ type: "compaction", auto: true }])
const replayOf = (original: MessageV2.WithParts) =>
  message("user", [{ type: "text", text: "again", metadata: { learnOriginalMessage: original.info.id } }])

/** Runs the tracker over the history as it stood at each catalog; returns which catalogs ran the boundary. */
function catalogs(...histories: MessageV2.WithParts[][]): boolean[] {
  const boundary = tracker()
  return histories.map((history) => boundary(history))
}

describe("workspace turn boundary", () => {
  test("runs on the loop's first catalog, then not again for the same request", () => {
    const a = asked("connect jira")
    expect(catalogs([a], [a, reply()], [a, reply(), reply()])).toEqual([true, false, false])
  })

  test("runs on the first catalog even when the loop resumes on a message it wrote", () => {
    expect(catalogs([marker(), loopWrote("Continue if you have next steps")])).toEqual([true])
  })

  test("does not run for the messages the loop writes itself", () => {
    const a = asked("connect jira")
    const h1 = [a, reply()]
    const h2 = [...h1, loopWrote("Summarize the task tool output above and continue with your task.")]
    const h3 = [...h2, reply(), loopWrote("validator failures: ...")]
    const h4 = [...h3, reply(), marker(), reply(), loopWrote("Continue if you have next steps")]
    expect(catalogs([a], h2, h3, h4)).toEqual([true, false, false, false])
  })

  test("does not run for a stamped compaction replay of the current request", () => {
    const a = asked("connect jira")
    expect(catalogs([a], [a, reply(), marker(), reply(), replayOf(a)])).toEqual([true, false])
  })

  test("runs once for a message queued while the assistant was busy", () => {
    const a = asked("first")
    const b = asked("now use the engine")
    const h1 = [a, reply()]
    const h2 = [...h1, b]
    const h3 = [...h2, reply()]
    expect(catalogs([a], h2, h3)).toEqual([true, true, false])
  })

  test("runs for a queued message even when the loop writes one after it before the next catalog", () => {
    const a = asked("first")
    const b = asked("/review with a subtask")
    const h2 = [a, reply(), b, reply(), loopWrote("Summarize the task tool output above and continue with your task.")]
    expect(catalogs([a], h2)).toEqual([true, true])
  })

  test("does not run again for a stamped replay of an earlier request", () => {
    const a = asked("first")
    const b = asked("second")
    const h2 = [a, reply(), b]
    const h3 = [...h2, reply(), marker(), reply(), replayOf(a)]
    expect(catalogs([a], h2, h3)).toEqual([true, true, false])
  })

  test("runs once more for an unstamped replay, where the request restarts from the summary", () => {
    // With lessons not delivered, compaction does not stamp the replay, so it is a request of its own.
    const a = asked("first")
    const h2 = [a, reply(), marker(), reply(), asked("first")]
    expect(catalogs([a], h2)).toEqual([true, true])
  })

  test("each loop keeps its own record", () => {
    const a = asked("first")
    expect(catalogs([a], [a])).toEqual([true, false])
    expect(catalogs([a])).toEqual([true])
  })
})

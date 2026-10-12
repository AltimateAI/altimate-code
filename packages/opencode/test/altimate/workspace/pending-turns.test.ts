// altimate_change - new file
// A turn starts its workspace sync in the background and registers it at once; `run`'s exit flush must wait for
// it even when the sync itself has not registered yet (it does so only after an import and a few awaits).
import { describe, expect, test } from "bun:test"
import * as PendingTurns from "../../../src/altimate/workspace/pending-turns"
import { flushPendingSyncs } from "../../../src/altimate/workspace/skill-sync"

describe("background turn work", () => {
  test("the exit flush waits for work a turn registered, and forgets it once settled", async () => {
    let done = false
    PendingTurns.track(new Promise<void>((r) => setTimeout(() => ((done = true), r()), 60)))
    await flushPendingSyncs(5_000)
    expect(done).toBe(true)
    await Promise.resolve()
    expect(PendingTurns.all()).toEqual([])
  })

  test("a failed piece of work is forgotten too, and does not fail the flush", async () => {
    PendingTurns.track(Promise.reject(new Error("offline")))
    await flushPendingSyncs(1_000)
    await Promise.resolve()
    expect(PendingTurns.all()).toEqual([])
  })
})

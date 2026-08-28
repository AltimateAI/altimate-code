// Mirrors the beforeExit crash-handler contract from cli/cmd/run.ts:
// - the handler marks the run failed (exitCode 1) only while the run is
//   still in flight (event loop drained before completion);
// - a run that completes normally sets runFinished, restores exitCode, and
//   removes the listener, so a premature/spurious firing can never poison a
//   successful run's rc;
// - fatal accounting remains the single authority for a nonzero rc afterwards.
// If the handler logic in run.ts changes, update this mirror to match.
import { describe, expect, test } from "bun:test"

function makeRun() {
  const proc = { exitCode: undefined as number | undefined, listeners: new Set<() => void>() }
  let runFinished = false
  const onBeforeExit = () => {
    if (!runFinished) proc.exitCode = 1
  }
  proc.listeners.add(onBeforeExit)
  const fireBeforeExit = () => {
    for (const listener of proc.listeners) listener()
  }
  const finish = (fatal: boolean) => {
    runFinished = true
    proc.exitCode = 0
    proc.listeners.delete(onBeforeExit)
    if (fatal) proc.exitCode = 1
  }
  return { proc, fireBeforeExit, finish }
}

describe("run beforeExit rc stickiness", () => {
  test("abandoned run (loop drains mid-flight) exits nonzero", () => {
    const run = makeRun()
    run.fireBeforeExit()
    expect(run.proc.exitCode).toBe(1)
  })

  test("spurious firing before a successful completion does not poison rc 0", () => {
    const run = makeRun()
    run.fireBeforeExit() // event-loop gap while SSE/challenge promises pend
    run.finish(false)
    expect(run.proc.exitCode).toBe(0)
    // any later firing is a no-op: listener removed
    run.fireBeforeExit()
    expect(run.proc.exitCode).toBe(0)
  })

  test("fatal accounting still exits nonzero after a normal drain", () => {
    const run = makeRun()
    run.finish(true)
    expect(run.proc.exitCode).toBe(1)
  })
})

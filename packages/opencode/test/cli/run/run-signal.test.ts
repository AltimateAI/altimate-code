// altimate_change start — fork-only: a signal the npm wrapper forwards is one delivery, not two
import { describe, expect, test } from "bun:test"
import { RunSignal } from "../../../src/cli/cmd/run-signal"

function harness(forwarded: boolean) {
  let now = 0
  const handled: string[] = []
  const accept = RunSignal.coalescer(forwarded, () => now)
  const onSigterm = accept("SIGTERM", () => handled.push("SIGTERM"))
  const onSigint = accept("SIGINT", () => handled.push("SIGINT"))
  return {
    handled,
    at(ms: number) {
      now = ms
    },
    onSigterm,
    onSigint,
  }
}

describe("run signal coalescing", () => {
  test("a forwarded copy of a group-directed signal is not a second delivery", () => {
    const run = harness(true)
    run.onSigterm()
    run.at(5)
    run.onSigterm()
    expect(run.handled).toEqual(["SIGTERM"])
  })

  test("a second signal after the forwarded copy is a second delivery, so Ctrl-C twice still exits", () => {
    const run = harness(true)
    run.onSigint()
    run.at(3)
    run.onSigint()
    run.at(400)
    run.onSigint()
    expect(run.handled).toEqual(["SIGINT", "SIGINT"])
  })

  test("a repeat after the window is a second delivery", () => {
    const run = harness(true)
    run.onSigterm()
    run.at(RunSignal.REPEAT_WINDOW_MS)
    run.onSigterm()
    expect(run.handled).toEqual(["SIGTERM", "SIGTERM"])
  })

  test("different signals are never merged", () => {
    const run = harness(true)
    run.onSigint()
    run.onSigterm()
    expect(run.handled).toEqual(["SIGINT", "SIGTERM"])
  })

  test("without a forwarding wrapper every signal is delivered, as before", () => {
    const run = harness(false)
    run.onSigint()
    run.onSigint()
    expect(run.handled).toEqual(["SIGINT", "SIGINT"])
  })

  test("only the wrapper's marker turns coalescing on", () => {
    expect(RunSignal.forwardedByWrapper({ ALTIMATE_WRAPPER_FORWARDS_SIGNALS: "1" })).toBe(true)
    expect(RunSignal.forwardedByWrapper({})).toBe(false)
  })
})
// altimate_change end

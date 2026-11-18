import { afterEach, expect, spyOn, test } from "bun:test"
import { withStopSignals } from "../../../src/altimate/tool-cli/stop-signals"

const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
let exits: ReturnType<typeof spyOn> | undefined
afterEach(() => exits?.mockRestore())

test("SIGTERM aborts the run's signal, and the handlers are gone afterwards", async () => {
  const before = listeners()
  const seen = await withStopSignals(async (signal) => {
    process.emit("SIGTERM")
    return signal.aborted ? (signal.reason as Error).message : "running"
  })
  expect(seen).toBe("Stopped by SIGTERM.")
  expect(listeners()).toEqual(before)
})

test("a second signal exits at once instead of waiting for the run to wind down", async () => {
  const codes: unknown[] = []
  exits = spyOn(process, "exit").mockImplementation(((code?: number) => {
    codes.push(code)
  }) as never)
  await withStopSignals(async () => {
    process.emit("SIGINT")
    process.emit("SIGINT")
  })
  expect(codes).toEqual([130])
})

test("a run that is never stopped sees no abort", async () => {
  expect(await withStopSignals(async (signal) => signal.aborted)).toBe(false)
})

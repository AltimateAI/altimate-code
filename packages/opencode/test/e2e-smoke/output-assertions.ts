import { expect } from "bun:test"
import { OutputCollector } from "../../src/cli/cmd/run-output"

type Event = { type?: string; part?: { text?: string; synthetic?: boolean } }

export function assertFinalOutput(events: Event[], output: string) {
  const collected = new OutputCollector()
  let textCount = 0
  for (const event of events) {
    if (event.type === "step_start") collected.stepStart()
    if (event.type === "text" && event.part?.text) {
      textCount++
      collected.text(event.part.text, { synthetic: event.part.synthetic })
    }
  }
  expect(textCount, "At least one text event must be emitted").toBeGreaterThan(0)
  expect(output).toContain(collected.content())
}

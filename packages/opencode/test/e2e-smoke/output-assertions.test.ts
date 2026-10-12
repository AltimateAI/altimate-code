import { test } from "bun:test"
import { assertFinalOutput } from "./output-assertions"

for (const acknowledgement of [false, true]) {
  test(`smoke output accepts superseded narration${acknowledgement ? " followed by DONE" : ""}`, () => {
    const events = [
      { type: "step_start" },
      { type: "text", part: { text: "Let me inspect the source." } },
      { type: "step_start" },
      { type: "text", part: { text: "**Answer:** 42" } },
      ...(acknowledgement ? [{ type: "step_start" }, { type: "text", part: { text: "DONE" } }] : []),
    ]
    assertFinalOutput(events, "**Answer:** 42")
  })
}

import { describe, expect, test } from "bun:test"
import { NO_TEXT_OUTPUT, OutputCollector } from "../../../src/cli/cmd/run-output"

// `run --output` must hold the reply, not the transcript: in one evaluation run 9 of 31
// answers began with commentary from an earlier step ("Use sql_materialize from scratch
// instead.", "Mixed time formats. Let me check all formats.").
describe("run --output collector", () => {
  test("keeps only the text of the last model step", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("Mixed time formats. Let me check all formats.")
    out.stepStart()
    out.text("Use sql_materialize from scratch instead.")
    out.stepStart()
    out.text("Population: businesses with reviews.")
    out.text("**Answer:** 42")
    expect(out.content()).toBe("Population: businesses with reviews.\n\n**Answer:** 42")
  })

  test("a compaction step does not discard the reply written before it", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("**Answer:** 42")
    out.stepStart(true)
    out.text("Summary of the conversation so far.", { compaction: true })
    expect(out.content()).toBe("**Answer:** 42")
  })

  test("synthetic text never becomes the reply", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("injected", { synthetic: true })
    expect(out.content()).toBe("injected")
    out.stepStart()
    out.text("**Answer:** 7")
    expect(out.content()).toBe("**Answer:** 7")
  })

  // The completion check / post-compaction nudge asks for a bare DONE when the deliverable is
  // complete; that acknowledgement must not replace the answer it confirms.
  test("a bare DONE acknowledgement keeps the answer it confirms", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("**Answer:** 42")
    out.stepStart(true)
    out.text("Summary so far.", { compaction: true })
    out.stepStart()
    out.text("DONE")
    expect(out.content()).toBe("**Answer:** 42")
  })

  test("an answer, a tool step, then DONE still yields the answer", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("**Answer:** 42")
    out.stepStart()
    out.stepStart()
    out.text("done.")
    expect(out.content()).toBe("**Answer:** 42")
  })

  test("substantive text after a challenge replaces the earlier reply", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("**Answer:** 41")
    out.stepStart()
    out.text("Corrected after re-checking.\n\n**Answer:** 42\nDONE")
    expect(out.content()).toBe("Corrected after re-checking.\n\n**Answer:** 42\nDONE")
  })

  test("a harness note alone explains a run that ended without a reply", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("Let me look at the schema first.")
    out.stepStart()
    out.note("No answer was produced: the turn ended after `sql_execute` failed.")
    expect(out.content()).toBe("No answer was produced: the turn ended after `sql_execute` failed.")
  })

  test("falls back to everything said when there is neither a reply nor a note", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("Let me look at the schema first.")
    out.stepStart()
    expect(out.content()).toBe("Let me look at the schema first.")
  })

  test("writes the placeholder when nothing was said", () => {
    const out = new OutputCollector()
    out.stepStart()
    out.text("   ")
    expect(out.content()).toBe(NO_TEXT_OUTPUT)
  })
})

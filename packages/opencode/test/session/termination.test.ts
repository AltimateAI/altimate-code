// Harness reliability unit gates — SessionTermination completion-token
// contract and the explicit-DONE stop-path decision.
//
// (a): "finished naturally" requires finishReason "stop" PLUS an explicit
// trailing DONE assertion — never bare "stop".
import { describe, expect, test } from "bun:test"
import { SessionTermination } from "../../src/session/termination"

describe("SessionTermination.isExplicitDone", () => {
  test("accepts a standalone final-line DONE assertion", () => {
    expect(SessionTermination.isExplicitDone("DONE")).toBe(true)
    expect(SessionTermination.isExplicitDone("All 14 checks green.\nDONE")).toBe(true)
    expect(SessionTermination.isExplicitDone("Verified the build.\n\nDONE")).toBe(true)
    expect(SessionTermination.isExplicitDone("DONE  ")).toBe(true)
    expect(SessionTermination.isExplicitDone("DONE\n\n")).toBe(true)
    expect(SessionTermination.isExplicitDone("  DONE  ")).toBe(true)
  })

  test("rejects ordinary text and mid-sentence mentions", () => {
    expect(SessionTermination.isExplicitDone("Let me now read the schema file.")).toBe(false)
    expect(SessionTermination.isExplicitDone("marked the TODO as DONE and moving on")).toBe(false)
    expect(SessionTermination.isExplicitDone("DONE with step 1, continuing to step 2")).toBe(false)
    expect(SessionTermination.isExplicitDone("")).toBe(false)
  })

  test("requires exactly DONE on the final line — no punctuation or markup wrappers", () => {
    expect(SessionTermination.isExplicitDone("All checks green. DONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("Verified the build.\n\nDONE.")).toBe(false)
    expect(SessionTermination.isExplicitDone("DONE!")).toBe(false)
    expect(SessionTermination.isExplicitDone("**DONE**")).toBe(false)
    expect(SessionTermination.isExplicitDone("`DONE`")).toBe(false)
  })

  test("code-fenced text ending in DONE never terminates", () => {
    // Closed fence: the final line is the closing fence, not DONE.
    expect(SessionTermination.isExplicitDone("Example output:\n```\nDONE\n```")).toBe(false)
    // Unclosed fence: the final DONE line is inside quoted code.
    expect(SessionTermination.isExplicitDone("Reply like this:\n```\nDONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("~~~\nDONE")).toBe(false)
    // A closed fence FOLLOWED by a real plaintext DONE still terminates.
    expect(SessionTermination.isExplicitDone("```\nbuild ok\n```\nDONE")).toBe(true)
  })

  test("quoted and indented-code DONE never terminates", () => {
    expect(SessionTermination.isExplicitDone("The instructions said:\n> DONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("Example:\n    DONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("Example:\n\tDONE")).toBe(false)
  })

  test("is case-sensitive: prose 'done' never counts", () => {
    expect(SessionTermination.isExplicitDone("I'm done")).toBe(false)
    expect(SessionTermination.isExplicitDone("done.")).toBe(false)
    expect(SessionTermination.isExplicitDone("Done")).toBe(false)
  })

  test("does not match inside a longer trailing word", () => {
    expect(SessionTermination.isExplicitDone("ABANDONED")).toBe(false)
    expect(SessionTermination.isExplicitDone("UNDONE")).toBe(false)
  })
})

describe("SessionTermination.explicitDoneStop (stop-path decision)", () => {
  const textPart = (text: string, synthetic?: boolean) => ({ type: "text", text, synthetic })

  test("errorless stop + trailing DONE in the final real text part → stop", () => {
    expect(
      SessionTermination.explicitDoneStop({
        finish: "stop",
        hasError: false,
        parts: [{ type: "tool" }, textPart("Everything verified.\nDONE")],
      }),
    ).toBe(true)
  })

  test("bare finishReason stop is NEVER enough", () => {
    expect(
      SessionTermination.explicitDoneStop({
        finish: "stop",
        hasError: false,
        parts: [textPart("Let me now read the schema file.")],
      }),
    ).toBe(false)
  })

  test("non-stop finish reasons never terminate", () => {
    for (const finish of ["tool-calls", "length", "error", "content-filter", "unknown", undefined]) {
      expect(
        SessionTermination.explicitDoneStop({
          finish,
          hasError: false,
          parts: [textPart("DONE")],
        }),
      ).toBe(false)
    }
  })

  test("an errored turn never terminates via DONE", () => {
    expect(
      SessionTermination.explicitDoneStop({
        finish: "stop",
        hasError: true,
        parts: [textPart("DONE")],
      }),
    ).toBe(false)
  })

  test("synthetic (system-authored) text parts are ignored", () => {
    expect(
      SessionTermination.explicitDoneStop({
        finish: "stop",
        hasError: false,
        parts: [textPart("still working"), textPart("reply with DONE and stop.", true)],
      }),
    ).toBe(false)
  })

  test("the LAST real text part governs (a later non-DONE text clears it)", () => {
    expect(
      SessionTermination.explicitDoneStop({
        finish: "stop",
        hasError: false,
        parts: [textPart("DONE"), textPart("actually, one more thing")],
      }),
    ).toBe(false)
  })

  test("no text parts at all → no stop", () => {
    expect(
      SessionTermination.explicitDoneStop({ finish: "stop", hasError: false, parts: [{ type: "tool" }] }),
    ).toBe(false)
  })
})

describe("SessionTermination directive texts (/c/d wording contracts)", () => {
  test("the completion nudge offers all three options and instructs the DONE token", () => {
    const nudge = SessionTermination.COMPLETION_NUDGE
    expect(nudge).toContain("(1)")
    expect(nudge).toContain("(2)")
    expect(nudge).toContain("(3)")
    expect(nudge).toContain("ask for clarification")
    expect(nudge).toContain(`reply with ${SessionTermination.DONE_TOKEN}`)
  })

  test("the confirm challenge asks for DONE or what remains — outcome-neutral", () => {
    const challenge = SessionTermination.CONFIRM_DONE_CHALLENGE
    expect(challenge).toContain(SessionTermination.DONE_TOKEN)
    expect(challenge).toContain("state specifically what remains")
  })

  test("the overflow notice is mechanism-accurate: no media-attachment blame", () => {
    expect(SessionTermination.OVERFLOW_NOTICE).not.toContain("media")
    expect(SessionTermination.OVERFLOW_NOTICE).toContain("context limit")
  })

  test("no vertical/product tokens in any directive text (Global rule 4)", () => {
    for (const text of [
      SessionTermination.COMPLETION_NUDGE,
      SessionTermination.CONFIRM_DONE_CHALLENGE,
      SessionTermination.OVERFLOW_NOTICE,
    ]) {
      expect(text.toLowerCase()).not.toContain("dbt")
      expect(text.toLowerCase()).not.toContain("warehouse")
      expect(text.toLowerCase()).not.toContain("sql")
    }
  })
})

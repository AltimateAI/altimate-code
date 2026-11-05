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
    expect(SessionTermination.isExplicitDone("  DONE  ")).toBe(false)
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

  test("fence state tracks marker character and length (CommonMark), not parity", () => {
    // A ``` line inside an unclosed ````-fence is content, not a closer —
    // the trailing DONE is still quoted material.
    expect(SessionTermination.isExplicitDone("Here is the doc:\n````\n```\nDONE")).toBe(false)
    // A ~~~ line that is content of a closed ``` block is not a fence —
    // the final plaintext DONE is a real assertion.
    expect(SessionTermination.isExplicitDone("```\n~~~\n```\nDONE")).toBe(true)
    // A shorter same-character run inside an open fence does not close it.
    expect(SessionTermination.isExplicitDone("`````\n```\n`````\nDONE")).toBe(true)
    // A longer same-character run closes a shorter opener.
    expect(SessionTermination.isExplicitDone("```\ncode\n`````\nDONE")).toBe(true)
    // Tilde fences follow the same rules.
    expect(SessionTermination.isExplicitDone("~~~~\n~~~\nDONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("~~~\n```\n~~~\nDONE")).toBe(true)
  })

  test("a fence-looking line with trailing info-string text never closes the fence", () => {
    // Per CommonMark, only whitespace may follow a closing fence's marker —
    // a line like "```not-a-closer" is content (or a nested opener), not a
    // closer. The DONE that follows is still inside the open fence.
    expect(SessionTermination.isExplicitDone("```\ncode\n```not-a-closer\nDONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("~~~\ncode\n~~~lang\nDONE")).toBe(false)
    // A real closer with trailing whitespace only still closes normally.
    expect(SessionTermination.isExplicitDone("```\ncode\n```   \nDONE")).toBe(true)
  })

  test("quoted and indented-code DONE never terminates", () => {
    expect(SessionTermination.isExplicitDone("The instructions said:\n> DONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("Example:\n    DONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("Example:\n\tDONE")).toBe(false)
    expect(SessionTermination.isExplicitDone("- Expected marker:\n  DONE")).toBe(false)
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
    expect(SessionTermination.explicitDoneStop({ finish: "stop", hasError: false, parts: [{ type: "tool" }] })).toBe(
      false,
    )
  })
})

describe("SessionTermination directive texts (/c/d wording contracts)", () => {
  // altimate_change start — the run-mode nudge: continue, DONE, or report a blocker; never a question
  test("the run-mode completion nudge offers continue, DONE or BLOCKED, never a clarification stop", () => {
    const nudge = SessionTermination.COMPLETION_NUDGE
    expect(nudge).toContain("(1)")
    expect(nudge).toContain("(2)")
    expect(nudge).toContain("(3)")
    expect(nudge).not.toContain("clarification")
    expect(nudge).toContain("do not end your turn with a question")
    expect(nudge).toContain(`reply with ${SessionTermination.DONE_TOKEN}`)
    // The guess clause is limited to safe, reversible choices; a blocker gets its own exit.
    expect(nudge).toContain("safe, reversible")
    expect(nudge).toContain(`${SessionTermination.BLOCKED_PREFIX} <what blocked you>`)
    expect(nudge).toContain(`without ${SessionTermination.DONE_TOKEN}`)
  })

  test("the interactive compaction continuation is unchanged and stays out of the run-mode nudge", async () => {
    const compaction = await Bun.file(new URL("../../src/session/compaction.ts", import.meta.url).pathname).text()
    // Byte-for-byte pin of the interactive continuation text.
    expect(compaction).toContain(
      '"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."',
    )
    expect(compaction).toMatch(/if \(Flag\.ALTIMATE_RUN_MODE\) \{\s*NudgeArbiter\.register\(/)
  })
  // altimate_change end

  test("the confirm challenge asks for DONE or what remains — outcome-neutral", () => {
    const challenge = SessionTermination.CONFIRM_DONE_CHALLENGE
    expect(challenge).toContain(SessionTermination.DONE_TOKEN)
    expect(challenge).toContain("state specifically what remains")
  })

  test("the declined-challenge continuation requires work now and an eventual DONE", () => {
    const continuation = SessionTermination.CONTINUE_AFTER_DECLINED_CHALLENGE
    expect(continuation).toContain("Continue working now")
    expect(continuation).toContain(SessionTermination.DONE_TOKEN)
    expect(continuation).toContain("do not stop merely to describe")
  })

  test("the overflow notice is mechanism-accurate: no media-attachment blame", () => {
    expect(SessionTermination.OVERFLOW_NOTICE).not.toContain("media")
    expect(SessionTermination.OVERFLOW_NOTICE).toContain("context limit")
  })

  // altimate_change start — the run-mode overflow notice never asks the user; the interactive one is unchanged
  test("the run-mode overflow notice does not ask the user to re-supply anything", () => {
    expect(SessionTermination.RUN_MODE_OVERFLOW_NOTICE).not.toContain("ask the user")
    expect(SessionTermination.RUN_MODE_OVERFLOW_NOTICE).toContain("context limit")
    expect(SessionTermination.overflowNotice({ runMode: true })).toBe(SessionTermination.RUN_MODE_OVERFLOW_NOTICE)
    expect(SessionTermination.overflowNotice({ runMode: false })).toBe(
      "The previous request exceeded the model's context limit before a response could be generated. Older " +
        "messages were compacted into the summary above, and oversized content (large tool outputs or file " +
        "attachments) may have been dropped from context. If information you need is missing from the summary, " +
        "re-read the relevant files or ask the user to re-supply it.",
    )
  })
  // altimate_change end

  test("no vertical/product tokens in any directive text (leak-lens hard requirement)", () => {
    for (const text of [
      SessionTermination.COMPLETION_NUDGE,
      SessionTermination.CONFIRM_DONE_CHALLENGE,
      SessionTermination.CONTINUE_AFTER_DECLINED_CHALLENGE,
      SessionTermination.OVERFLOW_NOTICE,
      SessionTermination.RUN_MODE_OVERFLOW_NOTICE,
      SessionTermination.RUN_MODE_COMPLETION_INSTRUCTION,
    ]) {
      expect(text.toLowerCase()).not.toContain("dbt")
      expect(text.toLowerCase()).not.toContain("warehouse")
      expect(text.toLowerCase()).not.toContain("sql")
    }
  })
})

// Regression coverage for the fence-state tracker's CommonMark conformance.
describe("SessionTermination.isExplicitDone — fence-state conformance", () => {
  test("CRLF input still closes fences, so a real DONE is accepted", () => {
    // Interior lines keep a trailing \r before normalization, which made the
    // closing fence fail its whitespace-only check and left the fence open.
    expect(SessionTermination.isExplicitDone("```sh\r\necho hi\r\n```\r\n\r\nDONE\r\n")).toBe(true)
  })

  test("CRLF input inside an UNCLOSED fence is still rejected", () => {
    expect(SessionTermination.isExplicitDone("```sh\r\necho hi\r\nDONE\r\n")).toBe(false)
  })

  test("bare-CR input splits into lines rather than collapsing to one", () => {
    expect(SessionTermination.isExplicitDone("```sh\recho hi\r```\r\rDONE\r")).toBe(true)
  })

  test("a backtick run whose info string contains a backtick is not an opener", () => {
    // CommonMark: a backtick fence's info string may not contain a backtick, so
    // this line is paragraph text. Treating it as an opener made the next
    // backtick run read as its closer, exposing the block interior.
    expect(SessionTermination.isExplicitDone(["```foo`bar", "```", "DONE"].join("\n"))).toBe(false)
  })

  test("a tilde fence's info string may contain backticks", () => {
    expect(SessionTermination.isExplicitDone(["~~~foo`bar", "x", "~~~", "DONE"].join("\n"))).toBe(true)
  })

  test("a closing fence may not carry an info string", () => {
    expect(SessionTermination.isExplicitDone(["```sh", "x", "```sh", "DONE"].join("\n"))).toBe(false)
  })

  test("an unclosed HTML comment cannot turn example content into completion", () => {
    expect(SessionTermination.isExplicitDone(["<!-- expected final marker:", "DONE"].join("\n"))).toBe(false)
    expect(SessionTermination.isExplicitDone(["<!-- note -->", "", "DONE"].join("\n"))).toBe(true)
  })

  test("a DONE line inside an active CommonMark HTML block is rejected", () => {
    expect(SessionTermination.isExplicitDone(["<div>", "example", "DONE"].join("\n"))).toBe(false)
    expect(SessionTermination.isExplicitDone(["<div>", "example", "", "DONE"].join("\n"))).toBe(true)
    expect(SessionTermination.isExplicitDone(["<script>", "example", "DONE"].join("\n"))).toBe(false)
    expect(SessionTermination.isExplicitDone(["<script>", "example", "</script>", "DONE"].join("\n"))).toBe(true)
  })

  test("a quoted > does not end a complete HTML tag or expose a trailing DONE", () => {
    expect(SessionTermination.isExplicitDone(['<widget title="1 > 0">', "example", "DONE"].join("\n"))).toBe(false)
    expect(SessionTermination.isExplicitDone(["<widget title='1 > 0'>", "example", "DONE"].join("\n"))).toBe(false)
    expect(SessionTermination.isExplicitDone(['<widget title="1 > 0">', "example", "", "DONE"].join("\n"))).toBe(true)
  })

  test("HTML-looking text inside a closed code fence does not suppress a real DONE", () => {
    expect(SessionTermination.isExplicitDone(["```html", "<!--", "<div>", "```", "DONE"].join("\n"))).toBe(true)
  })
})
describe("run-mode completion contract", () => {
  // The instruction is injected per run rather than shipped in a static prompt file,
  // so interactive surfaces never see it.
  // altimate_change start — run mode gives every agent except plan the contract; interactive gives none
  test("run mode receives the trailing DONE contract; interactive never does", () => {
    const instruction = SessionTermination.completionInstruction({ runMode: true, agent: "builder" })
    expect(instruction).toBe(SessionTermination.RUN_MODE_COMPLETION_INSTRUCTION)
    expect(instruction).toContain("literal token `DONE` on its own")
    expect(instruction).toContain("Do not emit `DONE` while work or verification remains")
    expect(SessionTermination.completionInstruction({ runMode: true, agent: "reviewer" })).toBe(instruction)
    expect(SessionTermination.completionInstruction({ runMode: false, agent: "builder" })).toBeUndefined()
  })

  test("the plan agent keeps its own stop rule and gets no contract", () => {
    expect(SessionTermination.completionInstruction({ runMode: true, agent: "plan" })).toBeUndefined()
  })

  test("the contract refers to the assigned task, rules out questions and gives a blocked exit", () => {
    const instruction = SessionTermination.RUN_MODE_COMPLETION_INSTRUCTION
    expect(instruction).toContain("when the assigned task is fully completed and verified")
    expect(instruction).not.toContain("every requirement above")
    expect(instruction).toContain("do not end your turn with a question")
    expect(instruction).toContain(`${SessionTermination.BLOCKED_PREFIX} <what blocked you>`)
    expect(SessionTermination.isBlocked(`Done so far.\n${SessionTermination.BLOCKED_PREFIX} no credential`)).toBe(true)
  })
  // altimate_change end

  // builder is a PRIMARY agent, so anything in its prompt file also governs
  // interactive chat — where nothing interprets or strips the token and the user
  // saw a literal DONE on every final answer, including mid-conversation on a
  // follow-up. The instruction must therefore NOT be static in the prompt file.
  test("the builder prompt does not carry the token instruction", async () => {
    // builder.txt was split into core + pack fragments (workload-adaptive
    // harness PR 1); the assembled prompt is byte-identical to the old file.
    const { PROMPT_BUILDER } = await import("../../src/altimate/prompts/profiles")
    expect(PROMPT_BUILDER).not.toContain("literal token `DONE`")
    expect(PROMPT_BUILDER).not.toContain("Do not emit `DONE`")
  })

  // The token itself is unchanged, so the detector that ends a run still pairs
  // with the instruction that asks for it.
  test("the injected instruction names the token the detector accepts", () => {
    expect(SessionTermination.RUN_MODE_COMPLETION_INSTRUCTION).toContain(SessionTermination.DONE_TOKEN)
    expect(SessionTermination.isExplicitDone(SessionTermination.DONE_TOKEN)).toBe(true)
  })
})

// altimate_change start — blocked detector and output-boundary token stripping
describe("SessionTermination.isBlocked", () => {
  test("a final unindented BLOCKED: line with a reason is a blocked ending", () => {
    expect(SessionTermination.isBlocked("Read the config.\nBLOCKED: the password is missing")).toBe(true)
    expect(SessionTermination.isBlocked("BLOCKED: no access\n\n")).toBe(true)
  })

  test("a reasonless, indented, quoted, fenced or non-final BLOCKED line is not", () => {
    expect(SessionTermination.isBlocked("BLOCKED:")).toBe(false)
    expect(SessionTermination.isBlocked("BLOCKED:   ")).toBe(false)
    expect(SessionTermination.isBlocked("    BLOCKED: x")).toBe(false)
    expect(SessionTermination.isBlocked("> BLOCKED: x")).toBe(false)
    expect(SessionTermination.isBlocked("```\nBLOCKED: x")).toBe(false)
    expect(SessionTermination.isBlocked("BLOCKED: x\nthen continued")).toBe(false)
    expect(SessionTermination.isBlocked("blocked: x")).toBe(false)
  })
})

describe("SessionTermination.stripCompletionToken", () => {
  test("drops a trailing DONE line and the blank lines before it", () => {
    expect(SessionTermination.stripCompletionToken('{"title":"x"}\n\nDONE')).toBe('{"title":"x"}')
    expect(SessionTermination.stripCompletionToken("2700\r\n\r\nDONE\n")).toBe("2700")
  })

  test("a bare DONE strips to empty", () => {
    expect(SessionTermination.stripCompletionToken("DONE")).toBe("")
  })

  test("leaves text without a completion assertion unchanged", () => {
    expect(SessionTermination.stripCompletionToken("Example:\n```\nDONE")).toBe("Example:\n```\nDONE")
    expect(SessionTermination.stripCompletionToken("All done.")).toBe("All done.")
    expect(SessionTermination.stripCompletionToken("Read it.\nBLOCKED: no access")).toBe("Read it.\nBLOCKED: no access")
  })
})
// altimate_change end

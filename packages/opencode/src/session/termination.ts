// Fork-only module — FINAL harness-improvement plan W2.1 (item 1): real session
// termination path.
//
// This module owns the COMPLETION-TOKEN CONTRACT for item 1: the post-compaction
// nudge and the idle-done confirm challenge both instruct the model to assert
// completion with a literal trailing `DONE`, and `isExplicitDone()` is the single
// detector every consumer (processor stop-path, run-mode accounting, idle-done
// challenge evaluation) must use, so the instruction and the detection can never
// drift apart.
//
// W2.1(a): "finished naturally" REQUIRES finishReason "stop" PLUS an explicit
// completion assertion in the final text — never bare "stop", which ends nearly
// every ordinary text turn ("Let me now read the schema file." finishes with
// stop). Explicit model DONE is the PRIMARY termination path; the run-mode
// idle-done heuristic (cli/cmd/idle-done.ts) is a fallback only.
//
// Directive texts live here (not at call sites) so the dual-lane gate for any
// wording change reviews ONE file, and both texts stay consistent with the
// detector. Delivery goes through the NudgeArbiter (session/nudge.ts — Global
// rule 5): at most one system-authored directive block per injected turn,
// termination_challenge > starvation_breaker > budget_reminder.

export namespace SessionTermination {
  /** The literal completion token the nudge/challenge instruct the model to emit. */
  export const DONE_TOKEN = "DONE"

  // Trailing, upper-case assertion only. Anchored to the END of the text so an
  // incidental mid-sentence mention ("marked the TODO as DONE and moving on")
  // never counts, and case-sensitive so prose "done" never counts. Light
  // punctuation/markdown closers after the token are tolerated ("DONE.",
  // "**DONE**").
  const DONE_PATTERN = /(?:^|[\s*_`"'([>])DONE[.!]?[)\]"'`*_]*$/

  /** True when the text ends with an explicit completion assertion (W2.1a). */
  export function isExplicitDone(text: string): boolean {
    return DONE_PATTERN.test(text.trim())
  }

  /**
   * W2.1(a) stop-path decision: should a turn that would otherwise trigger
   * compaction terminate the session instead? True only for an errorless turn
   * that finished with "stop" AND asserted completion in its final real
   * (non-synthetic) text part. Returning "compact" for such a turn is the
   * termination-impossibility triangle: the finished session gets summarized and
   * the post-compaction continue message breeds further turns forever. Deferring
   * the compaction is safe in every mode — the pre-dispatch overflow check in
   * prompt.ts compacts before the next request is sent.
   */
  export function explicitDoneStop(input: {
    finish: string | undefined
    hasError: boolean
    parts: readonly { type: string; synthetic?: boolean; text?: string }[]
  }): boolean {
    if (input.hasError) return false
    if (input.finish !== "stop") return false
    const lastText = input.parts.findLast((part) => part.type === "text" && part.synthetic !== true)
    if (!lastText?.text) return false
    return isExplicitDone(lastText.text)
  }

  /**
   * W2.1(b): three-option completion-aware post-compaction nudge. Replaces the
   * two-option "Continue … or stop and ask for clarification" text, which gave a
   * finished session no way to terminate. Prompt-visible text — any change is
   * dual-lane gated (Global rule 2).
   */
  export const COMPLETION_NUDGE =
    "Context was compacted; the summary above is the record of the work so far. Choose exactly one: " +
    "(1) if concrete next steps remain toward the original task, continue with them; " +
    "(2) if you are blocked or unsure how to proceed, stop and ask for clarification; " +
    `(3) if the deliverable is complete and verified, reply with ${DONE_TOKEN} and stop.`

  /**
   * W2.1(c.iv): one-shot confirm-DONE challenge injected by the run-mode
   * idle-done fallback before it may end a session. The session exits as done
   * only on confirmation; otherwise the model states what remains and continues.
   */
  export const CONFIRM_DONE_CHALLENGE =
    "Completion check: the most recent verification succeeded after your last file change and no further " +
    "actions have been taken since. If the deliverable is complete and verified, confirm by replying " +
    `${DONE_TOKEN}. Otherwise, state specifically what remains and continue working on it.`

  /**
   * W2.1(d): mechanism-accurate overflow notice. The previous text blamed "large
   * media attachments" — but the overflow flag is set whenever a request exceeded
   * the provider's context/size limit before any response was produced
   * (prompt.ts sets `overflow: !processor.message.finish`); media is only one
   * possible cause, so the old message was usually false.
   */
  export const OVERFLOW_NOTICE =
    "The previous request exceeded the model's context limit before a response could be generated. Older " +
    "messages were compacted into the summary above, and oversized content (large tool outputs or file " +
    "attachments) may have been dropped from context. If information you need is missing from the summary, " +
    "re-read the relevant files or ask the user to re-supply it."
}

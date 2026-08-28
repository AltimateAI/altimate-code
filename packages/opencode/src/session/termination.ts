// Fork-only module — real session termination path.
//
// This module owns the COMPLETION-TOKEN CONTRACT: the post-compaction
// nudge and the idle-done confirm challenge both instruct the model to assert
// completion with a literal trailing `DONE`, and `isExplicitDone()` is the single
// detector every consumer (processor stop-path, run-mode accounting, idle-done
// challenge evaluation) must use, so the instruction and the detection can never
// drift apart.
//
// "Finished naturally" REQUIRES finishReason "stop" PLUS an explicit
// completion assertion in the final text — never bare "stop", which ends nearly
// every ordinary text turn ("Let me now read the schema file." finishes with
// stop). Explicit model DONE is the PRIMARY termination path; the run-mode
// idle-done heuristic (cli/cmd/idle-done.ts) is a fallback only.
//
// Directive texts live here (not at call sites) so any wording-change review
// covers ONE file, and both texts stay consistent with the
// detector. Delivery goes through the NudgeArbiter (session/nudge.ts):
// at most one system-authored directive block per injected turn,
// termination_challenge > starvation_breaker > budget_reminder.

export namespace SessionTermination {
  /** The literal completion token the nudge/challenge instruct the model to emit. */
  export const DONE_TOKEN = "DONE"

  // Standalone final plaintext line only. The earlier trailing-token regex
  // accepted code-fenced, inline-code, indented, and quoted text whose content
  // happened to end in DONE — demonstration text could be classified as
  // completion. The detector now requires the FINAL line (after stripping
  // trailing whitespace) to be exactly the token: not inside an unclosed code
  // fence, not markdown-indented code (>= 4 leading spaces or a tab), not a
  // `>` quote, not wrapped in backticks or other markup, no punctuation.
  // Case-sensitive so prose "done" never counts.
  const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/

  /** True when the text ends with an explicit completion assertion (see module header). */
  export function isExplicitDone(text: string): boolean {
    const lines = text.replace(/\s+$/, "").split("\n")
    const last = lines[lines.length - 1]
    if (last === undefined) return false
    // Markdown-indented code (4+ spaces or a tab) is demonstration text.
    if (/^(?: {4,}|\t)/.test(last)) return false
    // Up to 3 leading spaces is plain text in Markdown; anything else must match exactly.
    if (last.replace(/^ {0,3}/, "") !== DONE_TOKEN) return false
    // Reject a final line inside an unclosed code fence — the block's content is
    // quoted material, not an assertion. Fence state follows CommonMark: a fence
    // opens with a run of >= 3 backticks or tildes (an info string, e.g. an
    // opening ```lang, is permitted); only a run of the SAME character with at
    // least the SAME length, followed by nothing but optional whitespace, closes
    // it. A fence-looking line with a trailing info string is opener/content,
    // never a valid closer — treating it as one would let a still-open fence's
    // interior DONE terminate the run.
    let open: { char: string; length: number } | undefined
    for (let i = 0; i < lines.length - 1; i++) {
      const match = CODE_FENCE_PATTERN.exec(lines[i]!)
      if (!match) continue
      const marker = match[1]!
      if (!open) {
        open = { char: marker[0]!, length: marker.length }
      } else if (
        marker[0] === open.char &&
        marker.length >= open.length &&
        /^[ \t]*$/.test(lines[i]!.slice(match[0]!.length))
      ) {
        open = undefined
      }
    }
    return open === undefined
  }

  /**
   * Stop-path decision: should a turn that would otherwise trigger
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
   * Three-option completion-aware post-compaction nudge. Replaces the
   * two-option "Continue … or stop and ask for clarification" text, which gave a
   * finished session no way to terminate. Prompt-visible text — changes need
   * extra review.
   */
  export const COMPLETION_NUDGE =
    "Context was compacted; the summary above is the record of the work so far. Choose exactly one: " +
    "(1) if concrete next steps remain toward the original task, continue with them; " +
    "(2) if you are blocked or unsure how to proceed, stop and ask for clarification; " +
    `(3) if the deliverable is complete and verified, reply with ${DONE_TOKEN} alone on the final line and stop.`

  /**
   * One-shot confirm-DONE challenge injected by the run-mode
   * idle-done fallback before it may end a session. The session exits as done
   * only on confirmation; otherwise the model states what remains and continues.
   */
  export const CONFIRM_DONE_CHALLENGE =
    "Completion check: the most recent verification succeeded after your last file change and no further " +
    "actions have been taken since. If the deliverable is complete and verified, confirm by replying " +
    `${DONE_TOKEN} alone on the final line. Otherwise, state specifically what remains and continue working on it.`

  /**
   * Mechanism-accurate overflow notice. The previous text blamed "large
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

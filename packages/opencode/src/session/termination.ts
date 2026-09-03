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

const HTML_BLOCK_TAG =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i

function isCompleteHtmlTag(line: string): boolean {
  if (!/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>)/.test(line)) return false
  let quote: '"' | "'" | undefined
  for (let i = 1; i < line.length; i++) {
    const char = line[i]!
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ">") return /^[ \t]*$/.test(line.slice(i + 1))
  }
  return false
}

function isInsideHtmlBlock(lines: string[]): boolean {
  let close: string | RegExp | "blank" | undefined
  for (const line of lines) {
    if (close === "blank") {
      if (line.trim() === "") close = undefined
      continue
    }
    if (typeof close === "string") {
      if (line.includes(close)) close = undefined
      continue
    }
    if (close instanceof RegExp) {
      if (close.test(line)) close = undefined
      continue
    }

    const trimmed = line.replace(/^ {0,3}/, "")
    const marker = (
      [
        ["<!--", "-->"],
        ["<?", "?>"],
        ["<![CDATA[", "]]>"],
      ] as const
    ).find(([open]) => trimmed.startsWith(open))
    if (marker) {
      if (!trimmed.slice(marker[0].length).includes(marker[1])) close = marker[1]
      continue
    }
    if (/^<![A-Z]/.test(trimmed)) {
      if (!trimmed.includes(">")) close = ">"
      continue
    }
    const rawTag = /^<(script|pre|style|textarea)(?:\s|>)/i.exec(trimmed)?.[1]
    if (rawTag) {
      const end = new RegExp(`</${rawTag}\\s*>`, "i")
      if (!end.test(trimmed)) close = end
      continue
    }
    const block = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>)/.exec(trimmed)
    if ((block && HTML_BLOCK_TAG.test(block[1]!)) || isCompleteHtmlTag(trimmed)) {
      close = "blank"
    }
  }
  return close !== undefined
}

/** True when the text ends with an explicit completion assertion (see module header). */
export function isExplicitDone(text: string): boolean {
  // Normalize line endings FIRST. On CRLF input the interior lines keep a
  // trailing `\r`, which fails the closing fence's whitespace-only check and
  // leaves every fence permanently open (a genuine DONE is then rejected);
  // on bare-CR input the text never splits at all.
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n")
  const last = lines[lines.length - 1]
  if (last === undefined) return false
  // Require an unindented token. CommonMark permits up to three leading
  // spaces in several block constructs; accepting them lets a nested list
  // demonstration (`- Expected marker:` then `  DONE`) terminate the run.
  if (last !== DONE_TOKEN) return false
  // Reject a final line inside an unclosed code fence — the block's content is
  // quoted material, not an assertion. Fence state follows CommonMark: a fence
  // opens with a run of >= 3 backticks or tildes (an info string, e.g. an
  // opening ```lang, is permitted); only a run of the SAME character with at
  // least the SAME length, followed by nothing but optional whitespace, closes
  // it. A fence-looking line with a trailing info string is opener/content,
  // never a valid closer — treating it as one would let a still-open fence's
  // interior DONE terminate the run.
  let open: { char: string; length: number } | undefined
  const outsideFence: string[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    const match = CODE_FENCE_PATTERN.exec(line)
    if (!match) {
      outsideFence.push(open ? "" : line)
      continue
    }
    const marker = match[1]!
    const rest = line.slice(match[0]!.length)
    if (!open) {
      // CommonMark: a backtick fence's info string may not contain a
      // backtick. Such a line is ordinary paragraph text, so treating it as
      // an opener would make a later backtick run look like its closer and
      // expose the interior — including a demonstration DONE — as an
      // assertion.
      if (marker[0] === "`" && rest.includes("`")) {
        outsideFence.push(line)
        continue
      }
      open = { char: marker[0]!, length: marker.length }
    } else if (marker[0] === open.char && marker.length >= open.length && /^[ \t]*$/.test(rest)) {
      open = undefined
    }
    outsideFence.push("")
  }
  if (open) return false
  return !isInsideHtmlBlock(outsideFence)
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
 * Run-mode completion instruction for builder and builder-derived agents.
 *
 * This wording lived in `builder.txt`, but builder is a PRIMARY agent, so a
 * static instruction there also governs interactive chat — where nothing
 * interprets or strips the token and the user saw a literal `DONE` on every
 * final answer, including mid-conversation on follow-ups. `isExplicitDone()`
 * is only consumed by the run-mode accounting path.
 *
 * Injected only in run mode, and only for the agents named in
 * COMPLETION_CONTRACT_AGENTS below (builder, plus the opt-in data-qa profile
 * — see that set for why). For builder alone this is byte-identical to the
 * previous run-mode behaviour, when builder was the only prompt carrying it.
 * Prompt-visible text — changes need extra review.
 */
export const RUN_MODE_COMPLETION_INSTRUCTION =
  "**Signal completion explicitly**: only after every requirement above is satisfied, end your final " +
  `response with the literal token \`${DONE_TOKEN}\` on its own final line. Do not emit \`${DONE_TOKEN}\` ` +
  "while work or verification remains."

/**
 * Agents that receive the run-mode completion-token contract. builder is the
 * historical carrier; data-qa is the builder-derived opt-in profile (its
 * headless runs need a termination contract without inheriting the dbt
 * finish-build ritual, which lives in the prompt packs it omits).
 */
const COMPLETION_CONTRACT_AGENTS = new Set(["builder", "data-qa"])

/** The sole gate for injecting the completion-token contract into a prompt. */
export function completionInstruction(input: { runMode: boolean; agent: string }): string | undefined {
  return input.runMode && COMPLETION_CONTRACT_AGENTS.has(input.agent) ? RUN_MODE_COMPLETION_INSTRUCTION : undefined
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
 * Follow-up used only when the model declines the completion challenge but
 * ends that reply instead of actually continuing. A fresh synthetic turn is
 * required because a normal text-only `stop` has already returned from the
 * server-side prompt loop.
 */
export const CONTINUE_AFTER_DECLINED_CHALLENGE =
  "The completion check was not confirmed. Continue working now on the specific remaining steps you identified; " +
  `do not stop merely to describe them. When the deliverable is complete and verified, end with ${DONE_TOKEN} ` +
  "alone on the final line."

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

export * as SessionTermination from "./termination"

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
// altimate_change start — run-mode blocked ending
/** Prefix of the final line a run-mode model writes when it cannot proceed. */
export const BLOCKED_PREFIX = "BLOCKED:"
// altimate_change end

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

// altimate_change start — the final-line checks are shared by the DONE and BLOCKED detectors
/** True when the text ends with an explicit completion assertion (see module header). */
export function isExplicitDone(text: string): boolean {
  return finalAssertionLine(text, (last) => last === DONE_TOKEN)
}

/**
 * True when the final plaintext line reports a blocker: `BLOCKED: <reason>`, unindented,
 * outside code fences and HTML blocks, with a non-empty reason. Same placement rules as
 * `isExplicitDone`, so quoted or demonstration text never counts.
 */
export function isBlocked(text: string): boolean {
  return finalAssertionLine(
    text,
    (last) => last.startsWith(BLOCKED_PREFIX) && last.slice(BLOCKED_PREFIX.length).trim().length > 0,
  )
}

/**
 * The text a reader sees: a trailing completion token is a signal to the harness, not
 * part of the answer, so it is removed together with the blank lines before it. Text
 * whose final line is not a completion assertion is returned unchanged.
 */
export function stripCompletionToken(text: string): string {
  if (!isExplicitDone(text)) return text
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n")
  return lines.slice(0, -1).join("\n").trimEnd()
}

function finalAssertionLine(text: string, matches: (last: string) => boolean): boolean {
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
  if (!matches(last)) return false
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
// altimate_change end

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

// altimate_change start — a run-mode BLOCKED: ending is terminal before compaction
/**
 * Stop-path decision for a blocked ending: an errorless "stop" turn whose final real
 * text part ends on a `BLOCKED: <reason>` line. The caller applies it in run mode only,
 * so a blocked report ends the session instead of being compacted and prompted again.
 */
export function blockedStop(input: {
  finish: string | undefined
  hasError: boolean
  parts: readonly { type: string; synthetic?: boolean; text?: string }[]
}): boolean {
  if (input.hasError) return false
  if (input.finish !== "stop") return false
  const lastText = input.parts.findLast((part) => part.type === "text" && part.synthetic !== true)
  if (!lastText?.text) return false
  return isBlocked(lastText.text)
}
// altimate_change end

// altimate_change start — run-mode completion contract for every agent but plan
/**
 * Run-mode completion instruction.
 *
 * This wording lived in `builder.txt`, but builder is a PRIMARY agent, so a
 * static instruction there also governs interactive chat — where nothing
 * interprets or strips the token and the user saw a literal `DONE` on every
 * final answer, including mid-conversation on follow-ups. `isExplicitDone()`
 * is consumed by run-mode accounting and by the processor's explicit-DONE
 * compaction deferral, and the `run` output boundaries strip the token before a
 * reader sees the text.
 *
 * Injected only in run mode. It names the three ways a run-mode turn may end:
 * the token after the assigned task is done, a `BLOCKED:` line when the task
 * cannot proceed, or no ending at all while work remains. Prompt-visible text —
 * changes need extra review.
 */
export const RUN_MODE_COMPLETION_INSTRUCTION =
  "**Signal completion explicitly**: no one can answer questions during this run, so do not end your turn with a " +
  "question. If you are unsure between safe, reversible choices, pick the most reasonable interpretation, state " +
  "your assumption, and continue. Only when the assigned task is fully completed and verified, end your final response with the literal " +
  `token \`${DONE_TOKEN}\` on its own final line. Do not emit \`${DONE_TOKEN}\` while work or verification remains. ` +
  "If you cannot proceed because something you cannot obtain is missing, or the only way forward is a destructive " +
  "or irreversible action on a guess, state what was completed, end with a final line " +
  `\`${BLOCKED_PREFIX} <what blocked you>\`, and stop without \`${DONE_TOKEN}\`.`

/** Agents whose own prompt defines how a turn ends; the contract would contradict it. */
const CONTRACT_EXCLUDED_AGENTS = new Set(["plan"])

/**
 * The sole gate for injecting the completion-token contract into a prompt.
 * In run mode it applies to builder, custom agents and subagents started by the
 * task tool, so each has a defined way to finish or report a blocker. The plan
 * agent is excluded: its prompt ends a turn with a question or `plan_exit`.
 * Interactive sessions never receive it.
 */
export function completionInstruction(input: { runMode: boolean; agent: string }): string | undefined {
  if (!input.runMode || CONTRACT_EXCLUDED_AGENTS.has(input.agent)) return undefined
  return RUN_MODE_COMPLETION_INSTRUCTION
}
// altimate_change end

// altimate_change start — run-mode post-compaction nudge without a clarification option
/**
 * Completion-aware post-compaction nudge, sent only in run mode (interactive
 * compaction keeps its ordinary continuation in compaction.ts). Replaces the
 * "Continue … or stop and ask for clarification" text, which gave a finished
 * session no way to terminate. It offers no "ask for clarification" option:
 * nobody can answer in a headless run, and that option is how runs ended on a
 * question instead of finishing. A blocked run gets its own exit (3), so the
 * model is not pushed into a false `DONE` or a destructive guess. Prompt-visible
 * text — changes need extra review.
 */
export const COMPLETION_NUDGE =
  "Context was compacted; the summary above is the record of the work so far. " +
  "No one can answer questions during this run, so do not end your turn with a question. Choose exactly one: " +
  "(1) if concrete next steps remain toward the original task, continue with them; if you are unsure between " +
  "safe, reversible choices, pick the most reasonable interpretation, state your assumption, and continue; " +
  `(2) if the deliverable is complete and verified, reply with ${DONE_TOKEN} alone on the final line and stop; ` +
  "(3) if you cannot proceed because something you cannot obtain is missing, or the only way forward is a " +
  "destructive or irreversible action on a guess, state what was completed, end with a final line " +
  `${BLOCKED_PREFIX} <what blocked you>, and stop without ${DONE_TOKEN}.`

/**
 * The post-compaction continuation for run mode, or undefined when the ordinary
 * continuation applies: interactive sessions and the plan agent, whose prompt ends a
 * turn with a question or `plan_exit` (same exclusion as the completion contract).
 */
export function completionNudge(input: { runMode: boolean; agent: string }): string | undefined {
  if (!input.runMode || CONTRACT_EXCLUDED_AGENTS.has(input.agent)) return undefined
  return COMPLETION_NUDGE
}
// altimate_change end

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
 * Injected by non-interactive `run` when the turn ended with no assistant text at all —
 * typically after a tool call failed or was auto-rejected (nobody can approve in headless
 * use) and the model stopped instead of answering with what it had. The user otherwise
 * sees nothing and cannot tell whether the model failed, was cut off, or refused (#1334).
 * Naming the failed tool keeps the model from simply retrying it.
 */
export function replyAfterSilentTurn(failure?: { tool: string; error: string }): string {
  // Neither the tool's diagnostic nor its name is repeated here: both come from the tool
  // (an MCP server names its own tools), and this text becomes a user turn. The model
  // already has the failing tool result, with its name, in the conversation; the name is
  // kept for the UI line and the synthesised stdout line, which are not prompts.
  const cause = failure
    ? "after a tool call failed. Do not retry that tool call."
    : "without a reply."
  return (
    `Your previous turn ended ${cause} Answer the user's request now, in text, ` +
    "with what you already have: give the best answer the information supports, and say plainly what was " +
    "attempted and what could not be completed and why."
  )
}

// altimate_change start — prompt for best-effort responses at budget boundaries
/** One continuation at the soft wall-clock deadline, delivered at the next step boundary. */
export const REPLY_BEFORE_TIME_BUDGET =
  "The run is nearing its time budget. Stop exploring and give your best current answer now, " +
  "using the information already obtained. Avoid further tool calls unless strictly needed to answer. " +
  "State the limitations and any work that remains incomplete; do not guess missing values or claim unverified success."

/** One best-effort response after the run has exhausted its work budget. */
export const REPLY_AFTER_BUDGET =
  "The run's work budget has been exhausted. Do not start more work or call tools. " +
  "Reply now with the best answer supported by the information already obtained. " +
  "State the limitations and any work that remains incomplete; do not guess missing values or claim unverified success. " +
  "If there is not enough evidence to answer, say so plainly and summarize the useful progress."
// altimate_change end

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

// altimate_change start — run mode has no user to re-supply anything
/** Run-mode overflow notice: same mechanism text, without asking the absent user. */
export const RUN_MODE_OVERFLOW_NOTICE =
  "The previous request exceeded the model's context limit before a response could be generated. Older " +
  "messages were compacted into the summary above, and oversized content (large tool outputs or file " +
  "attachments) may have been dropped from context. If information you need is missing from the summary, " +
  "re-read the relevant files; no one can re-supply it during this run."

export function overflowNotice(input: { runMode: boolean }): string {
  return input.runMode ? RUN_MODE_OVERFLOW_NOTICE : OVERFLOW_NOTICE
}
// altimate_change end

export * as SessionTermination from "./termination"

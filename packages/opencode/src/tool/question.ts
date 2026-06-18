import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

// altimate_change start — non-interactive handling for the question tool.
//
// Question.ask() resolves via either a TUI click or an HTTP reply at
// POST /question/:requestID/reply. Server commands (serve / web / acp /
// workspace-serve) expose the HTTP path, so an IDE or web client CAN answer
// even though their stdin is not a TTY. Only `altimate-code run` is
// genuinely headless: it uses an in-process Server.Default() shim with no
// bound port, so no client can reach the reply route and Question.ask()
// awaits forever.
//
// Detection is therefore opt-in via env var rather than TTY-based:
// `run` sets ALTIMATE_NON_INTERACTIVE=1 on startup; every other entrypoint
// defaults to interactive. Earlier revisions used !process.stdin.isTTY,
// which misclassified server mode and silently disabled the HTTP reply path
// for IDE users (see PR #937 review).
//
// Policy when non-interactive: return Unanswered for every question and let
// the calling agent decide. The agent knows what it was about to do and
// why it asked; it can pick a safe path from context or report that input
// is required. We deliberately do NOT guess based on label text — every
// heuristic we tried (safe-keyword scan, last-option fallback) either
// invented decisions the user didn't make or false-positive'd on labels
// like "Snowflake" that happened to contain "no".
//
// Explicit overrides (for users who genuinely want a default and accept
// the responsibility):
//   ALTIMATE_AUTO_ANSWER=first         — always pick the first option
//   ALTIMATE_AUTO_ANSWER=last          — always pick the last option
//   ALTIMATE_AUTO_ANSWER="<label>"     — pick the option whose label matches
//
// Mode overrides:
//   ALTIMATE_FORCE_INTERACTIVE=1       — keep Question.ask() (e.g. tests)
//   ALTIMATE_NON_INTERACTIVE=1         — set by `run`; opt-in elsewhere

function isNonInteractive(): boolean {
  if (process.env["ALTIMATE_FORCE_INTERACTIVE"] === "1") return false
  return process.env["ALTIMATE_NON_INTERACTIVE"] === "1"
}

function autoAnswer(questions: Question.Info[]): Question.Answer[] {
  const mode = process.env["ALTIMATE_AUTO_ANSWER"]?.toLowerCase()
  return questions.map((q) => {
    if (!mode) return [] // default — Unanswered, agent decides
    if (mode === "first") return q.options[0] ? [q.options[0].label] : []
    if (mode === "last") {
      const last = q.options[q.options.length - 1]
      return last ? [last.label] : []
    }
    const match = q.options.find((o) => o.label.toLowerCase() === mode)
    return match ? [match.label] : []
  })
}
// altimate_change end

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    // altimate_change start — short-circuit when no human is listening.
    // Cache the mode once: env vars can change across the `await` below, and
    // we want the result prefix to describe the path the answer actually
    // came from, not whatever state we observe later.
    const nonInteractive = isNonInteractive()
    let answers: Question.Answer[]
    if (nonInteractive) {
      answers = autoAnswer(params.questions)
    } else {
      answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: params.questions,
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })
    }
    // altimate_change end

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    // altimate_change start — split the whole message per mode. The original
    // trailer "continue with the user's answers in mind" contradicts the
    // non-interactive branch which tells the agent no user was available.
    const output = nonInteractive
      ? `Running in non-interactive mode (no answer channel available). No user was available to answer. Either pick a safe path from the context of the action you were about to take, or report that user input is required to proceed — the user can set ALTIMATE_AUTO_ANSWER=first|last|<exact option label> to pre-answer questions in this mode. Result: ${formatted}.`
      : `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
    // altimate_change end

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output,
      metadata: {
        answers,
      },
    }
  },
})

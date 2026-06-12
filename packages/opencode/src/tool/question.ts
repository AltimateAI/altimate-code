import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

// altimate_change start — non-interactive handling for the question tool.
//
// When running under `claude --print`, CI, or any other context without a TTY,
// there is nobody to click an option in the TUI. The upstream Question.ask()
// awaits a Deferred indefinitely, which looks exactly like a hang to a parent
// supervisor.
//
// Policy: when non-interactive, return Unanswered for every question and let
// the calling agent decide what to do. The agent knows what it was about to
// do and why it asked; it can pick a safe path from context or report that
// user input is required. We deliberately do NOT guess based on label text
// — every heuristic we tried (safe-keyword scan, last-option fallback)
// either invented decisions the user didn't make or false-positive'd on
// labels like "Snowflake" that happened to contain "no".
//
// Explicit overrides (for users who genuinely want a default and accept the
// responsibility):
//   ALTIMATE_AUTO_ANSWER=first         — always pick the first option
//   ALTIMATE_AUTO_ANSWER=last          — always pick the last option
//   ALTIMATE_AUTO_ANSWER="<label>"     — pick the option whose label matches
//
// TTY-detection overrides (for harnesses that lie about being a TTY):
//   ALTIMATE_FORCE_INTERACTIVE=1       — treat as interactive even without TTY
//   ALTIMATE_NON_INTERACTIVE=1         — treat as non-interactive even with TTY

function isNonInteractive(): boolean {
  if (process.env["ALTIMATE_FORCE_INTERACTIVE"] === "1") return false
  if (process.env["ALTIMATE_NON_INTERACTIVE"] === "1") return true
  return !process.stdin.isTTY
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

    // altimate_change start — make the non-interactive case unambiguous to
    // the agent so it doesn't treat "Unanswered" as a real user choice.
    const prefix = nonInteractive
      ? `Running in non-interactive mode (no TTY). No user was available to answer. Either pick a safe path from the context of the action you were about to take, or report that user input is required to proceed — the user can set ALTIMATE_AUTO_ANSWER=first|last|<exact option label> to pre-answer questions in this mode. Result: `
      : `User has answered your questions: `
    // altimate_change end

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `${prefix}${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
      },
    }
  },
})

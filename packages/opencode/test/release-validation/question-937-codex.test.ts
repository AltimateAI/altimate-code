import { describe, test, expect } from "bun:test"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_question-937"),
  messageID: MessageID.make("msg_question-937"),
  callID: "call_question-937",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const option = (label: string, description = `${label} description`) => ({ label, description })

const colorQuestion = {
  question: "Pick a color",
  header: "Color",
  options: [option("Red"), option("Blue"), option("Green")],
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = ["ALTIMATE_FORCE_INTERACTIVE", "ALTIMATE_NON_INTERACTIVE", "ALTIMATE_AUTO_ANSWER"]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))

  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return await fn()
  } finally {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withQuestionAsk<T>(
  implementation: typeof QuestionModule.Question.ask,
  fn: () => Promise<T>,
): Promise<T> {
  const original = QuestionModule.Question.ask
  ;(QuestionModule.Question as any).ask = implementation
  try {
    return await fn()
  } finally {
    ;(QuestionModule.Question as any).ask = original
  }
}

describe("release validation PR #937 question tool output contract", () => {
  test("interactive path preserves exact answered output, plural title, and metadata answers", async () => {
    let calls = 0
    await withEnv({}, async () => {
      await withQuestionAsk(async () => {
        calls++
        return [["Approve"], ["Read", "Write"]]
      }, async () => {
        const tool = await QuestionTool.init()
        const result = await tool.execute(
          {
            questions: [
              {
                question: "May I proceed?",
                header: "Proceed",
                options: [option("Approve"), option("Cancel")],
              },
              {
                question: "Which scopes?",
                header: "Scopes",
                options: [option("Read"), option("Write")],
                multiple: true,
              },
            ],
          },
          ctx,
        )

        expect(calls).toBe(1)
        expect(result.title).toBe("Asked 2 questions")
        expect(result.metadata.answers).toEqual([["Approve"], ["Read", "Write"]])
        expect(result.output).toBe(
          'User has answered your questions: "May I proceed?"="Approve", "Which scopes?"="Read, Write". You can now continue with the user\'s answers in mind.',
        )
      })
    })
  })

  test("interactive formatting marks missing or empty answer slots as Unanswered", async () => {
    await withEnv({}, async () => {
      await withQuestionAsk(async () => [[]], async () => {
        const tool = await QuestionTool.init()
        const result = await tool.execute(
          {
            questions: [
              {
                question: "First question",
                header: "First",
                options: [option("A")],
              },
              {
                question: "Second question",
                header: "Second",
                options: [option("B")],
              },
            ],
          },
          ctx,
        )

        expect(result.output).toContain('"First question"="Unanswered"')
        expect(result.output).toContain('"Second question"="Unanswered"')
      })
    })
  })

  test("non-interactive default returns empty metadata answers and never calls Question.ask", async () => {
    let calls = 0
    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1" }, async () => {
      await withQuestionAsk(async () => {
        calls++
        return [["SHOULD_NOT_BE_USED"]]
      }, async () => {
        const tool = await QuestionTool.init()
        const result = await tool.execute({ questions: [colorQuestion] }, ctx)

        expect(calls).toBe(0)
        expect(result.metadata.answers).toEqual([[]])
        expect(result.output.startsWith("Running in non-interactive mode")).toBe(true)
        expect(result.output).toContain("No user was available to answer")
        expect(result.output).toContain("ALTIMATE_AUTO_ANSWER=first|last|<exact option label>")
        expect(result.output).toContain('Result: "Pick a color"="Unanswered".')
        expect(result.output).not.toContain("User has answered your questions")
        expect(result.output).not.toContain("continue with the user's answers in mind")
      })
    })
  })

  test("only literal ALTIMATE_NON_INTERACTIVE=1 short-circuits; other values stay interactive", async () => {
    for (const value of ["", "0", "true", "yes", " 1 "]) {
      let calls = 0
      await withEnv({ ALTIMATE_NON_INTERACTIVE: value }, async () => {
        await withQuestionAsk(async () => {
          calls++
          return [["Red"]]
        }, async () => {
          const tool = await QuestionTool.init()
          const result = await tool.execute({ questions: [colorQuestion] }, ctx)

          expect(calls).toBe(1)
          expect(result.metadata.answers).toEqual([["Red"]])
          expect(result.output.startsWith("User has answered your questions")).toBe(true)
        })
      })
    }
  })

  test("only literal ALTIMATE_FORCE_INTERACTIVE=1 overrides non-interactive mode", async () => {
    for (const value of ["", "0", "true", "yes", " 1 "]) {
      let calls = 0
      await withEnv({ ALTIMATE_FORCE_INTERACTIVE: value, ALTIMATE_NON_INTERACTIVE: "1" }, async () => {
        await withQuestionAsk(async () => {
          calls++
          return [["Red"]]
        }, async () => {
          const tool = await QuestionTool.init()
          const result = await tool.execute({ questions: [colorQuestion] }, ctx)

          expect(calls).toBe(0)
          expect(result.metadata.answers).toEqual([[]])
          expect(result.output).toContain('"Pick a color"="Unanswered"')
        })
      })
    }

    let calls = 0
    await withEnv({ ALTIMATE_FORCE_INTERACTIVE: "1", ALTIMATE_NON_INTERACTIVE: "1" }, async () => {
      await withQuestionAsk(async () => {
        calls++
        return [["Green"]]
      }, async () => {
        const tool = await QuestionTool.init()
        const result = await tool.execute({ questions: [colorQuestion] }, ctx)

        expect(calls).toBe(1)
        expect(result.metadata.answers).toEqual([["Green"]])
        expect(result.output.startsWith("User has answered your questions")).toBe(true)
      })
    })
  })

  test("ALTIMATE_AUTO_ANSWER label matching is case-insensitive and per question", async () => {
    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_AUTO_ANSWER: "sHiP iT" }, async () => {
      const tool = await QuestionTool.init()
      const result = await tool.execute(
        {
          questions: [
            {
              question: "Deploy now?",
              header: "Deploy",
              options: [option("Hold"), option("Ship It")],
            },
            {
              question: "Notify channel?",
              header: "Notify",
              options: [option("Skip"), option("Ship It")],
            },
          ],
        },
        ctx,
      )

      expect(result.metadata.answers).toEqual([["Ship It"], ["Ship It"]])
      expect(result.output).toContain('"Deploy now?"="Ship It"')
      expect(result.output).toContain('"Notify channel?"="Ship It"')
    })
  })

  test("ALTIMATE_AUTO_ANSWER first and last are reserved modes, not label lookups", async () => {
    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_AUTO_ANSWER: "first" }, async () => {
      const tool = await QuestionTool.init()
      const result = await tool.execute(
        {
          questions: [
            {
              question: "Reserved first",
              header: "Reserved",
              options: [option("Alpha"), option("first")],
            },
          ],
        },
        ctx,
      )

      expect(result.metadata.answers).toEqual([["Alpha"]])
      expect(result.output).toContain('"Reserved first"="Alpha"')
    })

    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_AUTO_ANSWER: "last" }, async () => {
      const tool = await QuestionTool.init()
      const result = await tool.execute(
        {
          questions: [
            {
              question: "Reserved last",
              header: "Reserved",
              options: [option("last"), option("Omega")],
            },
          ],
        },
        ctx,
      )

      expect(result.metadata.answers).toEqual([["Omega"]])
      expect(result.output).toContain('"Reserved last"="Omega"')
    })
  })

  test("ALTIMATE_AUTO_ANSWER first and last safely leave empty-option questions unanswered", async () => {
    for (const mode of ["first", "last"]) {
      await withEnv({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_AUTO_ANSWER: mode }, async () => {
        const tool = await QuestionTool.init()
        const result = await tool.execute(
          {
            questions: [
              {
                question: `Empty options ${mode}`,
                header: "Empty",
                options: [],
              },
            ],
          },
          ctx,
        )

        expect(result.metadata.answers).toEqual([[]])
        expect(result.output).toContain(`"Empty options ${mode}"="Unanswered"`)
      })
    }
  })

  test("unmatched or whitespace-padded auto-answer labels do not leak env values or option descriptions", async () => {
    const secret = "sk-live-1234567890"
    const sql = "select * from finance.payroll_credentials"

    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_AUTO_ANSWER: ` ${secret} ` }, async () => {
      const tool = await QuestionTool.init()
      const result = await tool.execute(
        {
          questions: [
            {
              question: "Which safe action?",
              header: "Safe",
              options: [
                option("Profile only", `Do not print ${sql}`),
                option("Abort", `Do not print ${secret}`),
              ],
            },
          ],
        },
        ctx,
      )

      expect(result.metadata.answers).toEqual([[]])
      expect(result.output).toContain('"Which safe action?"="Unanswered"')
      expect(result.output).not.toContain(secret)
      expect(result.output).not.toContain(sql)
      expect(result.output).not.toContain("payroll_credentials")
    })
  })

  test("non-interactive zero-question call is bounded and reports an empty result", async () => {
    await withEnv({ ALTIMATE_NON_INTERACTIVE: "1" }, async () => {
      const tool = await QuestionTool.init()
      const result = await tool.execute({ questions: [] }, ctx)

      expect(result.title).toBe("Asked 0 question")
      expect(result.metadata.answers).toEqual([])
      expect(result.output).toContain("Result: .")
    })
  })
})

describe("release validation PR #937 source-level env plumbing", () => {
  test("run command auto-sets ALTIMATE_NON_INTERACTIVE for local run when unset or blank", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/run.ts", import.meta.url)).text()

    // v0.8.8: guard treats a blank/whitespace value as unset (.trim()) so a stray
    // `export ALTIMATE_NON_INTERACTIVE=` does not silently reintroduce the run hang.
    expect(source).toContain('if (!args.attach && !process.env["ALTIMATE_NON_INTERACTIVE"]?.trim()) {')
    expect(source).toContain('process.env["ALTIMATE_NON_INTERACTIVE"] = "1"')
    expect(source).toContain("Users can opt out by exporting ALTIMATE_NON_INTERACTIVE=0")
    // The old strict `=== undefined` guard (blank value footgun) must be gone.
    expect(source).not.toContain('process.env["ALTIMATE_NON_INTERACTIVE"] === undefined')
  })

  test("run command guards Bun.stdin.text() behind an existing non-TTY stdin", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/run.ts", import.meta.url)).text()

    expect(source).toContain("if (process.stdin && !process.stdin.isTTY) message +=")
    expect(source).not.toContain("if (!process.stdin?.isTTY)")
  })

  test("bash tool strips ALTIMATE_NON_INTERACTIVE from child process env but keeps auto-answer env untouched", async () => {
    const source = await Bun.file(new URL("../../src/tool/bash.ts", import.meta.url)).text()

    expect(source).toContain('const mergedEnv: Record<string, string | undefined> = { ...process.env, ...shellEnv.env }')
    expect(source).toContain('delete mergedEnv["ALTIMATE_NON_INTERACTIVE"]')
    expect(source).not.toContain('delete mergedEnv["ALTIMATE_AUTO_ANSWER"]')
    expect(source).toContain("env: mergedEnv")
  })
})

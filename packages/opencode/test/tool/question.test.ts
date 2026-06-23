import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    // Defensive: detection is opt-in via ALTIMATE_NON_INTERACTIVE, so the
    // default in `bun:test` is already interactive. Setting
    // ALTIMATE_FORCE_INTERACTIVE=1 protects against env pollution if a
    // parent shell or earlier test leaked ALTIMATE_NON_INTERACTIVE=1.
    process.env["ALTIMATE_FORCE_INTERACTIVE"] = "1"
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})

describe("tool.question non-interactive auto-answer", () => {
  let askSpy: any

  beforeEach(() => {
    // Defensive: clear FORCE_INTERACTIVE so a parent-shell export can't
    // silently flip this suite to the interactive path and lose coverage.
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => [])
  })

  afterEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy.mockRestore()
  })

  test("default returns Unanswered for every question and does not invoke Question.ask", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "May I run row-level hashdiff comparisons?",
        header: "PII consent",
        options: [
          { label: "Approve row diff", description: "Sample rows may appear" },
          { label: "Profile only", description: "Safer; no row content surfaced" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    expect(result.output).toContain('"May I run row-level hashdiff comparisons?"="Unanswered"')
    // The non-interactive prefix tells the agent to pick a safe path from context
    // AND tells the agent about the escape hatch so it can surface it to the user
    // when reporting that input is required.
    expect(result.output).toContain("non-interactive mode")
    expect(result.output).toContain("safe path")
    expect(result.output).toContain("ALTIMATE_AUTO_ANSWER")
  })

  test("does not invent answers based on label text (no label-text heuristic)", async () => {
    // Regression: a prior implementation scanned labels for substrings like
    // "skip" / "cancel" / "no". That false-positived on labels like
    // "Snowflake" (contains "no") and quietly picked the wrong option. The
    // default now returns Unanswered — the agent decides.
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a warehouse",
        header: "Warehouse",
        options: [
          { label: "Snowflake", description: "Continue with Snowflake" },
          { label: "Cancel", description: "Stop here" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain('"Pick a warehouse"="Unanswered"')
    expect(result.output).not.toContain('"Snowflake"')
    expect(result.output).not.toContain('"Cancel"')
  })

  test("ALTIMATE_AUTO_ANSWER=first picks first option (explicit opt-in)", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "first"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain('"Pick a color"="Red"')
  })

  test("ALTIMATE_AUTO_ANSWER=last picks last option (explicit opt-in)", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "last"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain('"Pick a color"="Blue"')
  })

  test("ALTIMATE_AUTO_ANSWER=<exact label> picks matching option", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "blue"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain('"Pick a color"="Blue"')
  })

  test("ALTIMATE_AUTO_ANSWER=<unknown label> falls through to Unanswered", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "green"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain('"Pick a color"="Unanswered"')
  })

  test("non-interactive prefix is set when Question.ask is bypassed", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "OK to proceed?",
        header: "Proceed",
        options: [{ label: "Cancel", description: "Stop" }],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output.startsWith("Running in non-interactive mode")).toBe(true)
  })

  test("non-interactive output does not contradict itself", async () => {
    // Regression: the trailing literal "continue with the user's answers in
    // mind" used to be appended unconditionally, contradicting the
    // non-interactive prefix that says no user answered. See PR #937 review.
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "OK to proceed?",
        header: "Proceed",
        options: [{ label: "Cancel", description: "Stop" }],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).not.toContain("continue with the user's answers in mind")
  })
})

describe("tool.question default detection (no env vars)", () => {
  let askSpy: any

  beforeEach(() => {
    // Default detection must NOT short-circuit when no env vars are set.
    // Regression: an earlier revision used !process.stdin.isTTY, which
    // misclassified `serve`/`web`/`acp`/`workspace-serve` (all non-TTY but
    // with HTTP /question/:requestID/reply) as non-interactive and silently
    // disabled the IDE reply path. See PR #937 review (suryaiyer95).
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => [["Red"]])
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("calls Question.ask by default — does not short-circuit on missing TTY", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.output.startsWith("User has answered your questions")).toBe(true)
  })

  test("ALTIMATE_NON_INTERACTIVE=0 honored as explicit opt-out", async () => {
    // run.ts auto-sets this env var only when undefined, so a user-set "0"
    // is preserved. isNonInteractive() matches strict "=== '1'", so "0"
    // falls through to the interactive path. PR #937 comment promises this
    // works; lock the contract.
    process.env["ALTIMATE_NON_INTERACTIVE"] = "0"

    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.output.startsWith("User has answered your questions")).toBe(true)
  })

  test("ALTIMATE_FORCE_INTERACTIVE=1 overrides ALTIMATE_NON_INTERACTIVE=1", async () => {
    // FORCE_INTERACTIVE is checked first in isNonInteractive() so it wins
    // even when NON_INTERACTIVE is also set. Used by tests to keep the
    // interactive path live regardless of parent-shell env pollution.
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
    process.env["ALTIMATE_FORCE_INTERACTIVE"] = "1"

    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.output.startsWith("User has answered your questions")).toBe(true)
  })
})

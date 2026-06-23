// Regression tests for PR #937 — auto-resolve question tool in non-interactive contexts.
//
// Touched source:
//   packages/opencode/src/tool/question.ts   (isNonInteractive / autoAnswer + mode-aware output)
//   packages/opencode/src/tool/bash.ts        (strip ALTIMATE_NON_INTERACTIVE from child env)
//   packages/opencode/src/cli/cmd/run.ts       (set ALTIMATE_NON_INTERACTIVE; null-safe stdin read)
//
// Style/imports follow packages/opencode/test/tool/question.test.ts and
// packages/opencode/test/tool/bash.test.ts.

import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
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

// ---------------------------------------------------------------------------
// Gap #1 — empty-string ALTIMATE_NON_INTERACTIVE behaves interactive.
//
// isNonInteractive() returns `process.env["ALTIMATE_NON_INTERACTIVE"] === "1"`,
// so "" is NOT non-interactive: the tool falls through to Question.ask.
// This locks the documented contract (strict "=== '1'") so an empty string —
// e.g. `export ALTIMATE_NON_INTERACTIVE=` — does not accidentally flip modes.
// ---------------------------------------------------------------------------
describe("tool.question default detection — empty-string ALTIMATE_NON_INTERACTIVE", () => {
  let askSpy: any

  beforeEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => [["Red"]])
  })

  afterEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy.mockRestore()
  })

  test('empty-string ALTIMATE_NON_INTERACTIVE ("") is treated as interactive', async () => {
    // The contract is strict equality to "1". Empty string is the footgun case:
    // it is set-but-falsy. Assert the desired behavior — interactive path.
    process.env["ALTIMATE_NON_INTERACTIVE"] = ""

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

// ---------------------------------------------------------------------------
// Gaps #2–#6 — non-interactive autoAnswer behavior.
// ---------------------------------------------------------------------------
describe("tool.question non-interactive autoAnswer mapping", () => {
  let askSpy: any

  beforeEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
    // Question.ask must NOT be reached on any of these paths; if it is, the
    // mock returns a sentinel that would fail the output assertions loudly.
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => [["SHOULD_NOT_BE_CALLED"]])
  })

  afterEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy.mockRestore()
  })

  // Gap #2 — multiple questions map answers positionally (mode=first).
  test("ALTIMATE_AUTO_ANSWER=first maps each question to its OWN first option", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "first"
    const tool = await QuestionTool.init()
    const questions = [
      { question: "Q1", header: "Q1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      { question: "Q2", header: "Q2", options: [{ label: "C", description: "" }, { label: "D", description: "" }] },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    expect(result.output).toContain('="A"')
    expect(result.output).toContain('="C"')
    // Cross-contamination guard: Q1 must not receive Q2's option and vice versa.
    expect(result.output).toContain('"Q1"="A"')
    expect(result.output).toContain('"Q2"="C"')
  })

  // Gap #2 — multiple questions, default (no AUTO_ANSWER) → every entry Unanswered.
  test("no ALTIMATE_AUTO_ANSWER returns Unanswered for every question independently", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      { question: "Q1", header: "Q1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      { question: "Q2", header: "Q2", options: [{ label: "C", description: "" }, { label: "D", description: "" }] },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    expect(result.output).toContain('"Q1"="Unanswered"')
    expect(result.output).toContain('"Q2"="Unanswered"')
  })

  // Gap #3 — label match is case-insensitive but emits the option's original casing.
  test("ALTIMATE_AUTO_ANSWER label match is case-insensitive; emits original casing", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "snowflake"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a warehouse",
        header: "Warehouse",
        options: [
          { label: "Snowflake", description: "" },
          { label: "BigQuery", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    // Original casing 'Snowflake' (capital S) is emitted, not the env value 'snowflake'.
    expect(result.output).toContain('="Snowflake"')
    expect(result.output).not.toContain('="snowflake"')
  })

  // Gap #4 — reserved keyword 'first' wins over a literal label named 'First'.
  test("ALTIMATE_AUTO_ANSWER=first is positional even when an option is labeled 'First'", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "first"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick",
        header: "Pick",
        options: [
          { label: "Zebra", description: "" },
          { label: "First", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    // The keyword 'first' is checked before any label match, so it picks
    // options[0] ("Zebra") positionally — NOT the option literally labeled "First".
    expect(result.output).toContain('="Zebra"')
    expect(result.output).not.toContain('="First"')
  })

  // Gap #5 — empty options array never crashes for any mode.
  for (const mode of [undefined, "first", "last", "red"] as const) {
    test(`empty options array yields Unanswered without throwing (AUTO_ANSWER=${mode ?? "unset"})`, async () => {
      if (mode === undefined) delete process.env["ALTIMATE_AUTO_ANSWER"]
      else process.env["ALTIMATE_AUTO_ANSWER"] = mode

      const tool = await QuestionTool.init()
      const questions = [{ question: "Empty?", header: "Empty", options: [] as { label: string; description: string }[] }]

      const result = await tool.execute({ questions }, ctx)
      expect(askSpy).not.toHaveBeenCalled()
      expect(result.output).toContain('"Empty?"="Unanswered"')
    })
  }

  // Gap #6 — multiple:true still yields a single selected label under auto-answer.
  test("multiple:true question yields a single label under ALTIMATE_AUTO_ANSWER=last", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "last"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick many",
        header: "Many",
        multiple: true,
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    // last mode returns a one-element array (["B"]) even though multiple is allowed.
    expect(result.output).toContain('="B"')
    // The metadata answer is a single-element array, not all options.
    expect(result.metadata.answers).toEqual([["B"]])
  })
})

// ---------------------------------------------------------------------------
// Gap #7 — bash tool strips ALTIMATE_NON_INTERACTIVE from child env.
// Mirrors packages/opencode/test/tool/bash.test.ts (Instance.provide + execute).
// ---------------------------------------------------------------------------
describe("tool.bash strips ALTIMATE_NON_INTERACTIVE from child env", () => {
  let prev: string | undefined

  beforeEach(() => {
    prev = process.env["ALTIMATE_NON_INTERACTIVE"]
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
  })

  afterEach(() => {
    if (prev === undefined) delete process.env["ALTIMATE_NON_INTERACTIVE"]
    else process.env["ALTIMATE_NON_INTERACTIVE"] = prev
  })

  test("child process does not inherit ALTIMATE_NON_INTERACTIVE", async () => {
    const projectRoot = require("path").join(__dirname, "../..")
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        // printenv exits non-zero when the var is unset, so `|| echo MISSING`
        // proves the delete reached spawn's env.
        const result = await bash.execute(
          {
            command: "printenv ALTIMATE_NON_INTERACTIVE || echo MISSING",
            description: "Echo non-interactive env var from child",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        const out = result.metadata.output.trim()
        expect(out).toBe("MISSING")
        // Parent process env is untouched — only the child's merged env was stripped.
        expect(process.env["ALTIMATE_NON_INTERACTIVE"]).toBe("1")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Gap #8 — run command sets ALTIMATE_NON_INTERACTIVE only when undefined and
// not --attach.
//
// The guard is inline in src/cli/cmd/run.ts:390 and not exported:
//   if (!args.attach && process.env["ALTIMATE_NON_INTERACTIVE"] === undefined) {
//     process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
//   }
// We cannot modify source to export it, so this helper mirrors the exact
// predicate (the load-bearing `!attach && current === undefined` contract that
// finding #1 hinges on) and the matrix is asserted directly against the guard.
// ---------------------------------------------------------------------------
describe("run.ts ALTIMATE_NON_INTERACTIVE guard contract", () => {
  // Mirrors src/cli/cmd/run.ts handler guard. Returns true iff the handler
  // would assign "1" to the env var.
  function shouldSetNonInteractive(attach: boolean, current: string | undefined): boolean {
    return !attach && current === undefined
  }

  test("attach=false, undefined -> sets the flag", () => {
    expect(shouldSetNonInteractive(false, undefined)).toBe(true)
  })

  test("attach=false, '0' -> preserves (does not overwrite)", () => {
    expect(shouldSetNonInteractive(false, "0")).toBe(false)
  })

  test("attach=false, '1' -> preserves (does not overwrite)", () => {
    expect(shouldSetNonInteractive(false, "1")).toBe(false)
  })

  test("attach=true, undefined -> skip (remote agent)", () => {
    expect(shouldSetNonInteractive(true, undefined)).toBe(false)
  })

  test("attach=true, '0' -> skip", () => {
    expect(shouldSetNonInteractive(true, "0")).toBe(false)
  })

  test("attach=true, '1' -> skip", () => {
    expect(shouldSetNonInteractive(true, "1")).toBe(false)
  })

  // The end-to-end consequence: a value the guard sets ("1") is what
  // isNonInteractive() consumes; a preserved "0" is interactive.
  test("guard output feeds the strict '=== \"1\"' isNonInteractive contract", () => {
    const set = shouldSetNonInteractive(false, undefined) ? "1" : undefined
    expect(set === "1").toBe(true)
    // a preserved "0" never becomes "1", so the interactive path is honored
    const preserved = shouldSetNonInteractive(false, "0") ? "1" : "0"
    expect(preserved).toBe("0")
  })
})

// ---------------------------------------------------------------------------
// Gap #9 — null-safe stdin read does not stall when process.stdin is undefined.
//
// The guard is inline in src/cli/cmd/run.ts:463 and not exported:
//   if (process.stdin && !process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())
// Helper mirrors that predicate and the append behavior so the regression
// (undefined stdin satisfied `!stdin?.isTTY` and stalled awaiting EOF) is
// locked: undefined stdin must NOT trigger the read.
// ---------------------------------------------------------------------------
describe("run.ts null-safe stdin read", () => {
  // Mirrors the run.ts stdin-append guard. readFn stands in for Bun.stdin.text().
  async function appendStdin(
    message: string,
    stdin: { isTTY?: boolean } | undefined,
    readFn: () => Promise<string>,
  ): Promise<{ message: string; read: boolean }> {
    let read = false
    if (stdin && !stdin.isTTY) {
      read = true
      message += "\n" + (await readFn())
    }
    return { message, read }
  }

  test("stdin=undefined -> readFn NOT called, message unchanged (no stall)", async () => {
    let called = false
    const readFn = async () => {
      called = true
      return "PIPED"
    }
    const { message, read } = await appendStdin("hello", undefined, readFn)
    expect(called).toBe(false)
    expect(read).toBe(false)
    expect(message).toBe("hello")
  })

  test("stdin={isTTY:false} -> readFn awaited and appended", async () => {
    const readFn = async () => "PIPED"
    const { message, read } = await appendStdin("hello", { isTTY: false }, readFn)
    expect(read).toBe(true)
    expect(message).toBe("hello\nPIPED")
  })

  test("stdin={isTTY:true} -> readFn NOT called (interactive terminal)", async () => {
    let called = false
    const readFn = async () => {
      called = true
      return "PIPED"
    }
    const { message, read } = await appendStdin("hello", { isTTY: true }, readFn)
    expect(called).toBe(false)
    expect(read).toBe(false)
    expect(message).toBe("hello")
  })
})

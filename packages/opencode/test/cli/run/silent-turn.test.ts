// Regression for #1334: a non-interactive `run` whose turn ends with no assistant text.
//
// In headless use nobody can approve a permission, so a scripted `bash` call is
// auto-rejected; the model then "stops" with an empty reply. Before, the process printed
// nothing and exited 0. Now `run` asks for a reply once, naming the failed tool; if the
// model still says nothing, it prints a synthesised line and exits 1.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode run: a turn must end with text (#1334)", () => {
  cliIt.concurrent(
    "an auto-rejected tool call followed by an empty reply gets one follow-up turn, and its answer is printed",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "altimate-dbt info" }) // auto-rejected: no approver
        yield* llm.text("") // the model stops without saying anything
        yield* llm.text("I could not run altimate-dbt (permission was denied), but from the files read: fix orders.sql first.")
        const result = yield* opencode.run("which model should I fix first?", { timeoutMs: 60_000, bunRun: true })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("fix orders.sql first")
        expect(result.stdout).not.toContain("No answer was produced")
      }),
    90_000,
  )

  cliIt.concurrent(
    "when the model stays silent even after being asked, a synthesised line is printed and the exit code is 1",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "git status --short" })
        yield* llm.text("")
        yield* llm.text("")
        const result = yield* opencode.run("what changed?", { timeoutMs: 60_000, bunRun: true })
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain("No answer was produced")
        expect(result.stdout).toContain("`bash` failed")
        // The tool's diagnostic is not repeated in the synthesised line (it goes to
        // `--output`, which is the answer, not a place for raw tool output).
        expect(result.stdout).not.toMatch(/No answer was produced.*\(/)
      }),
    90_000,
  )

  cliIt.concurrent(
    "text streamed BEFORE the failing call is not the answer: the follow-up still fires",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        // "Let me check…" then the call fails and the model stops. The user saw a
        // preamble, not an answer — the same silent end one step later. (bot review)
        yield* llm.textTool("Let me check the project first.", "bash", { command: "altimate-dbt info" })
        yield* llm.text("")
        yield* llm.text("altimate-dbt could not run (permission denied); from the files alone: start with orders.sql.")
        const result = yield* opencode.run("which model should I fix first?", { timeoutMs: 60_000, bunRun: true })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("start with orders.sql")
      }),
    90_000,
  )

  cliIt.concurrent(
    "a tool that SUCCEEDS and a model that then stops is a silent end too (codex on #1345)",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        // yolo lets the glob run; the model streams a preamble, the call works, and
        // the next generation is empty. Answered means the LAST step had text.
        yield* llm.textTool("Let me list the models.", "glob", { pattern: "**/*.sql" })
        yield* llm.text("")
        yield* llm.text("There are no SQL models here; nothing to fix.")
        const result = yield* opencode.run("which model should I fix first?", {
          timeoutMs: 60_000,
          bunRun: true,
          env: { ALTIMATE_CLI_YOLO: "true" },
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("nothing to fix")
      }),
    90_000,
  )

  cliIt.concurrent(
    "a turn that answers normally is untouched: no follow-up prompt is sent",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("plain answer")
        yield* llm.text("SHOULD NOT BE REQUESTED")
        const result = yield* opencode.run("say hi", { timeoutMs: 60_000, bunRun: true })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("plain answer")
        expect(result.stdout).not.toContain("SHOULD NOT BE REQUESTED")
      }),
    90_000,
  )
})

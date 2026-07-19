// Real headless-session driver for trace-golden scenarios. Spins up the
// actual `opencode` CLI as a subprocess (via the fork's own `withCliFixture`
// test harness) against a scripted `TestLLMServer`, drives one prompt to
// completion, and returns the exact TraceFile the session wrote to disk.
//
// This is NOT a stub/fake provider built for this task — it reuses the fork's
// existing deterministic test-CLI harness (packages/opencode/test/lib/
// cli-process.ts + llm-server.ts), which the technique spec explicitly asked
// us to prefer over inventing a new one. See DRIVER-NOTES.md for the
// discovery trail.
import fs from "node:fs/promises"
import { Effect, Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { CliFixture, RunOpts } from "../../lib/cli-process"
import { withCliFixture } from "../../lib/cli-process"
import type { TraceFile } from "@/altimate/observability/tracing"

export { withCliFixture }
export type { CliFixture }

/**
 * One scripted assistant turn: either plain text (session ends) or a tool call (session continues).
 *
 * KNOWN LIMITATION (S7 concurrency, not yet exercised): this schema represents at most ONE tool
 * call per assistant turn, and pushTurn() queues a separate `reply().tool(...)` generation for each
 * turn. Two adjacent `tool` turns therefore become two sequential single-tool generations, NOT one
 * generation that dispatches multiple sibling calls — so the live harness cannot yet produce the
 * concurrent-sibling topology that the partial-order matcher (match.ts) and planned S7 concurrency
 * scenarios are built to protect. The matcher and normalizer are already order-invariant (they were
 * unit-tested against hand-built concurrent traces), but END-TO-END concurrent generation needs a
 * grouped multi-tool turn (e.g. `kind: "tools"` with a `calls[]` array, all queued in one Reply).
 * Add that alongside the first S7 concurrency scenario, not speculatively before one exists.
 */
export interface ScriptedTurn {
  readonly kind: "text" | "tool"
  readonly text?: string
  readonly toolName?: string
  readonly toolInput?: unknown
}

export interface DriveScenarioOptions {
  readonly prompt: string
  readonly script: ScriptedTurn[]
  readonly runOpts?: Omit<RunOpts, "format">
}

export interface DriveScenarioResult {
  readonly trace: TraceFile
  readonly tracePath: string
  readonly exitCode: number
  readonly stderr: string
}

function pushTurn(llm: CliFixture["llm"], turn: ScriptedTurn): Effect.Effect<void> {
  if (turn.kind === "tool") {
    if (!turn.toolName) throw new Error("driveScenario: tool turn missing toolName")
    return llm.tool(turn.toolName, turn.toolInput ?? {})
  }
  return llm.text(turn.text ?? "")
}

/**
 * Runs ONE real headless `opencode run` session inside a CliFixture, scripted
 * turn-by-turn via TestLLMServer, and returns the TraceFile it wrote to disk.
 *
 * Must be called from inside `withCliFixture` (pass its `fixture` argument
 * straight through) — this function doesn't manage the fixture's lifecycle
 * itself, so callers can compose it with other fixture-scoped assertions in
 * the same test.
 *
 * The trace file location is read directly off the `trace_saved` JSON event
 * that `opencode run --format json` emits on exit (see src/cli/cmd/run.ts) —
 * no directory-convention guessing required.
 */
export function driveScenario(
  fixture: CliFixture,
  options: DriveScenarioOptions,
): Effect.Effect<DriveScenarioResult, Error, Scope.Scope | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    for (const turn of options.script) {
      yield* pushTurn(fixture.llm, turn)
    }

    const result = yield* fixture.opencode.run(options.prompt, {
      ...options.runOpts,
      format: "json",
    })

    const events = fixture.opencode.parseJsonEvents(result.stdout)
    const traceSaved = events.find((e) => e.type === "trace_saved")
    if (!traceSaved || typeof traceSaved.path !== "string") {
      return yield* Effect.fail(
        new Error(
          `driveScenario: no trace_saved event in CLI output (exit ${result.exitCode}).\n` +
            `stderr (last 1000): ${result.stderr.slice(-1000)}\n` +
            `stdout (last 1000): ${result.stdout.slice(-1000)}`,
        ),
      )
    }
    const tracePath = traceSaved.path

    const raw = yield* Effect.tryPromise({
      try: () => fs.readFile(tracePath, "utf-8"),
      catch: (cause) => new Error(`driveScenario: failed to read trace file ${tracePath}: ${String(cause)}`),
    })
    const trace = JSON.parse(raw) as TraceFile

    return { trace, tracePath, exitCode: result.exitCode, stderr: result.stderr }
  })
}

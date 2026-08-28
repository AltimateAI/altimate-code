// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OPENCODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"
import fs from "fs/promises"
import os from "os"
import path from "path"

describe("opencode run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  // Regression: `--trace` (tracing is on by default) must produce a session trace
  // artifact. The tracer setup previously read tracing config via the local
  // Config.get() facade, which could not resolve the instance in this CLI path
  // (the instance ALS is duplicated across the module boundary) → "InstanceRef not
  // provided" was swallowed by the fail-safe catch → tracer was null → no file was
  // ever written. Fixed by reading tracing config through the server client
  // (sdk.config.get()). This asserts a trace JSON lands in the configured dir.
  cliIt.concurrent(
    "--trace writes a session trace artifact",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("traced output")
        const traceDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "oc-trace-")))
        const config = JSON.stringify({
          ...testProviderConfig(llm.url),
          tracing: { enabled: true, dir: traceDir, maxFiles: 0 },
        })
        const result = yield* opencode.run("say hi", {
          extraArgs: ["--trace"],
          env: { OPENCODE_CONFIG_CONTENT: config },
        })
        opencode.expectExit(result, 0)
        const files = yield* Effect.promise(() => fs.readdir(traceDir))
        expect(files.filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0)
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // (harness-improvement plan): a run that ends with an unrecovered session
  // error is a fatal abort and must exit nonzero — an honest rc is the contract
  // automation needs. This deliberately flips the previous "exits 0 today"
  // contract lock-in (its comment asked for exactly this kind of deliberate
  // change). Recoverable errors (context overflow handled by auto-compaction)
  // still exit 0; see RunAccounting.onSessionError.
  cliIt.concurrent(
    "mid-stream LLM error exits nonzero (honest rc on fatal abort)",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.fail("upstream provider exploded mid-stream")
        // bunRun: the compiled binary hangs handling a mid-stream stream error in the isolated test env
        // (never exits); `bun run src` exits promptly. See cliCommand in test/lib/cli-process.ts.
        const result = yield* opencode.run("trigger midstream error", { timeoutMs: 30_000, bunRun: true })
        expect(result.exitCode).toBe(1)
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )
})

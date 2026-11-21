import { describe, expect } from "bun:test"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { testProviderConfig } from "../../lib/test-provider"
import { cliIt } from "../../lib/cli-process"

describe("run model resolution", () => {
  for (const source of ["CLI", "project config", "agent config", "empty agent model"] as const) {
    cliIt.live(
      `rejects an unavailable model from ${source}`,
      ({ opencode, home, llm }) =>
        Effect.gen(function* () {
          const requested = source === "empty agent model" ? "" : "missing-provider/missing-model"
          const agentModel = source === "agent config" || source === "empty agent model"
          const config = agentModel ? { agent: { build: { model: requested } } } : { model: requested }
          if (source !== "CLI") {
            yield* Effect.promise(() => Bun.write(path.join(home, "altimate-code.json"), JSON.stringify(config)))
          }
          const args = [
            "run",
            ...(source === "CLI" ? ["--model", requested] : []),
            ...(agentModel ? ["--agent", "build"] : []),
            "Do not send this prompt",
          ]
          yield* llm.text("Unexpected fallback response")
          const result = yield* opencode.spawn(args, {
            bunRun: true,
            timeoutMs: 20_000,
            env: {
              OPENCODE_DISABLE_PROJECT_CONFIG: "0",
              OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), enabled_providers: ["test"] }),
            },
          })
          expect(yield* llm.calls).toBe(0)
          expect(result.exitCode).toBe(1)
          const sourceHint = source === "CLI" ? "CLI --model" : agentModel ? 'agent "build" config (model)' : "project or global config (model)"
          expect(result.stderr + result.stdout).toContain(
            requested ? `Model not found: ${requested} (from ${sourceHint})` : `Empty model value (from ${sourceHint})`,
          )
          expect(result.stderr + result.stdout).toContain("at the project root")
        }),
      30_000,
    )
  }

  cliIt.live(
    "lets a standalone command use its own model when the project default is unavailable",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("Command answered on its own model")
        const result = yield* opencode.spawn(["run", "--command", "local", "--model", "unused/model", "test"], {
          bunRun: true,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              enabled_providers: ["test"],
              model: "missing-provider/missing-model",
              command: { local: { model: "test/test-model", template: "Say hello" } },
            }),
          },
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("Command answered on its own model")
      }),
    30_000,
  )

  cliIt.live(
    "rejects an unavailable command model before inference despite a usable CLI model",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--command", "local", "--model", "test/test-model", "test"], {
          bunRun: true,
          timeoutMs: 20_000,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              enabled_providers: ["test"],
              command: { local: { model: "test/missing-model", template: "Say hello" } },
            }),
          },
        })
        opencode.expectExit(result, 1)
        expect(result.stderr + result.stdout).toContain('Model not found: test/missing-model (from command "local" config (model))')
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  cliIt.live(
    "rejects an unavailable parent model when a subtask command needs it",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--command", "local", "--model", "test/missing-model", "test"], {
          bunRun: true,
          timeoutMs: 20_000,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              enabled_providers: ["test"],
              command: { local: { model: "test/test-model", template: "Say hello", subtask: true } },
            }),
          },
        })
        opencode.expectExit(result, 1)
        expect(result.stderr + result.stdout).toContain("Model not found: test/missing-model (from command request (model))")
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  cliIt.live(
    "resumes a usable session model with --session and --continue before considering project config",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({
          bunRun: true,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              enabled_providers: ["test"],
              model: "missing-provider/missing-model",
            }),
          },
        })
        const sdk = createOpencodeClient({ baseUrl: server.url, throwOnError: true })
        const { data } = yield* Effect.promise(() => sdk.session.create({ title: "Resumed model" }))
        if (!data) throw new Error("Session creation returned no data")
        const sessionID = data.id
        yield* Effect.promise(() => sdk.session.prompt({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          noReply: true,
          parts: [{ type: "text", text: "Seed the session model" }],
        }))
        yield* Effect.promise(() => sdk.session.shell({
          sessionID,
          agent: "build",
          model: { providerID: "unused", modelID: "shell-metadata" },
          command: "echo shell-ok",
        }))
        for (const resume of [["--session", sessionID], ["--continue"]]) {
          yield* llm.text("Resumed on the session model")
          const result = yield* opencode.spawn(["run", "--attach", server.url, "--no-trace", ...resume, "test"], {
            bunRun: true,
          })
          opencode.expectExit(result, 0)
          expect(result.stdout).toContain("Resumed on the session model")
        }
        expect(yield* llm.calls).toBe(2)
      }),
    90_000,
  )

  cliIt.live(
    "rejects an unavailable recorded model on resume",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({ bunRun: true })
        const sdk = createOpencodeClient({ baseUrl: server.url, throwOnError: true })
        const { data } = yield* Effect.promise(() => sdk.session.create({ title: "Unavailable model" }))
        if (!data) throw new Error("Session creation returned no data")
        const sessionID = data.id
        yield* Effect.promise(() => sdk.session.prompt({
          sessionID,
          model: { providerID: "missing-provider", modelID: "recorded" },
          noReply: true,
          parts: [{ type: "text", text: "Seed an unavailable session model" }],
        }))
        const result = yield* opencode.spawn(["run", "--attach", server.url, "--no-trace", "--session", sessionID, "test"], {
          bunRun: true,
          timeoutMs: 20_000,
        })
        opencode.expectExit(result, 1)
        expect(result.stderr + result.stdout).toContain("Model not found: missing-provider/recorded (from session history)")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "attached run validates the effective migrated default agent model",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({
          bunRun: true,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              enabled_providers: ["test"],
              model: "missing-provider/missing-model",
              default_agent: "data-qa",
              agent: { analyst: { model: "test/test-model" } },
            }),
          },
        })
        yield* llm.text("Attached run used the analyst model")
        const result = yield* opencode.spawn(["run", "--attach", server.url, "--no-trace", "test"], { bunRun: true })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("Attached run used the analyst model")
      }),
    90_000,
  )
})

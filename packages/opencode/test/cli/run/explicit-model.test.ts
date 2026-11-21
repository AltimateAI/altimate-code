import { describe, expect } from "bun:test"
import path from "node:path"
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
          expect(result.stderr + result.stdout).toContain(`Model not found: ${requested || "/"}`)
          expect(result.stderr + result.stdout).toContain("at the project root")
        }),
      30_000,
    )
  }
})

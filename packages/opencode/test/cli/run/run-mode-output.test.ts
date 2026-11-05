// altimate_change start — run-mode output boundary: the completion token is a signal to the
// harness, not part of the answer, and a blocked run is reported as blocked.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const config = (url: string) =>
  JSON.stringify({ ...testProviderConfig(url), experimental: { auto_mcp_discovery: false } })

describe("opencode run: run-mode output boundary", () => {
  cliIt.concurrent(
    "a trailing DONE line stays out of stdout and --output; done_reason is still explicit_done",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.json")
        yield* llm.text('{"title":"x"}\n\nDONE')
        const result = yield* opencode.run("Return the title as JSON only.", {
          extraArgs: ["--output", outputPath],
          bunRun: true,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe('{"title":"x"}')
        expect(result.stdout).toContain('{"title":"x"}')
        expect(result.stdout).not.toMatch(/^DONE$/m)
      }),
    90_000,
  )

  cliIt.concurrent(
    "--format json: the text event carries the answer without DONE and termination reports explicit_done",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.json")
        yield* llm.text('{"title":"x"}\n\nDONE')
        const result = yield* opencode.run("Return the title as JSON only.", {
          format: "json",
          extraArgs: ["--output", outputPath],
          bunRun: true,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe('{"title":"x"}')
        const events = opencode.parseJsonEvents(result.stdout)
        const texts = events
          .filter((event) => event.type === "text")
          .map((event) => (event.part as { text: string }).text)
        expect(texts).toEqual(['{"title":"x"}'])
        expect(events.filter((event) => event.type === "termination")).toMatchObject([{ done_reason: "explicit_done" }])
      }),
    90_000,
  )

  cliIt.concurrent(
    "with run mode off, the text is printed as the model wrote it",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.txt")
        yield* llm.text("Print the word.\nDONE")
        const result = yield* opencode.run("Print the word DONE on its own line.", {
          extraArgs: ["--output", outputPath],
          bunRun: true,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url), ALTIMATE_RUN_MODE: "0" },
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe("Print the word.\nDONE")
      }),
    90_000,
  )

  cliIt.concurrent(
    "a blocked reply ends the run with done_reason=blocked and exit 1, never as done",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.txt")
        const reply = "Read the connection config; no credential is set.\nBLOCKED: the warehouse password is missing"
        yield* llm.text(reply)
        const result = yield* opencode.run("Load the table.", {
          format: "json",
          extraArgs: ["--output", outputPath],
          bunRun: true,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })
        opencode.expectExit(result, 1)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(reply)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { done_reason: "blocked", why_harness_stopped: "none" },
        ])
      }),
    90_000,
  )
})
// altimate_change end

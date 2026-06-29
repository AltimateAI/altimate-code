import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // altimate_change — fork's `mcp add` uses an explicit `--name` flag instead of a positional name arg.
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "--name",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        // altimate_change — fork global config dir is altimate-code (file name stays opencode.json).
        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "altimate-code", "opencode.json")).json(),
        )
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // altimate_change — fork's `mcp add` uses an explicit `--name` flag instead of a positional name arg.
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "--name",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        // altimate_change — fork global config dir is altimate-code (file name stays opencode.json).
        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "altimate-code", "opencode.json")).json(),
        )
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )
})

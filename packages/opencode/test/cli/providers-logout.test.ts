import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("providers logout", () => {
  cliIt.live(
    "removes Altimate Base independently from ordinary provider credentials",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const dataDir = path.join(home, ".local", "share", "altimate-code")
        const basePath = path.join(dataDir, "altimate-base.json")
        const authPath = path.join(dataDir, "auth.json")
        const disconnectedBase = {
          version: 1,
          installSecret: "test-install-secret",
        }
        const registeredBase = {
          ...disconnectedBase,
          apiKey: "sk-altimate-base-test",
          baseURL: "https://gateway.test",
          expiresAt: "2099-01-01T00:00:00.000Z",
          rejected: true,
        }
        const anthropic = { type: "api", key: "anthropic-test-key" }
        const writeBase = (record: typeof disconnectedBase | typeof registeredBase) =>
          fs.writeFile(basePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 })

        yield* Effect.promise(() => fs.mkdir(dataDir, { recursive: true }))
        yield* Effect.promise(() => writeBase(registeredBase))
        yield* Effect.promise(() =>
          fs.writeFile(
            authPath,
            JSON.stringify({
              anthropic,
              // Old builds could leave this entry in the shared auth store. Base logout owns only
              // this reserved provider ID and must preserve every unrelated credential.
              "altimate-free": { type: "api", key: "legacy-base-key" },
            }),
            { mode: 0o600 },
          ),
        )

        const baseLogout = yield* opencode.spawn(["providers", "logout", "altimate-base"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(baseLogout, 0, "providers logout altimate-base")
        expect(baseLogout.stdout).toContain("Logout successful")
        // Logout strips every usable credential field while retaining the local fair-use identity.
        // A later consented setup therefore reuses the same gateway budget principal.
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(basePath, "utf8")))).toEqual({
          ...disconnectedBase,
          logoutNonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        })
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authPath, "utf8")))).toEqual({ anthropic })

        const disconnectedBeforeRepeatedLogout = JSON.parse(
          yield* Effect.promise(() => fs.readFile(basePath, "utf8")),
        )
        const repeatedBaseLogout = yield* opencode.spawn(["providers", "logout", "altimate-base"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(repeatedBaseLogout, 0, "providers logout disconnected altimate-base")
        expect(repeatedBaseLogout.stdout).toContain("Logout successful")
        const disconnectedAfterRepeatedLogout = JSON.parse(
          yield* Effect.promise(() => fs.readFile(basePath, "utf8")),
        )
        expect(disconnectedAfterRepeatedLogout).toEqual({
          ...disconnectedBase,
          logoutNonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        })
        expect(disconnectedAfterRepeatedLogout.logoutNonce).not.toBe(disconnectedBeforeRepeatedLogout.logoutNonce)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authPath, "utf8")))).toEqual({ anthropic })

        yield* Effect.promise(() => writeBase(registeredBase))
        const baseBeforeGenericLogout = yield* Effect.promise(() => fs.readFile(basePath, "utf8"))
        const genericLogout = yield* opencode.spawn(["providers", "logout", "anthropic"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(genericLogout, 0, "providers logout anthropic")
        expect(genericLogout.stdout).toContain("Logout successful")
        expect(yield* Effect.promise(() => fs.readFile(basePath, "utf8"))).toBe(baseBeforeGenericLogout)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authPath, "utf8")))).toEqual({})

        yield* Effect.promise(() => fs.writeFile(basePath, "{truncated", { mode: 0o600 }))
        const malformedBaseLogout = yield* opencode.spawn(["providers", "logout", "altimate-base"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(malformedBaseLogout, 0, "providers logout malformed altimate-base")
        expect(malformedBaseLogout.stdout).toContain("Logout successful")
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(basePath, "utf8")))).toEqual({
          version: 1,
          installSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
          logoutNonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        })
      }),
    120_000,
  )
})

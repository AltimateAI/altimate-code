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

  cliIt.live(
    "removes the saved Altimate gateway key along with the auth-store entry",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const dataDir = path.join(home, ".local", "share", "altimate-code")
        const authPath = path.join(dataDir, "auth.json")
        const altimatePath = path.join(home, ".altimate", "altimate.json")
        const anthropic = { type: "api", key: "anthropic-test-key" }
        const writeAltimate = () =>
          fs.writeFile(
            altimatePath,
            JSON.stringify({
              altimateUrl: "https://api.test",
              altimateInstanceName: "tenant",
              altimateApiKey: "gateway-test-key",
            }),
            { mode: 0o600 },
          )
        const altimateFileExists = () =>
          fs.stat(altimatePath).then(
            () => true,
            () => false,
          )

        yield* Effect.promise(() => fs.mkdir(dataDir, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.dirname(altimatePath), { recursive: true }))
        yield* Effect.promise(() => writeAltimate())
        yield* Effect.promise(() =>
          fs.writeFile(
            authPath,
            JSON.stringify({ anthropic, "altimate-backend": { type: "api", key: "gateway-test-key" } }),
            { mode: 0o600 },
          ),
        )

        const logout = yield* opencode.spawn(["providers", "logout", "altimate-backend"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(logout, 0, "providers logout altimate-backend")
        expect(logout.stdout).toContain("Logout successful")
        expect(yield* Effect.promise(() => altimateFileExists())).toBe(false)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authPath, "utf8")))).toEqual({ anthropic })

        // Credentials saved only to altimate.json (TUI paste dialog) must still be removable.
        yield* Effect.promise(() => writeAltimate())
        const fileOnlyLogout = yield* opencode.spawn(["providers", "logout", "altimate-backend"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(fileOnlyLogout, 0, "providers logout file-only altimate-backend")
        expect(fileOnlyLogout.stdout).toContain("Logout successful")
        expect(yield* Effect.promise(() => altimateFileExists())).toBe(false)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authPath, "utf8")))).toEqual({ anthropic })
      }),
    120_000,
  )

  cliIt.live(
    "removes datamate MCP entries that carry the signed-out gateway key",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const altimatePath = path.join(home, ".altimate", "altimate.json")
        // The CLI runs with cwd=home, so home is the project directory.
        const projectConfigPath = path.join(home, "altimate-code.json")
        const globalConfigPath = path.join(home, ".config", "altimate-code", "altimate-code.json")
        const datamateEntry = (key: string) => ({
          type: "remote",
          url: "https://mcp.test",
          oauth: false,
          headers: { Authorization: `Bearer ${key}`, "x-datamate-id": "1", "x-tenant": "tenant" },
          enabled: true,
        })
        const unrelated = datamateEntry("someone-elses-key")

        yield* Effect.promise(() => fs.mkdir(path.dirname(altimatePath), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.dirname(globalConfigPath), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            altimatePath,
            JSON.stringify({
              altimateUrl: "https://api.test",
              altimateInstanceName: "tenant",
              altimateApiKey: "gateway-test-key",
            }),
            { mode: 0o600 },
          ),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            projectConfigPath,
            JSON.stringify({ mcp: { "datamate-sales": datamateEntry("gateway-test-key"), unrelated } }),
          ),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            globalConfigPath,
            JSON.stringify({ mcp: { "datamate-ops": datamateEntry("gateway-test-key") } }),
          ),
        )

        const logout = yield* opencode.spawn(["providers", "logout", "altimate-backend"], {
          env: { OPENCODE_AUTH_CONTENT: "" },
        })
        opencode.expectExit(logout, 0, "providers logout altimate-backend with datamate MCP entries")
        expect(logout.stdout).toContain('Removed MCP server "datamate-sales"')
        expect(logout.stdout).toContain('Removed MCP server "datamate-ops"')
        expect(logout.stdout).toContain("Logout successful")
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(projectConfigPath, "utf8")))).toEqual({
          mcp: { unrelated },
        })
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(globalConfigPath, "utf8")))).toEqual({ mcp: {} })
      }),
    120_000,
  )
})

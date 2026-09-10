// altimate_change start — exercise ordinary cold startup, which the PURE subprocess defaults skip.
import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { cliIt } from "../../lib/cli-process"

cliIt.live(
  "fresh non-PURE startup serves config without installing plugin dependencies",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const configDir = path.join(home, ".opencode")
      yield* Effect.promise(() => mkdir(configDir))
      // An outside, dependency-free plugin makes /provider/auth await Config.waitForDependencies.
      // Without this barrier, assertions can race a detached install that has not reached npm yet.
      const plugin = path.join(home, "startup-probe.ts")
      const loaded = path.join(home, "plugin-loaded")
      yield* Effect.promise(() =>
        writeFile(
          plugin,
          `export default async () => { await Bun.write(${JSON.stringify(loaded)}, "ready"); return {} }`,
        ),
      )
      const requests: string[] = []
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              requests.push(new URL(request.url).pathname)
              return new Response("Unexpected package installation during fresh startup", { status: 503 })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const server = yield* opencode.serve({
        hostname: "127.0.0.1",
        readyTimeoutMs: 30_000,
        extraArgs: ["--print-logs"],
        env: {
          OPENCODE_PURE: "0",
          OPENCODE_CONFIG_DIR: configDir,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(plugin).href] }),
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          ALTIMATE_TELEMETRY_DISABLED: "1",
          npm_config_registry: registry.url.href,
          npm_config_fetch_retries: "0",
          npm_config_fetch_timeout: "1000",
        },
      })
      const client = yield* HttpClient.HttpClient
      for (const route of ["/config", "/provider/auth", "/provider", "/global/health"]) {
        yield* Effect.gen(function* () {
          const response = yield* client.get(`${server.url}${route}`)
          expect(response.status).toBe(200)
          yield* response.json
        }).pipe(Effect.timeout("15 seconds"))
      }
      expect(existsSync(loaded)).toBe(true)
      // Prove config loading ran, then reject installation even if it failed quickly instead of hanging.
      expect(existsSync(path.join(configDir, ".gitignore"))).toBe(true)
      expect(requests).toEqual([])
      expect(yield* server.stderr()).not.toContain("background dependency install failed")
      for (const dir of [
        configDir,
        path.join(home, ".config", "altimate-code"),
        path.join(home, ".config", "opencode"),
      ]) {
        for (const artifact of ["node_modules", "package.json", "package-lock.json"]) {
          expect(existsSync(path.join(dir, artifact))).toBe(false)
        }
      }
    }),
  90_000,
)
// altimate_change end

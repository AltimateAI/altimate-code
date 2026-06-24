import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { EventV2 } from "@opencode-ai/core/event"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"

// altimate_change start — telemetry (lazy import to avoid circular dep with Telemetry → Installation)
let _telemetryCache: (typeof import("../telemetry"))["Telemetry"] | undefined
async function getTelemetry() {
  if (_telemetryCache) return _telemetryCache
  const { Telemetry } = await import("../telemetry")
  _telemetryCache = Telemetry
  return Telemetry
}
// altimate_change end

// altimate_change start — curl-upgrade endpoint config
// Upstream uses opencode.ai/install. We fetch the altimate install script
// from www.altimate.sh/install (the apex altimate.sh isn't routed to the
// Amplify Next.js app — tracked separately; revisit when apex DNS is fixed).
// Bounded timeout so a stalled CDN/origin can't hang `altimate upgrade` forever.
const UPGRADE_INSTALL_URL = "https://www.altimate.sh/install"
// Native Windows has no `bash`, so the curl-installed binary self-updates via
// the PowerShell installer instead (downloads the same Bun exe from GitHub
// releases). Same host as the bash script; both 302 to raw GitHub.
const UPGRADE_INSTALL_PS_URL = "https://www.altimate.sh/install.ps1"
const UPGRADE_FETCH_TIMEOUT_MS = 15_000
// altimate_change end

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: EventV2.define({
    type: "installation.updated",
    schema: {
      version: Schema.String,
    },
  }),
  UpdateAvailable: EventV2.define({
    type: "installation.update-available",
    schema: {
      version: Schema.String,
    },
  }),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  // altimate_change start — User-Agent brand
  return `altimate-code/${InstallationChannel}/${InstallationVersion}/${client}`
  // altimate_change end
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      // altimate_change start — brew formula detection
      const tapFormula = yield* text(["brew", "list", "--formula", "AltimateAI/tap/altimate-code"])
      if (tapFormula.includes("altimate-code")) return "AltimateAI/tap/altimate-code"
      const coreFormula = yield* text(["brew", "list", "--formula", "altimate-code"])
      if (coreFormula.includes("altimate-code")) return "altimate-code"
      return "AltimateAI/tap/altimate-code"
      // altimate_change end
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return result.stderr || `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        // altimate_change start — friendly fetch error + manual-recovery hint, branded install URL, bounded timeout
        const response = yield* httpOk
          .execute(HttpClientRequest.get(UPGRADE_INSTALL_URL))
          .pipe(
            Effect.timeout(UPGRADE_FETCH_TIMEOUT_MS),
            Effect.mapError(
              (err) =>
                new UpgradeFailedError({
                  stderr:
                    `Could not download install script from ${UPGRADE_INSTALL_URL}: ${errorMessage(err)}. ` +
                    `Re-run the install manually: curl -fsSL ${UPGRADE_INSTALL_URL} | bash — ` +
                    `or download a release binary directly from https://github.com/AltimateAI/altimate-code/releases/latest`,
                }),
            ),
          )
        const body = yield* response.text.pipe(
          Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
        )
        // altimate_change end
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess
          .run(
            ChildProcess.make(shell, [], {
              stdin: Stream.make(bodyBytes),
              env: { VERSION: target },
              extendEnv: true,
            }),
          )
          .pipe(Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })))
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
    )

    // altimate_change start — Windows curl-install upgrade via PowerShell
    // The curl/standalone install on native Windows lives in %USERPROFILE%\.altimate\bin
    // (detected as method "curl") but there is no `bash` to pipe the install
    // script into. Run the PowerShell installer instead; it downloads the same
    // Bun exe from GitHub releases and reads $env:VERSION to pin the target.
    const upgradePowershell = Effect.fnUntraced(function* (target: string) {
      // Probe-only fetch to surface a friendly error before we hand the URL to
      // PowerShell (which would otherwise fail opaquely inside `irm | iex`).
      yield* httpOk
        .execute(HttpClientRequest.head(UPGRADE_INSTALL_PS_URL))
        .pipe(
          Effect.timeout(UPGRADE_FETCH_TIMEOUT_MS),
          Effect.mapError(
            (err) =>
              new UpgradeFailedError({
                stderr:
                  `Could not download install script from ${UPGRADE_INSTALL_PS_URL}: ${errorMessage(err)}. ` +
                  `Re-run the install manually: powershell -c "irm ${UPGRADE_INSTALL_PS_URL} | iex" — ` +
                  `or download a release binary directly from https://github.com/AltimateAI/altimate-code/releases/latest`,
              }),
          ),
        )
      return yield* run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${UPGRADE_INSTALL_PS_URL} | iex`],
        { env: { VERSION: target } },
      )
    })
    // altimate_change end

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        // altimate_change start — detect altimate-code curl install at ~/.altimate/bin
        // (the standalone install dir was renamed in v0.7.1; `.opencode/bin` is kept
        // for users still on a pre-rename layout, `.local/bin` for distros that
        // resolve there).
        if (process.execPath.includes(path.join(".altimate", "bin"))) return "curl" as Method
        // altimate_change end
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          // altimate_change start — brew formula name
          { name: "brew", command: () => text(["brew", "list", "--formula", "altimate-code"]) },
          // altimate_change end
          { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          // altimate_change start — package names for detection
          const installedName =
            check.name === "brew"
              ? "altimate-code"
              : check.name === "choco" || check.name === "scoop"
                ? "opencode"
                : "@altimateai/altimate-code"
          // altimate_change end
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          // altimate_change start — brew: use GitHub releases API as source of truth
          // altimate-code is NOT in core homebrew, so formulae.brew.sh will 404.
          // `brew info --json=v2` returns the LOCAL cached version which can be stale
          // if the tap hasn't been updated — using it would cause `latest()` to return
          // the already-installed version, making the upgrade command skip silently.
          // GitHub releases API is the authoritative source for the actual latest version.
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://api.github.com/repos/AltimateAI/altimate-code/releases/latest").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
          return data.tag_name.replace(/^v/, "")
          // altimate_change end
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            // altimate_change start — npm package name for version check
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/@altimateai/altimate-code/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
            // altimate_change end
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        const response = yield* httpOk.execute(
          // altimate_change start — default version check via altimate-code releases
          HttpClientRequest.get("https://api.github.com/repos/AltimateAI/altimate-code/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
          // altimate_change end
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            // altimate_change start — native Windows has no bash; use the PS installer
            upgradeResult =
              process.platform === "win32" ? yield* upgradePowershell(target) : yield* upgradeCurl(target)
            // altimate_change end
            break
          case "npm":
            // altimate_change start — npm package name
            upgradeResult = yield* run(["npm", "install", "-g", `@altimateai/altimate-code@${target}`])
            // altimate_change end
            break
          case "pnpm":
            // altimate_change start — pnpm package name
            upgradeResult = yield* run(["pnpm", "install", "-g", `@altimateai/altimate-code@${target}`])
            // altimate_change end
            break
          case "bun":
            // altimate_change start — bun package name
            upgradeResult = yield* run(["bun", "install", "-g", `@altimateai/altimate-code@${target}`])
            // altimate_change end
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              // altimate_change start — brew tap name
              const tap = yield* run(["brew", "tap", "AltimateAI/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "AltimateAI/tap"])
              // altimate_change end
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
            break
          case "scoop":
            upgradeResult = yield* run(["scoop", "install", `opencode@${target}`])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        // altimate_change start — telemetry for upgrade result
        const telemetryMethod = (["npm", "bun", "brew"].includes(m) ? m : "other") as
          | "npm"
          | "bun"
          | "brew"
          | "other"
        if (!upgradeResult || upgradeResult.code !== 0) {
          const stderr = upgradeFailure(m, upgradeResult)
          const T = yield* Effect.promise(() => getTelemetry())
          T.track({
            type: "upgrade_attempted",
            timestamp: Date.now(),
            session_id: T.getContext().sessionId || "cli",
            from_version: InstallationVersion,
            to_version: target,
            method: telemetryMethod,
            status: "error",
            error: stderr.slice(0, 500),
          })
          return yield* new UpgradeFailedError({ stderr })
        }
        // altimate_change end
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        // altimate_change start — telemetry for upgrade success
        const T2 = yield* Effect.promise(() => getTelemetry())
        T2.track({
          type: "upgrade_attempted",
          timestamp: Date.now(),
          session_id: T2.getContext().sessionId || "cli",
          from_version: InstallationVersion,
          to_version: target,
          method: telemetryMethod,
          status: "success",
        })
        // altimate_change end
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export const node = LayerNode.make(layer, [httpClient, AppProcess.node])

// altimate_change start — re-export the version constant under the old Installation.VERSION name
// (upstream moved it to InstallationVersion in @opencode-ai/core/installation/version). Keeps the
// many survivor callers of Installation.VERSION resolving without per-file repoints.
export const VERSION = InstallationVersion
// altimate_change end

export * as Installation from "."

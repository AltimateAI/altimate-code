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
import fs from "fs"
import { Global } from "@opencode-ai/core/global"
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

// altimate_change start — deterministic install resolution (#1305)
// Detection used to guess two ways, and both were unsound: a substring test on
// process.execPath (`.local/bin` is a generic user bin dir, so an npm install with
// `npm config set prefix ~/.local` was classified "curl" and upgraded via
// `curl | bash`, orphaning the npm copy), and a probe loop asking each package
// manager "do you have this package?" — which answers a different question than
// "did THIS running binary come from you", so it picked arbitrarily whenever more
// than one install existed.
//
// The running binary's own path is the ground truth. The npm `bin/altimate` shim is
// a Node script that spawnSync()s the PLATFORM package's binary, so inside the CLI
// process.execPath is:
//   <prefix>/lib/node_modules/@altimateai/altimate-code/node_modules/
//     @altimateai/altimate-code-darwin-arm64/bin/altimate-code
// i.e. it always lands under node_modules for every package-manager install. Match
// the optional `-<platform>-<arch>` suffix explicitly rather than relying on the
// wrapper name happening to be a prefix of the platform package name.
const PKG_SEGMENT_RE =
  /[\\/]node_modules[\\/]@altimateai[\\/]altimate-code(?:-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)?)?(?:[\\/]|$)/i
// pnpm global installs may expose the package via the `.pnpm` virtual store OR via a
// plain `pnpm/global/<v>` link path (no `.pnpm` segment), so match both spellings —
// otherwise the plain layout falls through to the npm default and routes upgrades at
// the wrong manager.
const PNPM_SEGMENT_RE = /[\\/](?:\.pnpm|pnpm)[\\/]/i
const BUN_SEGMENT_RE = /[\\/]\.bun[\\/]/i
const YARN_SEGMENT_RE = /[\\/](?:\.yarn|yarn[\\/]global)[\\/]/i
// Homebrew bin entries are symlinks into Cellar, so realpath lands there. Match the
// Cellar segment rather than the prefix: /usr/local is also a common npm prefix.
const BREW_SEGMENT_RE = /[\\/]Cellar[\\/]altimate-code[\\/]/i
const SCOOP_SEGMENT_RE = /[\\/]scoop[\\/]apps[\\/]/i
const CHOCO_SEGMENT_RE = /[\\/]chocolatey[\\/]/i
// The standalone (curl / install.ps1 / `install --binary`) layout. `.opencode/bin` is
// the pre-v0.7.1 directory name, kept for users who have not re-installed since.
// NOTE: `.local/bin` is deliberately NOT here — see the comment above.
const STANDALONE_SEGMENT_RE = /[\\/]\.(?:altimate|opencode)[\\/]bin[\\/]/i

export interface ResolvedInstall {
  readonly method: Method
  /** Directory the upgrade would mutate. Only set where we can name it without a subprocess. */
  readonly root?: string
}

/** Resolve the install that produced THIS process.
 *
 * Pure in (execPath, env) so it can be unit-tested against fabricated layouts
 * without spawning real installs. */
export function resolveInstall(
  execPath: string = realExecPath(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedInstall {
  // The shim honours ALTIMATE_CODE_BIN_PATH ahead of everything else, so the running
  // binary is whatever the user pointed at — not something an installer manages.
  // Never auto-upgrade a pinned path.
  if (env["ALTIMATE_CODE_BIN_PATH"]) return { method: "unknown" }

  if (PKG_SEGMENT_RE.test(execPath)) {
    if (PNPM_SEGMENT_RE.test(execPath)) return { method: "pnpm" }
    if (BUN_SEGMENT_RE.test(execPath)) return { method: "bun" }
    if (YARN_SEGMENT_RE.test(execPath)) return { method: "yarn" }
    return { method: "npm" }
  }
  if (BREW_SEGMENT_RE.test(execPath)) return { method: "brew" }
  if (SCOOP_SEGMENT_RE.test(execPath)) return { method: "scoop" }
  if (CHOCO_SEGMENT_RE.test(execPath)) return { method: "choco" }
  if (STANDALONE_SEGMENT_RE.test(execPath)) return { method: "curl", root: path.dirname(execPath) }
  return { method: "unknown" }
}

/** realpath so a symlinked bin entry (npm, brew) resolves to the file it points at.
 * Falls back to the raw path when the file is gone or unreadable. */
function realExecPath(): string {
  try {
    return fs.realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Classify a failed upgrade into a stable code plus a message safe to show.
 *
 * Deliberately does NOT echo the package manager's stderr — it can carry tokens and
 * environment. The classification is derived from it, the raw text is only logged
 * locally (see the logWarning in upgrade()). */
function classifyFailure(stderr: string, stdout: string): { code: string; hint?: string } {
  const t = `${stderr}\n${stdout}`
  if (/EACCES|EPERM|permission denied/i.test(t))
    return { code: "permission", hint: "the install directory is not writable" }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|ENETUNREACH/i.test(t))
    return { code: "network", hint: "the registry could not be reached" }
  if (/E404|404 Not Found/i.test(t)) return { code: "not-found", hint: "that version does not exist in the registry" }
  if (/ENOSPC|no space left/i.test(t)) return { code: "disk-full", hint: "the disk is full" }
  if (/ETARGET|No matching version/i.test(t))
    return { code: "no-matching-version", hint: "no published version satisfies that range" }
  return { code: "unknown" }
}
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
      // altimate_change start — do not echo package-manager/install-script stderr; it can contain tokens or env
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      // altimate_change end
      return `Upgrade failed for ${method}.`
    }

    // altimate_change start — writability preflight (#1305)
    /** Directories a global install of `m` would mutate. Empty = nothing cheap to check. */
    const globalDirs = Effect.fnUntraced(function* (m: Method) {
      switch (m) {
        case "npm": {
          // `npm root -g` is the portable way to get the package dir: on Windows packages
          // live at <prefix>/node_modules and the shims at <prefix> itself, so the Unix
          // <prefix>/lib/node_modules is wrong there. `npm bin -g` was REMOVED in npm 9
          // ("Unknown command: bin"), so derive the bin dir from the prefix instead.
          const root = (yield* text(["npm", "root", "-g"])).trim()
          const prefix = (yield* text(["npm", "prefix", "-g"])).trim()
          const bin = prefix ? (process.platform === "win32" ? prefix : path.join(prefix, "bin")) : ""
          return [root, bin].filter(Boolean)
        }
        case "pnpm": {
          // Both: a global install writes the store root AND the shim dir; checking only
          // one lets the other fail with EACCES after we have already shelled out.
          const root = (yield* text(["pnpm", "root", "-g"])).trim()
          const bin = (yield* text(["pnpm", "bin", "-g"])).trim()
          return [root, bin].filter(Boolean)
        }
        case "bun": {
          const bin = (yield* text(["bun", "pm", "bin", "-g"])).trim()
          return [bin].filter(Boolean)
        }
        case "yarn": {
          const dir = (yield* text(["yarn", "global", "dir"])).trim()
          const bin = (yield* text(["yarn", "global", "bin"])).trim()
          return [dir, bin].filter(Boolean)
        }
        case "curl": {
          const resolved = resolveInstall()
          return resolved.root ? [resolved.root] : []
        }
        // brew / scoop / choco own their own elevation and policy — do not second-guess them.
        default:
          return [] as string[]
      }
    })

    const remediation = (m: Method, dir: string, target: string) => {
      const pkg = `@altimateai/altimate-code@${target}`
      switch (m) {
        case "npm":
          return `Cannot write to the npm global prefix (${dir}). Run \`sudo npm install -g ${pkg}\`, or switch to a user-owned prefix with \`npm config set prefix ~/.npm-global\`.`
        case "pnpm":
          return `Cannot write to the pnpm global directory (${dir}). Run \`pnpm setup\` to use a user-owned location, or re-run the install with elevated permissions.`
        case "bun":
          return `Cannot write to the bun global bin directory (${dir}). Set BUN_INSTALL to a user-owned location, or re-run the install with elevated permissions.`
        case "yarn":
          return `Cannot write to the yarn global directory (${dir}). Set a user-owned prefix with \`yarn config set prefix ~/.yarn\`, or re-run with elevated permissions.`
        case "curl":
          return `Cannot write to the install directory (${dir}). Fix its permissions, or re-run the installer.`
        default:
          return `Cannot write to the install directory (${dir}).`
      }
    }

    /** Returns an error message when the upgrade cannot possibly succeed, else undefined.
     *
     * Checking first means we never shell out to a command that is going to fail on
     * permissions — which is what produced the old, undiagnosable
     * "Upgrade failed for npm (exit code 243)." */
    const preflight = Effect.fnUntraced(function* (m: Method, target: string) {
      const dirs = yield* globalDirs(m)
      for (const dir of dirs) {
        if (!dir) continue
        // A directory that does not exist yet is not a permission problem: the package
        // manager creates it. Only an EXISTING, unwritable directory is a hard stop.
        if (!fs.existsSync(dir)) continue
        if (!isWritable(dir)) return remediation(m, dir, target)
      }
      return undefined
    })
    // altimate_change end

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(function* (target: string) {
      // altimate_change start — friendly fetch error + manual-recovery hint, branded install URL, bounded timeout
      const response = yield* httpOk.execute(HttpClientRequest.get(UPGRADE_INSTALL_URL)).pipe(
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
    })

    // altimate_change start — Windows curl-install upgrade via PowerShell
    // The curl/standalone install on native Windows lives in %USERPROFILE%\.altimate\bin
    // (detected as method "curl") but there is no `bash` to pipe the install
    // script into. Run the PowerShell installer instead; it downloads the same
    // Bun exe from GitHub releases and reads $env:VERSION to pin the target.
    const upgradePowershell = Effect.fnUntraced(function* (target: string) {
      // Probe-only fetch to surface a friendly error before we hand the URL to
      // PowerShell (which would otherwise fail opaquely inside `irm | iex`).
      yield* httpOk.execute(HttpClientRequest.head(UPGRADE_INSTALL_PS_URL)).pipe(
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
        // altimate_change start — resolve from the running binary instead of guessing (#1305).
        // Replaces a substring test on execPath plus a loop that spawned up to seven
        // package managers ("npm list -g", "brew list", ...) on the startup update-check
        // path. resolveInstall() is synchronous, spawns nothing, and answers the question
        // that actually matters: which install produced THIS process.
        return resolveInstall().method
        // altimate_change end
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
        // altimate_change start — refuse before shelling out when the target is unwritable (#1305)
        const blocked = yield* preflight(m, target)
        if (blocked) return yield* new UpgradeFailedError({ stderr: blocked })
        // altimate_change end
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            // altimate_change start — native Windows has no bash; use the PS installer
            upgradeResult = process.platform === "win32" ? yield* upgradePowershell(target) : yield* upgradeCurl(target)
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
        const telemetryMethod = (["npm", "bun", "brew"].includes(m) ? m : "other") as "npm" | "bun" | "brew" | "other"
        if (!upgradeResult || upgradeResult.code !== 0) {
          // altimate_change start — make non-permission failures diagnosable (#1305).
          // The success path below logs the real stdout/stderr; this branch used to drop
          // them entirely, so every failure that was not a permission problem (network,
          // E404, ENOSPC, a failing lifecycle script) collapsed into the same opaque
          // "Upgrade failed for <m> (exit code N)." with nothing written anywhere.
          // The log file is local and already carries this content on success, so logging
          // it here is consistency, not new exposure — the user-facing message and the
          // telemetry payload both stay redacted.
          const classified = classifyFailure(upgradeResult?.stderr ?? "", upgradeResult?.stdout ?? "")
          yield* Effect.logWarning("upgrade failed", {
            method: m,
            target,
            code: upgradeResult?.code,
            reason: classified.code,
            stdout: upgradeResult?.stdout,
            stderr: upgradeResult?.stderr,
          })
          const base = upgradeFailure(m, upgradeResult)
          const stderr = [
            base,
            classified.hint ? `Likely cause: ${classified.hint}.` : undefined,
            `Details were written to ${Global.Path.log}.`,
          ]
            .filter(Boolean)
            .join(" ")
          const T = yield* Effect.promise(() => getTelemetry())
          T.track({
            type: "upgrade_attempted",
            timestamp: Date.now(),
            session_id: T.getContext().sessionId || "cli",
            from_version: InstallationVersion,
            to_version: target,
            method: telemetryMethod,
            status: "error",
            // A stable classification code, not free text: the old value was the generic
            // message, so every failure looked identical on a dashboard.
            error: `${classified.code}: exit ${upgradeResult?.code ?? "n/a"}`,
          })
          return yield* new UpgradeFailedError({ stderr })
          // altimate_change end
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

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer)),
)
// altimate_change end

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [httpClient, AppProcess.node])
// altimate_change end

// altimate_change start — re-export the version constant under the old Installation.VERSION name
// (upstream moved it to InstallationVersion in @opencode-ai/core/installation/version). Keeps the
// many survivor callers of Installation.VERSION resolving without per-file repoints.
export const VERSION = InstallationVersion
// altimate_change end

export * as Installation from "."

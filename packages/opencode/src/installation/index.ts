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
import os from "os"
import { EventV2 } from "@opencode-ai/core/event"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"

// altimate_change start — lazy log-dir lookup (#1305). @opencode-ai/core/global runs a
// top-level `await Promise.all([...mkdir...])`, so a static import would create seven
// directories merely by loading this module — and would drag that side effect into every
// unit test that imports resolveInstall(). Same lazy shape as getTelemetry() below.
async function getLogFile(): Promise<string | undefined> {
  // Our record is logged at WARN, which an ERROR minimum level drops (see
  // Logging.minimumLogLevel) — do not promise an artifact that was never written.
  if (process.env["OPENCODE_LOG_LEVEL"]?.toUpperCase() === "ERROR") return undefined
  const { Global } = await import("@opencode-ai/core/global")
  // The file logger writes to opencode.log inside this directory; the directory itself also
  // holds trace jsonl and heap dumps, so naming the file saves the user a hunt.
  return path.join(Global.Path.log, "opencode.log")
}
// altimate_change end

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
// Detection used to fall back to a probe loop that asked each package manager "do you
// have this package?" (`npm list -g`, `brew list`, ...) and returned the first that said
// yes. That answers a different question than "did THIS running binary come from you",
// so once a user had more than one install — e.g. a standalone binary plus an npm copy,
// which is common — the answer was effectively arbitrary and upgrades were routed at an
// install the user was not running.
//
// The directory checks that ran before the probe loop were sound and are preserved
// below; only the probe loop is replaced.
//
// The running binary's own path is the ground truth, but it takes THREE shapes and the
// scope prefix is optional — `publish.ts` ships an unscoped `altimate-code` wrapper
// alongside the scoped one, and that unscoped package is what README.md:30 and
// docs/docs/getting-started.md:27 tell users to install:
//
//   <prefix>/lib/node_modules/altimate-code/bin/.altimate-code            (unscoped wrapper,
//   <prefix>/lib/node_modules/@altimateai/altimate-code/bin/.altimate-code   cached hardlink)
//   <prefix>/lib/node_modules/.../@altimateai/altimate-code-darwin-arm64/bin/altimate-code
//
// The first two are what actually run: postinstall.mjs hard-links the resolved platform
// binary to `<wrapper>/bin/.altimate-code` and both shims execute that cached file BEFORE
// walking to the nested platform package. A hardlink has no symlink for realpath to follow,
// so execPath keeps the wrapper's path and loses the platform suffix entirely. Requiring the
// `@altimateai` segment therefore reported "unknown" for the primary documented install
// path, silently disabling auto-upgrade for most real users.
const PKG_SEGMENT_RE =
  /[\\/]node_modules[\\/](?:@altimateai[\\/])?altimate-code(?:-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)?)?(?:[\\/]|$)/i
// pnpm global installs may expose the package via the `.pnpm` virtual store OR via a
// plain `pnpm/global/<v>` link path (no `.pnpm` segment), so match both spellings —
// otherwise the plain layout falls through to the npm default and routes upgrades at
// the wrong manager.
const PNPM_SEGMENT_RE = /[\\/](?:\.pnpm|pnpm[\\/]global)[\\/]/i
const BUN_SEGMENT_RE = /[\\/]\.bun[\\/]/i
// yarn classic's global dir is `~/.yarn` / `.../yarn/global` on unix and
// `%LOCALAPPDATA%\Yarn\config\global` on Windows; berry uses `.yarn`. Enumerate those
// layouts rather than matching any `yarn` path segment — a bare segment match let an
// unrelated ancestor directory named `yarn` decide the manager, which is the same
// path-is-identity mistake this change exists to remove.
const YARN_SEGMENT_RE = /[\\/](?:\.yarn|yarn[\\/](?:global|config[\\/]global|berry))[\\/]/i
// Homebrew bin entries are symlinks into Cellar, so realpath lands there. Match the
// Cellar segment rather than the prefix: /usr/local is also a common npm prefix.
const BREW_SEGMENT_RE = /[\\/]Cellar[\\/]altimate-code[\\/]/i
const SCOOP_SEGMENT_RE = /[\\/]scoop[\\/]apps[\\/]/i
const CHOCO_SEGMENT_RE = /[\\/]chocolatey[\\/]/i
// The standalone (curl / install.ps1 / `install --binary`) layouts. `.opencode/bin` is
// the pre-v0.7.1 directory name and `.local/bin` a distro-resolved location; both are
// kept for back-compat (#820) and `.local/bin` is also what test/sanity/Dockerfile uses.
//
// These are checked AFTER the node_modules match above, which is what makes them safe: a
// package-manager install's execPath always sits under `<prefix>/lib/node_modules/...`
// (whichever of the three shapes above it takes), so it can never collide with
// `<prefix>/bin` here even when the prefix is `~/.local`.
const STANDALONE_SEGMENT_RE = /[\\/]\.(?:altimate|opencode)[\\/]bin[\\/]|[\\/]\.local[\\/]bin[\\/]/i

// An npx cache, a package-manager download cache, or a project-local node_modules all
// contain a matching `node_modules/[@altimateai/]altimate-code*` segment but are NOT global
// installs.
// Attributing them to a package manager would make `upgrade()` run `npm install -g` and
// CREATE a global install the user never had — and for patch releases that happens
// automatically at startup (see cli/upgrade.ts). The old probe loop returned "unknown"
// for these, so they must keep degrading to notify-only.
const PACKAGE_MANAGERS: Method[] = ["npm", "pnpm", "bun", "yarn"]
const EPHEMERAL_SEGMENT_RE = /[\\/](?:_npx|_cacache|dlx|\.npx)[\\/]|[\\/]install[\\/]cache[\\/]|[\\/]dlx-[^\\/]+[\\/]/i

export interface ResolvedInstall {
  readonly method: Method
}

/** The two npm packages we publish. `publish.ts` ships a scoped wrapper and an unscoped one,
 * and the docs tell users to install the unscoped one. Platform binaries are ALWAYS scoped
 * (`@altimateai/altimate-code-<os>-<arch>`), so the running binary's own path cannot tell you
 * which wrapper owns it — hence ownerOf() below asks the filesystem instead of guessing. */
const CANDIDATE_PACKAGES = ["@altimateai/altimate-code", "altimate-code"] as const

/** Our per-platform packages. Always scoped, regardless of which wrapper pulled them in. */
const PLATFORM_PKG_RE =
  /[\\/]node_modules[\\/]@altimateai[\\/]altimate-code-[a-z0-9]+-[a-z0-9]+(?:-baseline)?(?:[\\/]|$)/i

/** Which of our packages, installed at top level in `root`, owns `execPath`?
 *
 * Deliberately does NOT parse `execPath` for the package name. A path cannot distinguish a
 * top-level global install from a transitive dependency, and it cannot say which wrapper
 * owns a platform package — platform packages are always scoped whichever wrapper pulled
 * them in, so reading the scope off the running binary named the wrong package.
 *
 * Two ways a binary belongs to a wrapper:
 *
 *  (a) It lives inside the wrapper directory. This is the common case: postinstall.mjs
 *      hard-links the platform binary to `<wrapper>/bin/.altimate-code` and the shims run
 *      that first.
 *  (b) It IS one of our platform packages, stored beside the wrapper rather than under it.
 *      pnpm's isolated store puts `.pnpm/@altimateai+altimate-code-<os>-<arch>@V/...` as a
 *      SIBLING of the wrapper's own store entry, and hoisting does the same. This is not an
 *      edge case: postinstall skips the cached binary on Windows entirely, and any install
 *      run with `--ignore-scripts` takes this route on every platform.
 *
 * (b) is bounded to the manager's own tree so a project-local binary cannot borrow a global
 * wrapper's identity, and it refuses to guess when BOTH wrappers are installed. */
export function ownerOf(root: string, execPath: string): string | undefined {
  if (!root || !execPath) return undefined
  const present = CANDIDATE_PACKAGES.filter((name) => fs.existsSync(path.join(root, ...name.split("/"))))
  for (const name of present) {
    if (isInside(execPath, path.join(root, ...name.split("/")))) return name
  }
  if (!PLATFORM_PKG_RE.test(execPath)) return undefined
  // Must be this manager's tree — `dirname(root)` covers stores kept beside `node_modules`.
  if (!isInside(execPath, root) && !isInside(execPath, path.dirname(root))) return undefined
  // Exactly one of our wrappers installed: it is the only thing that could have pulled this
  // platform package in. Both installed means we cannot say which, and guessing would
  // upgrade or remove the wrong one.
  return present.length === 1 ? present[0] : undefined
}

/** Resolve a CANDIDATE install identity for THIS process from its path.
 *
 * Pure in (execPath, env) so it can be unit-tested against fabricated layouts without
 * spawning real installs — which is also its limit: a path cannot prove global ownership,
 * nor say which package owns the binary. It picks which manager to ASK; `ownerOf()` answers
 * whether that manager actually owns us, and under which package name. */
export function resolveInstall(
  execPath: string = realExecPath(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedInstall {
  // The shim honours ALTIMATE_CODE_BIN_PATH ahead of everything else, so the running
  // binary is whatever the user pointed at — not something an installer manages.
  // Never auto-upgrade a pinned path.
  if (env["ALTIMATE_CODE_BIN_PATH"]) return { method: "unknown" }

  if (PKG_SEGMENT_RE.test(execPath) && !EPHEMERAL_SEGMENT_RE.test(execPath)) {
    if (PNPM_SEGMENT_RE.test(execPath)) return { method: "pnpm" }
    if (BUN_SEGMENT_RE.test(execPath)) return { method: "bun" }
    if (YARN_SEGMENT_RE.test(execPath)) return { method: "yarn" }
    return { method: "npm" }
  }
  if (BREW_SEGMENT_RE.test(execPath)) return { method: "brew" }
  // scoop / choco are deliberately NOT returned here. `latest()` and `upgrade()` still query
  // and install the upstream `opencode` package, so resolving an Altimate install to those
  // methods would pull in a DIFFERENT, upstream package. The old probe loop self-limited
  // because it required `scoop list opencode` to match; path matching has no such guard.
  if (SCOOP_SEGMENT_RE.test(execPath) || CHOCO_SEGMENT_RE.test(execPath)) return { method: "unknown" }
  if (STANDALONE_SEGMENT_RE.test(execPath)) return { method: "curl" }
  return { method: "unknown" }
}

/** realpath so a symlinked bin entry (brew's Cellar link, a shimmed standalone install)
 * resolves to the file it points at. Note npm's cached binary is a HARDLINK, which has
 * nothing to resolve — the path stays as-is, which is why detection matches the wrapper
 * package rather than relying on reaching the platform package.
 * Falls back to the raw path when the file is gone or unreadable. */
function realExecPath(): string {
  try {
    return fs.realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

/** bun's global PACKAGE root, derived from its shim directory.
 *
 * `bun pm bin -g` reports ~/.bun/bin, but globally installed packages live in a sibling
 * tree at ~/.bun/install/global/node_modules. Treating the shim dir as the package root
 * made every bun global install fail the ownership check as "not-global". */
export function bunGlobalRoot(bin: string): string {
  return bin ? path.join(path.dirname(bin), "install", "global", "node_modules") : ""
}

/** Resolve symlinks, tolerating paths that do not exist yet.
 *
 * Resolving only the paths that exist is not enough: on macOS a tmp/home path realpaths
 * from /var to /private/var, so comparing a resolved parent against an UNresolved child
 * reports "not inside" for a path that plainly is. Resolve the deepest existing ancestor
 * and re-append the remainder so both sides land in the same namespace. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    // fall through to the ancestor walk
  }
  const rest: string[] = []
  let cur = p
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return p
    rest.unshift(path.basename(cur))
    cur = parent
    try {
      return path.join(fs.realpathSync(cur), ...rest)
    } catch {
      // keep walking up
    }
  }
}

/** Separator-aware, symlink-resolved containment.
 *
 * Replaces a lowercased `startsWith`, which was wrong three ways: it matched
 * `/prefix/lib/node_modules-other` against `/prefix/lib/node_modules`, it resolved symlinks
 * on only one side (so a symlinked prefix — /var vs /private/var, nvm, asdf — falsely failed),
 * and lowercasing produced false matches on case-sensitive filesystems. `path.relative`
 * handles separators and platform case rules for us. */
export function isInside(child: string, parent: string): boolean {
  if (!parent || !child) return false
  const rel = path.relative(realpathOr(parent), realpathOr(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** NOTE: on Windows, `access(W_OK)` reflects the read-only ATTRIBUTE rather than the ACL,
 * so a directory the user genuinely cannot write can still report writable. That makes the
 * preflight a no-op there rather than a false block — we fall through to the old behaviour
 * (shell out, fail, report) instead of wrongly refusing an upgrade that would have worked. */
function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Mask credential-shaped substrings before diagnostics reach ANY log sink.
 *
 * The earlier version logged package-manager stdout/stderr verbatim on the reasoning that
 * the log file stays on the machine. That is false: `Logging.loggers()` adds a stderr
 * logger when OPENCODE_PRINT_LOGS=1, and `Otlp.loggers()` ships log records to a remote
 * collector whenever OTEL_EXPORTER_OTLP_ENDPOINT is set — neither redacts. npm/pnpm/yarn
 * error output routinely carries registry `_authToken` values and credentialed URLs.
 *
 * Conservative by design: over-masking a diagnostic is cheap, leaking a token is not. */
export function redactSecrets(input: string): string {
  if (!input) return input
  return (
    input
      // `//registry.npmjs.org/:_authToken=…` — the exact shape npm prints in ERESOLVE/E401
      // output and writes to .npmrc, which a plain `token=` pattern misses because of the
      // leading underscore and the registry prefix.
      .replace(/(_auth(?:Token)?|_password)\s*=\s*\S+/gi, "$1=[REDACTED]")
      // Whole authorization values, not just the Bearer scheme: `Basic dXNlcjpwYXNz` leaked
      // the encoded credential when only the scheme word was masked.
      .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(["']?)\S+.*$/gim, "$1$2[REDACTED]")
      .replace(/\b((?:bearer|basic|token)\s+)\S+/gi, "$1[REDACTED]")
      // Handles both `token=value` and JSON's `"token":"value"` — the quoted key form slipped
      // past a pattern that expected the key to be bare.
      .replace(
        /(["']?)(auth[-_]?token|authorization|api[-_]?key|access[-_]?token|password|passwd|secret|token)\1(\s*[:=]\s*)(["']?)[^\s"',}]+/gi,
        "$1$2$1$3$4[REDACTED]",
      )
      // Credentials embedded in a registry or git remote URL. Userinfo WITHOUT a colon is a
      // token too (`https://<token>@registry/...`), and the previous pattern required the
      // `user:pass` form so it let those through.
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
      // provider-prefixed tokens travel in git/registry errors and are not key=value shaped
      .replace(/\b(gh[pousr]_|github_pat_|glpat-|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, "$1[REDACTED]")
      // long opaque blobs: hex digests and base64-ish secrets
      .replace(/\b[0-9a-f]{32,}\b/gi, "[REDACTED]")
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]")
  )
}

/** Classify a failed upgrade into a stable code plus a message safe to show.
 *
 * Deliberately does NOT echo the package manager's stderr into the user-facing message — it
 * can carry tokens and environment. The classification is derived from it; the raw text is
 * logged only after redactSecrets() (see the logWarning/logInfo in upgrade()), because the
 * logger fans out to stderr and to OTLP and is NOT local-only. */
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

// altimate_change start — #1305: methods upgrade() refuses. Exported so every consumer
// rejects the same set instead of each maintaining its own list (they drifted: the v2 HTTP
// handler checked only "unknown" and 500'd on the rest).
export const UNSUPPORTED_UPGRADE_METHODS: Method[] = ["unknown", "yarn", "scoop", "choco"]
// altimate_change end

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
  // altimate_change start — #1305: verified owning package, or undefined when not ours
  readonly packageName: () => Effect.Effect<string | undefined>
  // altimate_change end
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
      // altimate_change start — #1305: only claim elevation when the failure actually looks
      // like a permission problem. Returning it unconditionally contradicted the classified
      // "Likely cause:" hint appended by the caller (e.g. a network failure reported as an
      // elevation problem).
      if (method === "choco" && (!result || classifyFailure(result.stderr, result.stdout).code === "permission"))
        return "not running from an elevated command shell"
      // altimate_change end
      // altimate_change start — do not echo package-manager/install-script stderr; it can contain tokens or env
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      // altimate_change end
      return `Upgrade failed for ${method}.`
    }

// altimate_change start — writability preflight (#1305)
    /** Directories a global install of `m` would mutate. Empty = nothing cheap to check. */
    /** Where a global install of `m` actually lives.
     *
     * `packageRoot` is the directory that CONTAINS the installed package — ownership is
     * decided against this and NEVER against the shim/bin directory. They are different
     * directories for bun (`bun pm bin -g` is ~/.bun/bin; packages live under
     * ~/.bun/install/global/node_modules) and for yarn, and conflating them rejected every
     * global bun install as "not-global".
     *
     * `writable` is the set of directories the upgrade actually writes, checked for
     * permission. A global install writes both the package tree and the shim dir. */
    const globalLayout = Effect.fnUntraced(function* (m: Method) {
      const empty = { packageRoot: "", writable: [] as string[] }
      switch (m) {
        case "npm": {
          // `npm root -g` is the portable package dir: on Windows packages live at
          // <prefix>/node_modules and the shims at <prefix> itself, so the unix
          // <prefix>/lib/node_modules is wrong there. `npm bin -g` was REMOVED in npm 9
          // ("Unknown command: bin"), so derive the bin dir from the prefix instead.
          const root = (yield* text(["npm", "root", "-g"])).trim()
          const prefix = (yield* text(["npm", "prefix", "-g"])).trim()
          const bin = prefix ? (process.platform === "win32" ? prefix : path.join(prefix, "bin")) : ""
          return { packageRoot: root, writable: [root, bin].filter(Boolean) }
        }
        case "pnpm": {
          const root = (yield* text(["pnpm", "root", "-g"])).trim()
          const bin = (yield* text(["pnpm", "bin", "-g"])).trim()
          return { packageRoot: root, writable: [root, bin].filter(Boolean) }
        }
        case "bun": {
          const bin = (yield* text(["bun", "pm", "bin", "-g"])).trim()
          return { packageRoot: bunGlobalRoot(bin), writable: [bunGlobalRoot(bin), bin].filter(Boolean) }
        }
        case "yarn": {
          // `yarn global dir` is the folder holding package.json + node_modules, not the
          // packages themselves.
          const dir = (yield* text(["yarn", "global", "dir"])).trim()
          const root = dir ? path.join(dir, "node_modules") : ""
          const bin = (yield* text(["yarn", "global", "bin"])).trim()
          return { packageRoot: root, writable: [root, bin].filter(Boolean) }
        }
        case "curl":
          // The install script always writes $HOME/.altimate/bin regardless of where the
          // running binary sits (`install`, INSTALL_DIR), so a legacy ~/.opencode/bin or
          // ~/.local/bin install must have the ACTUAL target checked.
          return { packageRoot: "", writable: [path.join(os.homedir(), ".altimate", "bin")] }
        // brew owns its own elevation and policy — do not second-guess it.
        default:
          return empty
      }
    })

    /** Ask `m` where its global packages live, then find which of OUR packages contains the
     * running binary. `undefined` means "not a global install of ours" — the safe answer.
     *
     * Affirmative by design. The previous version treated "the manager could not answer" as
     * permission to act, which made its documented guarantee false: a failed probe, or a
     * manager missing from PATH, authorised an `install -g` anyway. Nothing that mutates
     * runs without a positive answer now.
     *
     * It is also what stops us touching the WRONG tree: if a different `npm` is first on
     * PATH, its `npm root -g` does not contain our binary, so no package matches. */
    const owningPackage = Effect.fnUntraced(function* (m: Method) {
      if (!PACKAGE_MANAGERS.includes(m)) return undefined
      const layout = yield* globalLayout(m)
      return ownerOf(layout.packageRoot, realExecPath())
    })


    /** The package to install when upgrading. Uses the verified owner so an unscoped install
     * is upgraded with the unscoped name — installing the other one would leave a duplicate
     * and a stale original. Falls back to the scoped name only when a caller forced a method
     * explicitly and no owner could be confirmed. */
    const owningPackageOrScoped = Effect.fnUntraced(function* (m: Method) {
      return (yield* owningPackage(m)) ?? "@altimateai/altimate-code"
    })

    const remediation = (m: Method, dir: string, target: string, owner: string) => {
      // The name the manager confirmed owns this install — telling a user to reinstall the
      // other one would leave them with a duplicate and a stale original.
      const pkg = `${owner}@${target}`
      switch (m) {
        case "npm":
          // Windows has no sudo — tell those users to use an elevated shell instead.
          return process.platform === "win32"
            ? `Cannot write to the npm global prefix (${dir}). ` +
                `Re-run \`npm install -g ${pkg}\` from an elevated (Administrator) shell, ` +
                `or switch to a user-owned prefix with \`npm config set prefix\`.`
            : `Cannot write to the npm global prefix (${dir}). ` +
                `Run \`sudo npm install -g ${pkg}\`, or switch to a user-owned prefix ` +
                `with \`npm config set prefix ~/.npm-global\`.`
        case "pnpm":
          return (
            `Cannot write to the pnpm global directory (${dir}). ` +
            `Run \`pnpm setup\` to use a user-owned location, or re-run the install with elevated permissions.`
          )
        case "bun":
          return (
            `Cannot write to the bun global bin directory (${dir}). ` +
            `Set BUN_INSTALL to a user-owned location, or re-run the install with elevated permissions.`
          )
        case "yarn":
          return (
            `Cannot write to the yarn global directory (${dir}). ` +
            `Set a user-owned prefix with \`yarn config set prefix ~/.yarn\`, or re-run with elevated permissions.`
          )
        case "curl":
          return `Cannot write to the install directory (${dir}). Fix its permissions, or re-run the installer.`
        default:
          return `Cannot write to the install directory (${dir}).`
      }
    }

    /** A refusal carrying the classification code so the blocked attempt is still recorded
     * as that KIND of failure rather than vanishing from telemetry as "no attempt". */
    const preflightBlock = (code: string, message: string) => ({ code, message })

    /** Returns an error message when the upgrade cannot possibly succeed, else undefined.
     *
     * Checking first means we never shell out to a command that is going to fail on
     * permissions — which is what produced the old, undiagnosable
     * "Upgrade failed for npm (exit code 243)." */
    const preflight = Effect.fnUntraced(function* (m: Method, target: string) {
      const layout = yield* globalLayout(m)
      // Ownership is NOT re-checked here. `Installation.method()` already refuses to return
      // a package-manager identity unless the manager confirms it owns the running binary, so
      // every automatic path is covered before it gets this far. A caller that passes an
      // explicit `--method` is overriding detection deliberately; refusing it here would only
      // stop the user doing what they asked for, and would double the manager queries.
      for (const dir of layout.writable) {
        if (!dir) continue
        // A directory that does not exist yet is not a permission problem: the package
        // manager creates it. Only an EXISTING, unwritable directory is a hard stop.
        if (!fs.existsSync(dir)) continue
        if (!isWritable(dir)) {
          const owner = yield* owningPackageOrScoped(m)
          return preflightBlock("permission", remediation(m, dir, target, owner))
        }
      }
      return undefined
    })
    // altimate_change end

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
        // altimate_change start — resolve from the running binary instead of guessing (#1305).
        // Replaces a substring test on execPath plus a loop that spawned up to seven package
        // managers ("npm list -g", "brew list", ...) on the startup update-check path.
        const candidate = resolveInstall().method
        // A path match is a CANDIDATE, not proof of ownership: a project-local node_modules
        // is shaped exactly like a global one. Confirm it here rather than at the upgrade
        // boundary, because `cli/cmd/uninstall.ts` acts on this answer DESTRUCTIVELY and
        // never runs the upgrade preflight. Costs one manager query (two spawns for npm:
        // `root -g` and `prefix -g`) versus up to seven probes before, and only when the path
        // already looks like a package manager.
        if (PACKAGE_MANAGERS.includes(candidate)) {
          // No owning package found — a project-local install, a transitive dependency of
          // another global CLI, a manager we cannot query, or a foreign tree. Degrade to
          // notify-only rather than acting on a guess.
          const owner = yield* owningPackage(candidate)
          if (!owner) return "unknown" as Method
        }
        return candidate
      }),
      // altimate_change end
      // altimate_change start — #1305: the package the manager confirms owns this binary,
      // so upgrade and uninstall name the wrapper the user actually installed.
      packageName: Effect.fn("Installation.packageName")(function* () {
        const candidate = resolveInstall().method
        if (!PACKAGE_MANAGERS.includes(candidate)) return undefined
        return yield* owningPackage(candidate)
      }),
      // altimate_change end
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
        if (blocked) {
          // Record it the same way a real failure is recorded. Returning early without this
          // made the flagship permission case read as "no attempt" on dashboards — strictly
          // worse than the old behaviour, which at least ran the command and logged an error.
          yield* Effect.logWarning("upgrade blocked", { method: m, target, reason: blocked.code })
          const T0 = yield* Effect.promise(() => getTelemetry())
          T0.track({
            type: "upgrade_attempted",
            timestamp: Date.now(),
            session_id: T0.getContext().sessionId || "cli",
            from_version: InstallationVersion,
            to_version: target,
            method: (["npm", "bun", "brew"].includes(m) ? m : "other") as "npm" | "bun" | "brew" | "other",
            status: "error",
            error: `${blocked.code}: preflight`,
          })
          return yield* new UpgradeFailedError({ stderr: blocked.message })
        }
        // altimate_change end
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
            upgradeResult = yield* run(["npm", "install", "-g", `${yield* owningPackageOrScoped(m)}@${target}`])
            // altimate_change end
            break
          case "pnpm":
            // altimate_change start — pnpm package name
            upgradeResult = yield* run(["pnpm", "install", "-g", `${yield* owningPackageOrScoped(m)}@${target}`])
            // altimate_change end
            break
          case "bun":
            // altimate_change start — bun package name
            upgradeResult = yield* run(["bun", "install", "-g", `${yield* owningPackageOrScoped(m)}@${target}`])
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
          // altimate_change start — #1305: the scoop/choco branches ran `scoop install
          // opencode@…` / `choco upgrade opencode`, which install UPSTREAM's package, not
          // ours. Detection no longer returns these methods, but `--method` is free-form and
          // the CLI's prompt for unsupported methods is a confirm, not a refusal — so the
          // only reliable place to stop them is here, at the single choke point every
          // consumer goes through. `yarn` has never had an implementation.
          case "scoop":
          case "choco":
          case "yarn":
            return yield* new UpgradeFailedError({
              stderr:
                `Upgrading a ${m} installation is not supported. ` +
                `Re-install with \`${m}\` manually, or use npm, pnpm, bun, Homebrew or the install script.`,
            })
          // altimate_change end
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
            stdout: redactSecrets(upgradeResult?.stdout ?? ""),
            stderr: redactSecrets(upgradeResult?.stderr ?? ""),
          })
          const logFile = yield* Effect.promise(() => getLogFile())
          const base = upgradeFailure(m, upgradeResult)
          const stderr = [
            base,
            classified.hint ? `Likely cause: ${classified.hint}.` : undefined,
            logFile ? `Details were written to ${logFile}.` : undefined,
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
        // altimate_change start — #1305: this path has always logged raw subprocess output,
        // which fans out to stderr (OPENCODE_PRINT_LOGS=1) and to an OTLP collector when one
        // is configured. Redact here too — "the existing pattern already does this" is not a
        // reason for either path to keep doing it.
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: redactSecrets(upgradeResult.stdout),
          stderr: redactSecrets(upgradeResult.stderr),
        })
        // altimate_change end
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
        // altimate_change start — #1305: this call previously discarded its output, so an
        // upgrade that wrote to a DIFFERENT location than the running binary reported success
        // while the executable on disk was unchanged. We cannot fail the operation on this
        // (the package manager did succeed, and a version string can legitimately differ for
        // dev/branch builds), but it must not pass silently.
        const after = (yield* text([process.execPath, "--version"])).trim()
        const normalize = (v: string) => v.trim().replace(/^v/, "")
        if (after && normalize(after) !== normalize(target)) {
          yield* Effect.logWarning("upgrade did not change the running binary", {
            method: m,
            target,
            // Subprocess output — redacted like every other logged field. This one was added
            // in an earlier round of this change and missed the redactor.
            running: redactSecrets(after),
            execPath: process.execPath,
            hint: "the package manager wrote somewhere other than the running executable's location",
          })
        }
        // altimate_change end
      }),
    }

    return Service.of(result)
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer)))
// altimate_change end

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
// altimate_change start — #1305: the package the manager confirms owns the running binary.
// `uninstall` needs it for the same reason `upgrade` does: removing the wrong one of our two
// published wrappers silently removes nothing while the real install stays.
export const packageName = () => runPromise((s) => s.packageName())
// altimate_change end
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

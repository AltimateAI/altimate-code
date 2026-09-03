#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "node:module"
import solidPlugin from "@opentui/solid/bun-plugin"
// altimate_change — #1052 D10: sha256 for the per-target build-inputs stamp.
import { createHash } from "node:crypto"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
import { walkInputs } from "./stamp-inputs"
import { assertUsableCatalog, catalogDiagnosticOrigin, formatCatalogSummary } from "./models-catalog"
import { FreeTierUrl } from "../src/altimate/free/url"

// Python engine has been eliminated — all methods run natively in TypeScript.
// ALTIMATE_ENGINE_VERSION is no longer needed at runtime.

// Read CHANGELOG.md for bundling
const changelogPath = path.resolve(dir, "../../CHANGELOG.md")
const changelog = fs.existsSync(changelogPath) ? await Bun.file(changelogPath).text() : ""
console.log(`Loaded CHANGELOG.md (${changelog.length} chars)`)

// altimate_change start — inject the official Altimate Base endpoint at release time
const rawAltimateBaseGatewayUrl = process.env.ALTIMATE_BASE_GATEWAY_URL?.trim() ?? ""
const altimateBaseGatewayUrl = rawAltimateBaseGatewayUrl
  ? FreeTierUrl.normalizeGatewayUrl(rawAltimateBaseGatewayUrl)
  : undefined
if (rawAltimateBaseGatewayUrl && !altimateBaseGatewayUrl) {
  console.error("error: ALTIMATE_BASE_GATEWAY_URL must be HTTPS and contain no credentials, query, or fragment")
  process.exit(1)
}
if (Script.release && !altimateBaseGatewayUrl) {
  console.error("error: release builds require ALTIMATE_BASE_GATEWAY_URL")
  process.exit(1)
}
// altimate_change end

const modelsUrlOverride = process.env.OPENCODE_MODELS_URL || undefined
const modelsUrl = modelsUrlOverride ?? "https://models.dev"

const CATALOG_FETCH_TIMEOUT_MS = 60_000
// The hard backstop must lose the race to `AbortSignal.timeout` in every case the
// signal CAN handle, or it fires first and replaces the precise per-stage message
// ("fetch failed", "body read failed") with its own generic one. The margin is
// what makes it a backstop rather than the primary timeout.
const CATALOG_HARD_DEADLINE_MS = CATALOG_FETCH_TIMEOUT_MS + 15_000

/** Fetch the models.dev catalog, failing loudly rather than hanging or
 * returning an error page.
 *
 * `fetch` resolves for 4xx/5xx, so without the `res.ok` check a load-balancer
 * error page flows straight into the snapshot. An HTML body would at least break
 * the build at parse time, but a JSON error body (`{"error": ...}`) is valid
 * TypeScript and would ship as a catalog with no providers in it. */
async function fetchModelsCatalog(url: string, diagnosticOrigin: string): Promise<string> {
  // Backstop for the case where the abort signal fires but the fetch promise never
  // settles, so the `catch` below is never reached. `AbortSignal.timeout` cannot
  // cancel a blocked `getaddrinfo()` — documented in src/provider/models.ts
  // (#1052 D14), where a sandboxed-network DNS blackhole outlived the signal.
  //
  // HONEST LIMIT: this is a timer on the event loop, so it cannot preempt a
  // genuinely blocked main thread either. If `getaddrinfo` blocks the loop
  // outright, neither the signal nor this fires and the workflow `timeout-minutes`
  // stays the real backstop. What this does cover is the more common shape — the
  // loop still ticking while a request hangs unresolved — turning a silent
  // full-length job timeout into a fast, labelled failure. Either way the build
  // fails; it never falls through to a stale catalog.
  const deadline = setTimeout(() => {
    console.error(
      `error: models.dev fetch from ${diagnosticOrigin} did not settle within ${CATALOG_HARD_DEADLINE_MS}ms ` +
        `(host unreachable or unresolvable); failing the build`,
    )
    process.exit(1)
  }, CATALOG_HARD_DEADLINE_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) })
    } catch {
      throw new Error(
        `models.dev fetch from ${diagnosticOrigin} failed or timed out after ${CATALOG_FETCH_TIMEOUT_MS}ms`,
      )
    }
    if (!res.ok)
      throw new Error(`models.dev fetch failed: HTTP ${res.status} ${res.statusText} from ${diagnosticOrigin}`)
    try {
      // Inside its own try: a host that sends headers promptly then stalls
      // mid-body aborts here, and an uncaught abort surfaces as a bare
      // AbortError carrying none of the context above.
      return await res.text()
    } catch {
      throw new Error(
        `models.dev body read from ${diagnosticOrigin} failed or timed out after ${CATALOG_FETCH_TIMEOUT_MS}ms`,
      )
    }
  } finally {
    clearTimeout(deadline)
  }
}

async function readModelsCatalog(file: string, diagnosticOrigin: string): Promise<string> {
  try {
    return await Bun.file(file).text()
  } catch {
    throw new Error(`models.dev catalog read from ${diagnosticOrigin} failed`)
  }
}

// Fetch and generate models.dev snapshot. MODELS_DEV_API_JSON pins the catalog to
// a local file for hermetic builds (ci.yml, pre-release-check.ts); release builds
// leave it unset so the shipped binary embeds a release-time catalog.
// `|| undefined` rather than `??`: an env var that is SET BUT EMPTY has to read as
// unset, or the origin keeps "" while the data branch falls through to the fetch
// and the build dies on `fetch("")` with ERR_INVALID_URL.
const modelsFile = process.env.MODELS_DEV_API_JSON || undefined
const modelsOrigin = modelsFile ?? `${modelsUrl}/api.json`
const modelsDiagnosticOrigin = catalogDiagnosticOrigin(modelsOrigin, modelsFile ? "file" : "url")
const modelsData = modelsFile
  ? await readModelsCatalog(modelsFile, modelsDiagnosticOrigin)
  : await fetchModelsCatalog(modelsOrigin, modelsDiagnosticOrigin)
// A release is held to the full floor however its catalog was sourced, so pointing
// a release build at a custom catalog cannot quietly skip the size and
// required-provider checks.
const strictCatalog = !!process.env.OPENCODE_RELEASE || (!modelsFile && !modelsUrlOverride)
const catalogSummary = assertUsableCatalog(modelsData, modelsDiagnosticOrigin, strictCatalog)
console.log(formatCatalogSummary(catalogSummary, modelsDiagnosticOrigin))
await Bun.write(
  path.join(dir, "src/provider/models-snapshot.ts"),
  `// Auto-generated by build.ts - do not edit\nexport const snapshot = ${modelsData.trim()} as const\n`,
)
console.log("Generated models-snapshot.ts")

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

// Load builtin skills from .opencode/skills/ directory for embedding in binary.
// This ensures skills are available in ALL distribution channels (npm, Homebrew, AUR, Docker)
// without relying on postinstall filesystem copies.
const skillsRoot = path.resolve(dir, "../../.opencode/skills")
const skillEntries = fs.existsSync(skillsRoot)
  ? (await fs.promises.readdir(skillsRoot, { withFileTypes: true })).filter((e) => e.isDirectory())
  : []

const builtinSkills: { name: string; content: string }[] = []
for (const entry of skillEntries) {
  const skillFile = path.join(skillsRoot, entry.name, "SKILL.md")
  if (!fs.existsSync(skillFile)) continue
  const content = await Bun.file(skillFile).text()
  builtinSkills.push({ name: entry.name, content })
}
console.log(`Loaded ${builtinSkills.length} builtin skills`)
if (Script.release && builtinSkills.length === 0) {
  console.error("No builtin skills were loaded from ../../.opencode/skills; aborting release build.")
  process.exit(1)
}

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")

// Build targets are limited to the platforms for which @altimateai/altimate-core
// publishes a NAPI prebuild (see
// https://www.npmjs.com/package/@altimateai/altimate-core?activeTab=dependencies).
// Each per-target build embeds that prebuild's .node file directly into the Bun
// single-file executable so the release archive ships a single self-contained
// binary — no companion node_modules, no NODE_PATH wrapper.
//
// Combinations with no altimate-core prebuild are intentionally excluded:
//   • linux-*-musl (no @altimateai/altimate-core-linux-*-musl)
//   • win32-arm64  (no @altimateai/altimate-core-win32-arm64-msvc)
// If/when altimate-core ships prebuilds for those, add them back here.
const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

// If --targets is provided, filter to only matching OS values
const validOsValues = new Set(allTargets.map((t) => t.os))
const targetsFlag = process.argv
  .find((a) => a.startsWith("--targets="))
  ?.split("=")[1]
  ?.split(",")
if (targetsFlag) {
  const invalid = targetsFlag.filter((t) => !validOsValues.has(t))
  if (invalid.length > 0) {
    console.error(
      `error: invalid --targets value(s): ${invalid.join(", ")}. Valid values: ${[...validOsValues].join(", ")}`,
    )
    process.exit(1)
  }
}

// --target-index=N builds a single target by index (for parallel CI matrix)
const targetIndexFlag = process.argv.find((a) => a.startsWith("--target-index="))?.split("=")[1]

const targets =
  targetIndexFlag !== undefined
    ? [allTargets[parseInt(targetIndexFlag, 10)]].filter(Boolean)
    : singleFlag
      ? allTargets.filter((item) => {
          if (item.os !== process.platform || item.arch !== process.arch) {
            return false
          }

          // When building for the current platform, prefer a single native binary by default.
          // Baseline binaries require additional Bun artifacts and can be flaky to download.
          if (item.avx2 === false) {
            return baselineFlag
          }

          // also skip abi-specific builds for the same reason
          if (item.abi !== undefined) {
            return false
          }

          return true
        })
      : targetsFlag
        ? allTargets.filter((t) => targetsFlag.includes(t.os))
        : allTargets

// Defense in depth: refuse to produce no artifacts at all, and refuse to build
// the glibc target on a musl host where the binary would crash at startup.
//
// Why it matters:
//   - `--target-index=N` for an index that no longer exists (after the
//     musl/win32-arm64 cull) silently yields an empty `targets` array. Without
//     this guard the build "succeeds" with zero output and CI proceeds.
//   - `--single` only filters on os/arch, not libc. On Alpine that matches
//     `linux-x64` (glibc), produces a glibc binary that the musl host can't
//     load, and dies later with a cryptic linker error.
if (targets.length === 0) {
  const reason =
    targetIndexFlag !== undefined
      ? `--target-index=${targetIndexFlag} is out of range (allTargets has ${allTargets.length} entries — musl/win32-arm64 were removed).`
      : singleFlag
        ? `--single found no entry in allTargets matching ${process.platform}/${process.arch} (host may be excluded — see allTargets at the top of build.ts).`
        : targetsFlag
          ? `--targets=${targetsFlag.join(",")} matched nothing in allTargets.`
          : "allTargets is empty."
  console.error(`error: no build targets selected. ${reason}`)
  process.exit(1)
}

if (singleFlag && process.platform === "linux") {
  const isMuslHost = (() => {
    try {
      if (fs.existsSync("/etc/alpine-release")) return true
    } catch {}
    try {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
      const r = spawnSync("ldd", ["--version"], { encoding: "utf8" })
      const text = ((r.stdout ?? "") + (r.stderr ?? "")).toLowerCase()
      if (text.includes("musl")) return true
    } catch {}
    return false
  })()
  if (isMuslHost) {
    console.error(
      "error: --single on a musl-linux host would build the glibc target and produce a binary the host cannot run.",
    )
    console.error(
      "       altimate-core has no NAPI prebuild for musl yet. Build on a glibc host, or install via `apk add gcompat` + the npm wrapper.",
    )
    process.exit(1)
  }
}

await $`rm -rf dist`

// Packages excluded from the compiled binary — must be resolvable from
// node_modules at runtime.
//
// NOTE: @altimateai/altimate-core is intentionally NOT external. We replace
// its NAPI-RS loader with a one-line shim per target (see below) so Bun
// statically sees a single `require('./altimate-core.<platform>.node')` and
// embeds that one .node file into bunfs. This keeps the binary self-contained
// without bloating it with 5 platforms' worth of native addons.
const requiredExternals: string[] = []
const optionalExternals = [
  // Database drivers — native addons, users install on demand per warehouse.
  // Must stay in step with DRIVER_PACKAGES in packages/drivers/src/resolve.ts:
  // a driver package that is missing here gets bundled into the binary, so the
  // on-demand install path never runs for it and the bundled copy is frozen at
  // whatever version built the release.
  "pg",
  "snowflake-sdk",
  "@google-cloud/bigquery",
  "@databricks/sql",
  "mysql2",
  "mssql",
  "oracledb",
  "duckdb",
  "mongodb",
  "@clickhouse/client",
  "trino-client",
  // Optional infra packages — native addons or heavy optional deps.
  // @azure/identity is dynamically imported by the sqlserver driver for Azure
  // AD auth; it resolves through the same on-disk loader as the drivers.
  "keytar",
  "ssh2",
  "dockerode",
  "@azure/identity",
]

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  // Ensure every @altimateai/altimate-core platform prebuild is resolvable in
  // node_modules. Each per-target build below picks one and embeds its .node
  // file into the Bun binary.
  await $`bun install --os="*" --cpu="*" @altimateai/altimate-core@${pkg.dependencies["@altimateai/altimate-core"]}`
}

// Map a build target to the altimate-core NAPI prebuild package name and the
// matching `.node` file name. The mapping mirrors the lines in altimate-core's
// NAPI-RS-generated loader (e.g. `require('./altimate-core.linux-x64-gnu.node')`).
// Baseline variants share the same prebuild as their non-baseline counterpart —
// "baseline" is a Bun-binary distinction, not a NAPI one.
function altimateCorePlatformFor(item: { os: string; arch: "arm64" | "x64"; abi?: "musl" }): {
  pkg: string
  nodeFile: string
  platformTag: string
} {
  if (item.abi === "musl") {
    throw new Error(
      `No @altimateai/altimate-core prebuild for linux-${item.arch}-musl; this target should not be in allTargets.`,
    )
  }
  if (item.os === "darwin") {
    const tag = `darwin-${item.arch}`
    return { pkg: `@altimateai/altimate-core-${tag}`, nodeFile: `altimate-core.${tag}.node`, platformTag: tag }
  }
  if (item.os === "linux") {
    const tag = `linux-${item.arch}-gnu`
    return { pkg: `@altimateai/altimate-core-${tag}`, nodeFile: `altimate-core.${tag}.node`, platformTag: tag }
  }
  if (item.os === "win32") {
    if (item.arch === "x64") {
      const tag = "win32-x64-msvc"
      return { pkg: `@altimateai/altimate-core-${tag}`, nodeFile: `altimate-core.${tag}.node`, platformTag: tag }
    }
    throw new Error(
      `No @altimateai/altimate-core prebuild for win32-${item.arch}; this target should not be in allTargets.`,
    )
  }
  throw new Error(`Unsupported build target: ${item.os}-${item.arch}`)
}

// Resolve the loader package once up-front. Real path (not the bun symlink in
// node_modules/.bun) — we copy from this for each per-target staging dir.
const altimateCoreLoaderPkgJson = fileURLToPath(import.meta.resolve("@altimateai/altimate-core/package.json"))
const altimateCoreLoaderDir = fs.realpathSync(path.dirname(altimateCoreLoaderPkgJson))

// Pin: the version actually on disk must match what package.json declares.
// `bun install --os=* --cpu=*` hoists into `node_modules/.bun/` and re-links
// the top-level entry, but a previous hoist for an older version can linger.
// Asserting here catches the case where the build silently embeds yesterday's
// .node into today's release archive.
{
  const expected = pkg.dependencies["@altimateai/altimate-core"]
  const resolvedVersion = JSON.parse(fs.readFileSync(path.join(altimateCoreLoaderDir, "package.json"), "utf8")).version
  if (resolvedVersion !== expected) {
    throw new Error(
      `build.ts: resolved @altimateai/altimate-core version ${resolvedVersion} ` +
        `does not match package.json (${expected}). ` +
        `Run 'rm -rf node_modules bun.lock && bun install' to refresh the hoist.`,
    )
  }
}

// A `require` rooted at the loader's index.js so we can resolve sibling
// `@altimateai/altimate-core-<platform>` packages without hand-walking bun's
// `.bun/` flat layout. Node's resolution walks parent node_modules from the
// require base, which (in bun's hoisted layout used by this project) reaches
// the top-level `node_modules/@altimateai/altimate-core-<platform>` symlinks.
const altimateCoreLoaderRequire = createRequire(path.join(altimateCoreLoaderDir, "index.js"))

// Extract the `_requiredExports` literal from the upstream NAPI-RS loader so
// the generated single-platform shim can keep the same correctness check
// (catches a stale or truncated .node file at startup with a clear error
// instead of a confusing "method is not a function" later). Pin the exact
// shape we expect — if the loader format changes, abort the build rather
// than silently shipping a shim with no validation.
const altimateCoreLoaderSource = fs.readFileSync(path.join(altimateCoreLoaderDir, "index.js"), "utf8")
const requiredExportsMatch = altimateCoreLoaderSource.match(/const _requiredExports = (\[[\s\S]*?\])/)
if (!requiredExportsMatch) {
  throw new Error(
    "build.ts: could not extract _requiredExports from @altimateai/altimate-core/index.js. " +
      "The upstream NAPI-RS loader format changed — update the regex (see script/build.ts).",
  )
}
// Parse and validate: the captured literal must be a pure JSON array of
// non-empty string literals. The regex above would happily match
// `["x"]; <attacker code>; const _foo = [` and the matched group would
// then be inlined verbatim into the staged shim — embedding attacker JS
// into our shipped binary. Strict parse + shape-check refuses any value
// that isn't a string-array.
let altimateCoreRequiredExportsLiteral: string
try {
  const parsed = JSON.parse(requiredExportsMatch[1])
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((n) => typeof n === "string" && n.length > 0 && n.length < 200)
  ) {
    throw new Error("not an array of non-empty short string literals")
  }
  // Re-serialize so the shim is built from validated data, not the raw match.
  altimateCoreRequiredExportsLiteral = JSON.stringify(parsed)
} catch (err) {
  throw new Error(
    `build.ts: _requiredExports literal from @altimateai/altimate-core/index.js failed validation: ${
      err instanceof Error ? err.message : String(err)
    }. Refusing to inline into the staged shim.`,
  )
}

// Locate the on-disk dir for an @altimateai/altimate-core-<platform> NAPI
// prebuild. Use createRequire rooted at the loader's index.js — Node's
// require.resolve walks parent node_modules from the require base, which
// reaches both bun's hoisted top-level @altimateai/altimate-core-<platform>
// symlinks and any nested layout.
function locatePlatformPackageDir(pkgName: string): string {
  const pkgJsonPath = altimateCoreLoaderRequire.resolve(`${pkgName}/package.json`)
  return fs.realpathSync(path.dirname(pkgJsonPath))
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const opentuiCoreDir = path.dirname(fileURLToPath(import.meta.resolve("@opentui/core")))
  const parserWorker = fs.realpathSync(path.join(opentuiCoreDir, "parser.worker.js"))
  // altimate_change start — upstream_fix: TUI tree relocated cli/cmd/tui -> cli/tui in this merge;
  // build entry path must follow (was ./src/cli/cmd/tui/worker.ts -> ModuleNotFound at build).
  const workerPath = "./src/cli/tui/worker.ts"
  // altimate_change end

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  // -------------------------------------------------------------------------
  // Stage a per-target copy of @altimateai/altimate-core so we can embed the
  // target's NAPI prebuild into the Bun single-file executable.
  //
  // The upstream NAPI-RS loader (index.js) dispatches at runtime across every
  // supported platform — referencing each `./altimate-core.<platform>.node`
  // and `@altimateai/altimate-core-<platform>` from `require()`. If we hand
  // that loader to Bun.build as-is, Bun statically resolves every branch and
  // either bloats the binary with 5 platforms' worth of .node files or fails
  // when a non-target platform package isn't on disk.
  //
  // Instead we replace the loader with a one-line shim:
  //
  //     module.exports = require('./altimate-core.<platform>.node')
  //
  // and drop the matching .node file next to it. Bun sees a single static
  // require() and embeds that one .node into bunfs. Result: self-contained
  // ~80–100 MB binary, no companion files, no NODE_PATH.
  // -------------------------------------------------------------------------
  const platform = altimateCorePlatformFor(item)
  const platformPkgDir = locatePlatformPackageDir(platform.pkg)
  const platformNodeSrc = path.join(platformPkgDir, platform.nodeFile)
  if (!fs.existsSync(platformNodeSrc)) {
    throw new Error(`Expected NAPI prebuild not found: ${platformNodeSrc}. Did 'bun install --os=* --cpu=*' run?`)
  }

  const stagedAltimateCoreDir = path.join(dir, "dist", name, ".altimate-core-staged", "@altimateai", "altimate-core")
  // Pre-loop cleanup: a previous build that crashed between staging and the
  // post-build cleanup would leave a stale `.altimate-core-staged/` here.
  // Without this, the next build could see the old shim and (if onResolve
  // regresses) embed yesterday's .node. Wipe before staging fresh.
  await $`rm -rf dist/${name}/.altimate-core-staged`
  await $`mkdir -p ${stagedAltimateCoreDir}`
  // Keep index.d.ts + package.json so typecheck and resolution stay happy.
  fs.copyFileSync(path.join(altimateCoreLoaderDir, "package.json"), path.join(stagedAltimateCoreDir, "package.json"))
  if (fs.existsSync(path.join(altimateCoreLoaderDir, "index.d.ts"))) {
    fs.copyFileSync(path.join(altimateCoreLoaderDir, "index.d.ts"), path.join(stagedAltimateCoreDir, "index.d.ts"))
  }
  // The shim — single static require() of the target's .node file plus the
  // same _requiredExports correctness check the upstream NAPI-RS loader does.
  fs.writeFileSync(
    path.join(stagedAltimateCoreDir, "index.js"),
    `// Generated by packages/opencode/script/build.ts for ${name}.\n` +
      `// Replaces the multi-platform NAPI-RS loader so Bun embeds exactly one .node.\n` +
      `const nativeBinding = require('./${platform.nodeFile}')\n` +
      `const _requiredExports = ${altimateCoreRequiredExportsLiteral}\n` +
      `const _missing = _requiredExports.filter((n) => typeof nativeBinding[n] !== 'function')\n` +
      `if (_missing.length > 0) {\n` +
      `  throw new Error(\n` +
      `    '@altimateai/altimate-core: embedded NAPI binary missing ' + _missing.length + ' export(s): ' +\n` +
      `    _missing.slice(0, 5).join(', ') + (_missing.length > 5 ? '...' : '')\n` +
      `  )\n` +
      `}\n` +
      `module.exports = nativeBinding\n`,
  )
  // The actual native binding, co-located so the shim's relative require() resolves.
  fs.copyFileSync(platformNodeSrc, path.join(stagedAltimateCoreDir, platform.nodeFile))

  // Bun.build plugin: rewrite @altimateai/altimate-core imports to the staged
  // shim. Without this, Bun resolves the import via the workspace
  // node_modules and we'd be back to the full multi-platform loader.
  const stagedShimAbs = path.join(stagedAltimateCoreDir, "index.js")
  const altimateCoreResolverPlugin = {
    name: "altimate-core-staged-resolver",
    setup(build: any) {
      build.onResolve({ filter: /^@altimateai\/altimate-core$/ }, () => ({
        path: stagedShimAbs,
      }))
    },
  }

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin, altimateCoreResolverPlugin],
    sourcemap: "external",
    // IMPORTANT: Without code splitting, Bun inlines dynamic import() targets
    // into the main chunk. Any external require() in those targets will fail
    // at startup — not when the import() is called. Only mark packages as
    // external when they truly cannot be bundled (e.g. NAPI native addons).
    external: [...requiredExternals, ...optionalExternals],
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      // Load-bearing for the optional drivers above: it is what lets the
      // compiled binary resolve an `external` package from node_modules on
      // disk at runtime. Verified by compiling with and without it — without
      // it every driver import fails inside bunfs, whatever NODE_PATH says.
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/altimate`,
      execArgv: [`--user-agent=altimate/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    entrypoints: ["./src/index.ts", parserWorker, workerPath],
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      // altimate_change — official default is release configuration; runtime env can still override it
      ALTIMATE_BASE_DEFAULT_GATEWAY_URL: JSON.stringify(altimateBaseGatewayUrl ?? ""),
      // ALTIMATE_ENGINE_VERSION removed — Python engine eliminated
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OPENCODE_BUILTIN_SKILLS: JSON.stringify(builtinSkills),
      OPENCODE_CHANGELOG: JSON.stringify(changelog),
      OPENCODE_WORKER_PATH: workerPath,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    },
  })

  // Staging dir is no longer needed once Bun has embedded the shim + .node.
  await $`rm -rf dist/${name}/.altimate-core-staged`

  // Create backward-compatible altimate-code alias inside the platform package.
  // The npm wrapper (`packages/opencode/bin/altimate`) looks for `bin/altimate-code`
  // (or .exe) when locating the platform binary, so this must exist for the
  // `npm i -g` flow. The release archive below ships only `altimate`.
  // Use a hard copy instead of a symlink — npm publish and Docker COPY can
  // strip symlinks, causing "Binary not found" in Verdaccio sanity tests.
  if (item.os === "win32") {
    await $`cp dist/${name}/bin/altimate.exe dist/${name}/bin/altimate-code.exe`.nothrow()
  } else {
    await $`cp dist/${name}/bin/altimate dist/${name}/bin/altimate-code`.nothrow()
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
        // altimate_change start — do not publish the orphaned sourcemaps.
        // `Bun.build` above runs with `sourcemap: "external"`, so it writes
        // `index.js.map` / `worker.js.map` next to the binary — but the bundles
        // they describe are compiled INTO the executable, so the package shipped
        // `.map` files with no `.js` companion: unusable by any consumer that
        // follows `sourceMappingURL`, and not read by the binary at runtime
        // (verified — it runs and reports errors normally with them deleted).
        // They cost 20MB of a 191MB tarball against npm's ~200MB E413 ceiling.
        // Keep emitting them for local debugging of `dist/`; keep them out of
        // what we publish.
        // `**` because `*` does not descend: a `.map` emitted under a
        // `bin/<subdir>/` would still ship. Note the allowlist also means any
        // future artifact added OUTSIDE `bin/` is silently dropped from the
        // published package. (review)
        files: ["bin", "!bin/**/*.map"],
        // altimate_change end
      },
      null,
      2,
    ),
  )

  // altimate_change start — #1052 D10: emit a build-inputs stamp so the
  // smoke-test staleness guard can compare against ALL binary-embedded inputs,
  // not just src/ + script/ mtimes.
  //
  // The previous guard (m5) walked src/ + script/ for the newest mtime — good
  // for the common case but blind to changes in CHANGELOG.md, migrations,
  // bundled skills, the models.dev snapshot, the parser worker, and the
  // per-platform altimate-core prebuild. Editing any of those without touching
  // a .ts file would leave the guard silent and the binary silently stale.
  //
  // Stamp format: JSON with one entry per input, sha256 of file content. Read
  // side rehashes each listed path and compares; any mismatch → stale. Paths
  // are REPO_ROOT-relative so entries under packages/tui, packages/core, the
  // workspace-root package.json, bun.lock, etc. resolve without munging.
  const REPO_ROOT = path.resolve(dir, "../..")
  const stampInputs: Array<{ path: string; sha256: string }> = []
  const addFile = (absPath: string) => {
    try {
      const buf = fs.readFileSync(absPath)
      const rel = path.relative(REPO_ROOT, absPath)
      const hash = createHash("sha256").update(buf).digest("hex")
      stampInputs.push({ path: rel, sha256: hash })
    } catch {
      // Missing file: silently skip. The stamp only covers what actually
      // shipped; a file the build didn't need doesn't invalidate the guard.
    }
  }
  // CHANGELOG.md
  addFile(changelogPath)
  // Migrations
  for (const m of migrationDirs) addFile(path.join(dir, "migration", m, "migration.sql"))
  // Skills bundled via .opencode/skills/
  for (const entry of skillEntries) addFile(path.join(skillsRoot, entry.name, "SKILL.md"))
  // Generated models snapshot (build.ts rewrote it before we got here)
  addFile(path.join(dir, "src/provider/models-snapshot.ts"))
  // opentui parser worker
  addFile(parserWorker)
  // Per-target altimate-core NAPI prebuild
  addFile(platformNodeSrc)
  // altimate_change — #1052 D10 review-fix (M2): package.json + bun.lock cover
  // dependency-version bumps that change what Bun.build embeds. Without these,
  // `bun install` bumping a bundled dep would leave the stamp reporting fresh.
  // Sibling workspace manifests are added in the packages walk below; this
  // package's own manifest is added here, because that walk skips `opencode`
  // (its src/ and script/ trees are already covered) and would otherwise leave
  // `imports`, `exports` and other bundler-relevant fields unstamped.
  addFile(path.join(REPO_ROOT, "package.json"))
  addFile(path.join(REPO_ROOT, "bun.lock"))
  addFile(path.join(dir, "package.json"))
  // Also include tsconfig files that affect compiled output shape
  // (bot review: tsconfig changes can flip target/moduleResolution).
  addFile(path.join(dir, "tsconfig.json"))
  // src/ + script/ TypeScript tree — hash every file the compiler actually saw.
  // The walk rules live in ./build-inputs so the smoke-test guard can
  // re-enumerate with identical rules and notice files ADDED after the build.
  const walkedRoots: string[] = []
  const walk = (root: string): void => {
    if (!fs.existsSync(root)) return
    walkedRoots.push(path.relative(REPO_ROOT, root))
    for (const file of walkInputs(root)) addFile(file)
  }
  walk(path.join(dir, "src"))
  walk(path.join(dir, "script"))
  // altimate_change — #1052 D10 review-fix (M2): also hash every workspace
  // package's src/ tree. `packages/opencode/src` imports from
  // `@opencode-ai/{core,tui,util,plugin,sdk,server,cli,...}` and
  // `@altimateai/{dbt-tools,drivers}` — Bun.build follows these imports and
  // bundles them into the binary transitively. The original stamp walked only
  // packages/opencode, so edits under any sibling workspace package would leave
  // the binary silently stale. Enumerate `packages/*/src` at build time (rather
  // than hard-coding names) so new packages get covered automatically.
  const packagesRoot = path.resolve(REPO_ROOT, "packages")
  try {
    for (const pkg of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue
      // Skip packages/opencode — already covered by the walks above.
      if (pkg.name === "opencode") continue
      const pkgSrc = path.join(packagesRoot, pkg.name, "src")
      if (fs.existsSync(pkgSrc)) walk(pkgSrc)
      // Each workspace package.json influences its resolution/exports and could
      // change what ends up in the binary even when its src/ files are unchanged.
      const pkgJson = path.join(packagesRoot, pkg.name, "package.json")
      if (fs.existsSync(pkgJson)) addFile(pkgJson)
    }
  } catch {
    // packages/ missing (unlikely at build time) — skip; addFile() ignores non-existent paths anyway.
  }
  // Deterministic order so the aggregate hash is stable across build runs.
  stampInputs.sort((a, b) => a.path.localeCompare(b.path))
  const aggregate = createHash("sha256")
    .update(stampInputs.map((i) => `${i.path}\t${i.sha256}`).join("\n"))
    .digest("hex")
  await Bun.file(`dist/${name}/bin/build-inputs.json`).write(
    JSON.stringify(
      {
        target: name,
        version: Script.version,
        aggregate,
        // Roots the walk covered, so the read side can detect files added after
        // the build rather than only rehashing what was present at build time.
        roots: [...new Set(walkedRoots)].sort(),
        // Glob form so the read side notices a package added AFTER this build;
        // concrete roots only describe what existed while it ran.
        rootGlobs: ["packages/*/src"],
        inputs: stampInputs,
      },
      null,
      2,
    ),
  )
  // altimate_change end

  binaries[name] = Script.version
}

// ---------------------------------------------------------------------------
// Build-time verification: ensure required externals are in package.json
// dependencies so they ship with the npm wrapper package. This catches the
// scenario where a new NAPI module is added to `external` but not to
// package.json dependencies — which would compile fine but crash at runtime.
// ---------------------------------------------------------------------------
{
  // Only check dependencies (not devDependencies) — publish.ts only ships
  // dependencies to end users. A required external in devDependencies would
  // pass this check but be missing for npm users.
  const pkgDeps: Record<string, string> = {
    ...pkg.dependencies,
  }
  const missing = requiredExternals.filter((ext) => !pkgDeps[ext])
  if (missing.length > 0) {
    const msg =
      `Required external(s) not in package.json: ${missing.join(", ")}\n` +
      `These packages are marked as external in the binary build but are not\n` +
      `listed as dependencies. The binary will crash at runtime.\n` +
      `Add them to "dependencies" in packages/opencode/package.json.`
    if (Script.release) {
      console.error(`FATAL: ${msg}`)
      process.exit(1)
    } else {
      console.warn(`WARNING: ${msg}`)
    }
  } else {
    console.log(`Verified ${requiredExternals.length} required external(s) are in package.json`)
  }
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    // Archive name maps the platform package name (`@altimateai/altimate-code-<target>`)
    // to a standalone-archive prefix (`altimate-<target>`). The curl-install
    // script (`install` at repo root) expects this prefix and unpacks a single
    // binary named `altimate` — matching the primary npm bin entry.
    const archiveName = key.replace(/^@altimateai\/altimate-code-/, "altimate-")
    const archivePath = path.resolve("dist", archiveName)
    // Name construction at line 283 substitutes `win32 → windows`, so the key
    // contains "windows", not "win32". Matching the wrong substring here would
    // archive a non-existent `altimate` file on Windows targets.
    const binaryName = key.includes("windows") ? "altimate.exe" : "altimate"
    if (key.includes("linux")) {
      await $`tar -czf ${archivePath}.tar.gz ${binaryName}`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip ${archivePath}.zip ${binaryName}`.cwd(`dist/${key}/bin`)
    }
  }

  // altimate_change start — de-dupe the platform npm package. The compiled binary is written
  // as both `altimate` and `altimate-code` (a hard copy, ~230MB each). The standalone `altimate`
  // is only needed for the release ARCHIVE above (curl-install unpacks `altimate`); the npm
  // platform package is resolved by the wrapper via `altimate-code` only. Shipping both doubled
  // the package and pushed linux platform packages past npm's tarball limit (E413 Payload Too
  // Large). Now that each archive is created, drop the redundant `altimate` from what npm ships.
  for (const key of Object.keys(binaries)) {
    const binDir = `dist/${key}/bin`
    if (key.includes("windows")) await $`rm -f ${binDir}/altimate.exe`.nothrow()
    else await $`rm -f ${binDir}/altimate`.nothrow()
  }
  // altimate_change end
}

export { binaries }

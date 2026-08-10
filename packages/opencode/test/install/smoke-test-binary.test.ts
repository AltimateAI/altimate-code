/**
 * Smoke tests for compiled binaries.
 *
 * These tests build a local binary (--single) and verify it actually starts
 * — both with NODE_PATH set (matches the npm bin wrapper environment) and
 * with NODE_PATH cleared (matches the curl-install / Homebrew / AUR / GitHub
 * release archive environment).
 *
 * The "NODE_PATH cleared" test is the regression guard for the v0.7.x
 * curl-install crash: the Bun-compiled binary now embeds altimate-core's
 * NAPI .node into bunfs, so the standalone binary must start without any
 * companion files.
 *
 * Run: bun test test/install/smoke-test-binary.test.ts
 *
 * NOTE: Requires a local build first: bun run build:local
 */
import { describe, test, expect } from "bun:test"
import { spawnSync, execFileSync } from "child_process"
import path from "path"
import fs from "fs"
// altimate_change — #1052 D10: sha256 for stamp-based staleness check.
import { createHash } from "node:crypto"
import { tmpdir } from "../fixture/fixture"

const PKG_DIR = path.resolve(import.meta.dir, "../..")
const REPO_ROOT = path.resolve(PKG_DIR, "../..")

// Find the locally-built binary for the current platform. The build target
// naming scheme is `@altimateai/altimate-code-<os>-<arch>[-baseline]`, where
// `<os>` is `linux`/`darwin`/`windows`. We need to match by host OS+arch
// only — running a Linux ELF on Darwin makes spawnSync return null status
// with a cryptic failure that has nothing to do with the test's actual
// invariant.
function findLocalBinary(): string | undefined {
  const distDir = path.join(PKG_DIR, "dist")
  if (!fs.existsSync(distDir)) return undefined

  // node `process.platform` → build's `<os>` slug.
  const hostOsSlug =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  // Build only emits arm64 / x64.
  const hostArchSlug = process.arch === "arm64" ? "arm64" : "x64"

  function dirMatchesHost(dirName: string): boolean {
    // Match the target slug (e.g. `linux-x64`, `darwin-arm64-baseline`).
    // Reject cross-platform builds outright.
    return dirName.includes(`-${hostOsSlug}-${hostArchSlug}`) || dirName.endsWith(`-${hostOsSlug}-${hostArchSlug}`)
  }

  const binaryNames = process.platform === "win32" ? ["altimate.exe", "altimate"] : ["altimate"]
  function search(dir: string, requireHostMatch: boolean): string | undefined {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(dir, entry.name)
      if (requireHostMatch && !dirMatchesHost(entry.name)) {
        // Still recurse — the host-matching dir may live under a scoped
        // subdir like `@altimateai/altimate-code-linux-x64`.
        const nested = search(sub, true)
        if (nested) return nested
        continue
      }
      for (const name of binaryNames) {
        const binPath = path.join(sub, "bin", name)
        if (fs.existsSync(binPath)) return binPath
      }
      const nested = search(sub, true)
      if (nested) return nested
    }
    return undefined
  }
  return search(distDir, true)
}

// Resolve NODE_PATH the same way the bin wrapper does — walk up from
// the package directory collecting all node_modules directories.
// Starting from PKG_DIR (not REPO_ROOT) ensures we find workspace-level
// node_modules where NAPI modules like @altimateai/altimate-core live.
function resolveNodePath(): string {
  const paths: string[] = []
  let current = PKG_DIR
  for (;;) {
    const nm = path.join(current, "node_modules")
    if (fs.existsSync(nm)) paths.push(nm)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return paths.join(path.delimiter)
}

// altimate_change start — staleness guard.
// The binary embeds NAPI .node files that get renamed as the altimate-core
// hash changes; both `script/` (build logic) and `src/` (compiled sources)
// contribute to what the binary actually is. A local binary older than the
// newest touched .ts under either tree is guaranteed to be checked against
// invariants that no longer match. Skip rather than fail — the developer's
// intent when running `bun test` after `git pull` is not to rebuild the binary
// out-of-band, so a stale binary should surface as an actionable skip, not
// a red suite that would otherwise be green.
//
// Consensus review m5: an earlier version compared against script/build.ts
// only, which caught the rare "build logic changed" case and missed the
// common "src/ changed" case. Walk both trees now; ignore node_modules and
// hidden dirs so a stray watcher touch doesn't invalidate a fresh binary.
function newestSourceMtime(): number {
  const roots = [path.join(PKG_DIR, "src"), path.join(PKG_DIR, "script")]
  let newest = 0
  const IGNORED = new Set(["node_modules", ".turbo", ".cache", "dist", "target"])
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (IGNORED.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      // Only consider files that actually contribute to the compiled binary
      // — build.ts globs *.ts / *.tsx / *.json / *.txt for embedding. A
      // stray editor swap file (.swp) or backup shouldn't trigger a re-skip.
      if (!/\.(tsx?|json|txt|md)$/.test(entry.name)) continue
      try {
        const m = fs.statSync(full).mtimeMs
        if (m > newest) newest = m
      } catch {
        /* ignore stat errors — a missing file doesn't invalidate the guard */
      }
    }
  }
  for (const root of roots) walk(root)
  return newest
}

function isBinaryStale(binaryPath: string): boolean {
  try {
    const binMtime = fs.statSync(binaryPath).mtimeMs
    const sourceMtime = newestSourceMtime()
    if (sourceMtime === 0) return false // couldn't walk sources — err on the side of running
    return binMtime < sourceMtime
  } catch {
    return false
  }
}
// altimate_change end

// altimate_change start — #1052 D10: stamp-based staleness check.
// build.ts emits `dist/<target>/bin/build-inputs.json` next to each binary,
// listing every file the binary embedded (CHANGELOG, migrations, skills,
// models-snapshot, parser worker, altimate-core prebuild, src/, script/) with
// sha256. This function rehashes each listed input; any mismatch means the
// binary no longer reflects the current sources. Falls back to the mtime walk
// above when the stamp is missing (older builds, or fallback for `--single`
// runs before the stamp landed).
type BuildStamp = {
  target: string
  version: string
  aggregate: string
  inputs: Array<{ path: string; sha256: string }>
}
function readBuildStamp(binaryPath: string): BuildStamp | undefined {
  const stampPath = path.join(path.dirname(binaryPath), "build-inputs.json")
  try {
    if (!fs.existsSync(stampPath)) return undefined
    const parsed = JSON.parse(fs.readFileSync(stampPath, "utf-8")) as BuildStamp
    if (!parsed?.inputs?.length) return undefined
    return parsed
  } catch {
    return undefined
  }
}
function sha256File(absPath: string): string | undefined {
  try {
    return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex")
  } catch {
    return undefined
  }
}
function isBinaryStaleFromStamp(binaryPath: string): boolean | "no-stamp" {
  const stamp = readBuildStamp(binaryPath)
  if (!stamp) return "no-stamp"
  // altimate_change — #1052 D10 review-fix (M2): stamp paths are now REPO_ROOT-
  // relative so entries under packages/tui, packages/core, workspace-root
  // package.json, bun.lock, etc. resolve correctly without further munging.
  for (const { path: rel, sha256 } of stamp.inputs) {
    const abs = path.join(REPO_ROOT, rel)
    const current = sha256File(abs)
    if (current === undefined) return true // input vanished → binary can't reflect current tree
    if (current !== sha256) return true
  }
  return false
}
// altimate_change end

describe("compiled binary smoke test", () => {
  const binary = findLocalBinary()
  // altimate_change — #1052 D10: prefer the stamp-based staleness check; fall
  // back to the mtime walk when the stamp is absent (older `bun run build:local`
  // runs, or targets built before the stamp landed).
  const stampVerdict = binary ? isBinaryStaleFromStamp(binary) : ("no-stamp" as const)
  const stale =
    binary === undefined
      ? false
      : stampVerdict === "no-stamp"
        ? isBinaryStale(binary)
        : stampVerdict
  const skip = !binary || stale
  const runTest = skip ? test.skip : test

  if (!binary) {
    test.skip("no local build found — run `bun run build:local` first", () => {})
  } else if (stale) {
    test.skip(
      "local binary is stale (build-inputs stamp mismatch or newer src/script mtime) — run `bun run build:local` to refresh",
      () => {},
    )
  }

  runTest("binary starts and prints version", () => {
    const result = spawnSync(binary!, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: resolveNodePath(),
        // Prevent the binary from trying to connect to any service
        OPENCODE_DISABLE_TELEMETRY: "1",
      },
    })

    if (result.status !== 0) {
      console.error("STDOUT:", result.stdout)
      console.error("STDERR:", result.stderr)
    }
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("Cannot find module")
  })

  runTest("binary succeeds with NODE_PATH cleared (standalone mode)", async () => {
    // The Bun-compiled binary embeds @altimateai/altimate-core's NAPI .node
    // directly into bunfs (see script/build.ts — staged shim + resolver
    // plugin). It MUST start without any external NODE_PATH or companion
    // node_modules. This is the regression guard for the v0.7.x curl-install
    // crash where altimate-core was marked `external` and the standalone
    // archive shipped without it.
    //
    // Hermeticity: cwd is a freshly-created tmp dir so the binary cannot walk
    // upward and discover the worktree's node_modules. Without this, Bun's
    // compiled binary falls back to filesystem resolution from process.execPath
    // and the test passes even if the staged-shim onResolve silently misses.
    //
    // Uses the repo's tmpdir() fixture for auto-cleanup via `await using`.
    await using tmp = await tmpdir()
    const result = spawnSync(binary!, ["--version"], {
      cwd: tmp.path,
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENCODE_DISABLE_TELEMETRY: "1",
        // Explicitly clear NODE_PATH to simulate the curl-install layout
        NODE_PATH: "",
      },
    })

    if (result.status !== 0) {
      console.error("STDOUT:", result.stdout)
      console.error("STDERR:", result.stderr)
    }
    expect(result.status).toBe(0)
    const output = (result.stdout ?? "") + (result.stderr ?? "")
    expect(output).not.toContain("Cannot find module")
  })

  // Content-level assertion: independent of any runtime resolution path,
  // require that the compiled binary contains exactly one altimate-core .node
  // reference. If the staged-shim onResolve ever silently fails to redirect
  // and Bun pulls in the upstream multi-platform loader, every platform's
  // .node name leaks into bunfs and this test fires. Pairs with the
  // hermetic --version test above.
  runTest("binary embeds exactly one altimate-core .node", () => {
    if (process.platform === "win32") {
      // `strings` isn't available on a stock Windows runner. The other tests
      // already exercise the runtime path; this content-level check covers
      // Linux + macOS CI which is where the build matrix actually runs.
      return
    }
    const stringsOut = execFileSync("strings", [binary!], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    })
    // Strip the bunfs hash suffix Bun appends to embedded resources
    // (e.g. "altimate-core.darwin-arm64-ptxrnv5e.node" → "altimate-core.darwin-arm64.node")
    // so the require() string and the bunfs entry collapse to the same name.
    // Bun uses an alphanumeric (not hex) hash of 7+ chars; real platform
    // last-segments (arm64/x64/gnu/msvc) are all <=5 chars, so a length-bound
    // of {6,} unambiguously matches the hash.
    const refs = [...stringsOut.matchAll(/altimate-core\.(?:darwin|linux|win32)-[a-z0-9-]+\.node/g)]
      .map((m) => m[0])
      .map((r) => r.replace(/-[a-z0-9]{6,}(?=\.node$)/, ""))
    const distinct = new Set(refs)
    if (distinct.size !== 1) {
      console.error("altimate-core .node references found in binary:", [...distinct])
    }
    expect(distinct.size).toBeGreaterThanOrEqual(1)
    expect(distinct.size).toBe(1)
  })

  runTest("binary responds to --help", () => {
    const result = spawnSync(binary!, ["--help"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: resolveNodePath(),
        OPENCODE_DISABLE_TELEMETRY: "1",
      },
    })

    expect(result.status).toBe(0)
    // Help output should mention at least one command
    const output = (result.stdout ?? "") + (result.stderr ?? "")
    expect(output.length).toBeGreaterThan(0)
  })
})

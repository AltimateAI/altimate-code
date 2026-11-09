/**
 * #982 — `altimate-dbt` must be on PATH after `npm install -g altimate-code`,
 * even when lifecycle scripts never run.
 *
 * Before the fix the published package.json only declared `altimate` and
 * `altimate-code` as bins. `altimate-dbt` was reachable only through the
 * postinstall symlink into the package's own bin/ folder, so:
 *   - users never got `altimate-dbt` in their shell, and
 *   - with --ignore-scripts (or pnpm/bun script allow-lists) the agent lost it too.
 *
 * The e2e tests pack a package with the published layout, install it globally
 * into a temp prefix with --ignore-scripts, and run `altimate-dbt` from PATH.
 * They install a local tarball with no dependencies, so they need npm but no network.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"

const REPO_PKG_DIR = path.resolve(import.meta.dir, "../..")
const REPO_ROOT = path.resolve(REPO_PKG_DIR, "../..")
const DBT_BIN_SOURCE = path.join(REPO_ROOT, "packages/dbt-tools/bin/altimate-dbt")
const PUBLISH_SCRIPT = fs.readFileSync(path.join(REPO_PKG_DIR, "script/publish.ts"), "utf-8")
const DBT_BIN_ENTRY = '"altimate-dbt": "./dbt-tools/bin/altimate-dbt"'

// Bound every npm call so a stalled registry or cache lock fails the test instead of hanging CI.
const NPM_TIMEOUT_MS = 120_000
const npm = spawnSync("npm", ["--version"], { encoding: "utf-8", timeout: 10_000 })
const HAS_NPM = npm.status === 0
const IS_WINDOWS = process.platform === "win32"

describe("publish.ts declares altimate-dbt as a bin (#982)", () => {
  test("both the scoped and unscoped package.json declare altimate-dbt", () => {
    const occurrences = PUBLISH_SCRIPT.split(DBT_BIN_ENTRY).length - 1
    expect(occurrences).toBe(2)
  })

  test("the bin target is the file copyAssets ships", () => {
    expect(PUBLISH_SCRIPT).toContain("cp ../dbt-tools/bin/altimate-dbt ${targetDir}/dbt-tools/bin/altimate-dbt")
    expect(fs.existsSync(DBT_BIN_SOURCE)).toBe(true)
  })
})

/** Build a package directory with the published layout and return its path. */
function makePublishedLayout(root: string, opts: { declareDbtBin: boolean }): string {
  const pkg = path.join(root, "altimate-code")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.mkdirSync(path.join(pkg, "dbt-tools", "bin"), { recursive: true })
  fs.mkdirSync(path.join(pkg, "dbt-tools", "dist"), { recursive: true })

  fs.writeFileSync(path.join(pkg, "bin", "altimate"), "#!/usr/bin/env node\nconsole.log('altimate')\n", { mode: 0o755 })
  fs.writeFileSync(path.join(pkg, "bin", "altimate-code"), "#!/usr/bin/env node\nconsole.log('altimate-code')\n", {
    mode: 0o755,
  })
  // The real launcher shipped by copyAssets, so the test tracks its import path.
  fs.copyFileSync(DBT_BIN_SOURCE, path.join(pkg, "dbt-tools", "bin", "altimate-dbt"))
  fs.chmodSync(path.join(pkg, "dbt-tools", "bin", "altimate-dbt"), 0o755)
  fs.writeFileSync(path.join(pkg, "dbt-tools", "package.json"), JSON.stringify({ type: "module" }) + "\n")
  fs.writeFileSync(
    path.join(pkg, "dbt-tools", "dist", "index.js"),
    'import { argv } from "node:process"\nconsole.log(JSON.stringify({ ok: true, args: argv.slice(2) }))\n',
  )

  const bin: Record<string, string> = { altimate: "./bin/altimate", "altimate-code": "./bin/altimate-code" }
  if (opts.declareDbtBin) bin["altimate-dbt"] = "./dbt-tools/bin/altimate-dbt"
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify(
      {
        name: "altimate-code",
        version: "0.0.0-test",
        bin,
        // Must NOT run: proves the bin works without lifecycle scripts.
        scripts: { postinstall: "node -e \"process.exit(1)\"" },
      },
      null,
      2,
    ),
  )
  return pkg
}

/** npm pack + npm install -g --ignore-scripts into a temp prefix; returns the prefix bin dir. */
function packAndInstall(root: string, pkgDir: string): string {
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: pkgDir,
    encoding: "utf-8",
    timeout: NPM_TIMEOUT_MS,
  })
  expect(packed.status).toBe(0)
  const tarball = path.join(root, packed.stdout.trim().split("\n").pop()!)
  const prefix = path.join(root, "prefix")
  const installed = spawnSync(
    "npm",
    ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball],
    { encoding: "utf-8", timeout: NPM_TIMEOUT_MS },
  )
  expect(installed.status).toBe(0)
  return path.join(prefix, "bin")
}

function runFromPath(binDir: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: os.tmpdir(),
    encoding: "utf-8",
    timeout: 30_000,
    // The install prefix first, then the normal PATH (the launcher needs `node` via env).
    env: { ...process.env, PATH: [binDir, process.env.PATH ?? ""].join(path.delimiter) },
  })
}

describe.skipIf(!HAS_NPM || IS_WINDOWS)("altimate-dbt on PATH after global install (#982)", () => {
  test("control: without the bin entry, altimate-dbt is not on PATH (the bug)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-on-path-before-"))
    try {
      const binDir = packAndInstall(root, makePublishedLayout(root, { declareDbtBin: false }))
      expect(fs.existsSync(path.join(binDir, "altimate"))).toBe(true)
      expect(fs.existsSync(path.join(binDir, "altimate-dbt"))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("with the bin entry, altimate-dbt is linked and runs from any directory, with scripts skipped", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-on-path-after-"))
    try {
      const binDir = packAndInstall(root, makePublishedLayout(root, { declareDbtBin: true }))
      expect(fs.existsSync(path.join(binDir, "altimate-dbt"))).toBe(true)

      const result = runFromPath(binDir, "altimate-dbt", ["doctor"])
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, args: ["doctor"] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

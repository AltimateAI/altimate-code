/**
 * altimate_change — install telemetry (AI-8448).
 *
 * `first_launch` is the only install metric, and it is triggered by a marker file rather than by
 * the installer talking to the network. Before this, only npm's postinstall wrote that marker, so
 * moving the advertised install path to altimate.sh/install took installs out of instrumentation
 * and showed up as a dip in the dashboard.
 *
 * Coverage is in two layers. Source-level assertions (matching windows-install.test.ts) pin the
 * details that fail silently — the data-dir expression, the "unknown" fallback, ordering relative
 * to the install dispatch. Those cannot catch a syntax error or a bad variable scope, so the
 * "executed" describe below runs the real bash installer through its `--binary` path (no network,
 * no GitHub) against a throwaway HOME and asserts the files the CLI actually reads.
 *
 * install.ps1 gets source-level assertions here plus a syntax parse and real execution in
 * test/windows/install.Tests.ps1, which AST-extracts Write-InstallMarker and runs it against a
 * temp profile. NOTE: the Pester suite's *subprocess* tests deliberately stop the installer
 * early (via -Help / an unknown -Version) so nothing is downloaded, so they never reach the
 * marker block — the AST-extracted tests are its only runtime coverage. That suite runs under
 * pwsh, not powershell.exe, so Windows PowerShell 5.1 — the documented entrypoint and the
 * reason for -Encoding ascii — is still not exercised anywhere.
 */
import { describe, expect, test, afterEach, spyOn, mock } from "bun:test"
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import os from "os"
import path from "path"
import { Telemetry } from "@/altimate/telemetry"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const INSTALL_SH = readFileSync(join(REPO_ROOT, "install"), "utf-8")
const INSTALL_PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const WELCOME_SRC = readFileSync(join(REPO_ROOT, "packages/opencode/src/cli/welcome.ts"), "utf-8")

describe("install — post-install marker", () => {
  test("writes the marker the CLI reads", () => {
    expect(INSTALL_SH).toMatch(/\.installed-version/)
    expect(INSTALL_SH).toMatch(/write_install_marker/)
  })

  test("resolves the data dir exactly as welcome.ts does", () => {
    // welcome.ts: XDG_DATA_HOME, else <home>/.local/share, then /altimate-code.
    expect(INSTALL_SH).toMatch(/\$\{XDG_DATA_HOME:-\$HOME\/\.local\/share\}\/altimate-code/)
    expect(WELCOME_SRC).toMatch(/XDG_DATA_HOME \|\| path\.join\(os\.homedir\(\), "\.local", "share"\)/)
  })

  test("falls back to a non-empty version when the release could not be resolved", () => {
    // An empty marker is deleted unread (welcome.ts), so an unresolved version would
    // otherwise lose the install entirely — the exact case check_version leaves empty.
    expect(INSTALL_SH).toMatch(/specific_version:-unknown/)
  })

  test("records the install method it was given", () => {
    expect(INSTALL_SH).toMatch(/\.install-source/)
    expect(INSTALL_SH).toMatch(/printf '%s' "\$marker_source"/)
    // The parameter must actually be bound, or set -u aborts the install.
    expect(INSTALL_SH).toMatch(/local marker_source="\$1"/)
  })

  test("marker is written after the install actually happened, not before", () => {
    // Ordering matters twice: check_version exits 0 early when the requested version is
    // already present (no install, so no event), and a marker written ahead of a failed
    // download would report an install that never landed.
    const dispatch = INSTALL_SH.indexOf("    download_and_install")
    // Both branches call it after their install step; neither before.
    const curlCall = INSTALL_SH.indexOf('write_install_marker "curl"')
    const localCall = INSTALL_SH.indexOf('write_install_marker "local"')
    const binaryDispatch = INSTALL_SH.indexOf("    install_from_binary")
    expect(dispatch).toBeGreaterThan(0)
    expect(curlCall).toBeGreaterThan(dispatch)
    expect(localCall).toBeGreaterThan(binaryDispatch)
  })

  test("publishes the companion before the trigger", () => {
    const start = INSTALL_SH.indexOf("write_install_marker() {")
    // Code only — the comment above the writes names .installed-version first while
    // explaining why it must be written last.
    const fn = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start))
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n")
    const source = fn.indexOf(".install-source")
    const version = fn.indexOf(".installed-version")
    expect(source).toBeGreaterThan(0)
    expect(version).toBeGreaterThan(source)
  })

  test("attributes --binary installs as local, not curl", () => {
    // That branch sets specific_version="local"; folding it into the curl metric would
    // misreport both source and version.
    expect(INSTALL_SH).toMatch(/write_install_marker "local"/)
    expect(INSTALL_SH).toMatch(/write_install_marker "curl"/)
  })

  test("marker failures cannot abort the install", () => {
    // A read-only or absent $HOME must cost the event, never the install.
    const start = INSTALL_SH.indexOf("write_install_marker() {")
    const fn = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start))
    expect(fn).toMatch(/mkdir -p "\$data_dir" 2>\/dev\/null \|\| return 0/)
    expect(fn.match(/\|\| return 0/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

// altimate_change — execution coverage for the bash marker writer.
//
// Every assertion above reads source text, which cannot catch a syntax error, a bad
// variable scope, or a wrong path inside write_install_marker(). These run the real
// installer end to end via its `--binary` path (no network, no GitHub) against a
// throwaway HOME, and assert the files the CLI actually reads.
describe("install — marker writer, executed", () => {
  const INSTALL_SH_PATH = join(REPO_ROOT, "install")
  // Bash-only; skip on Windows runners rather than reporting a false pass.
  const shtest = process.platform === "win32" ? test.skip : test

  /** Runs `./install --binary <fake>` with an isolated HOME/XDG and returns the marker dir. */
  function runInstaller(env: Record<string, string>): { code: number; stderr: string; home: string } {
    const home = mkdtempSync(join(os.tmpdir(), "install-exec-home-"))
    const fakeBin = join(home, "altimate")
    writeFileSync(fakeBin, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 })
    const res = spawnSync("bash", [INSTALL_SH_PATH, "--binary", fakeBin, "--no-modify-path"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, ...env },
    })
    return { code: res.status ?? -1, stderr: res.stderr ?? "", home }
  }

  shtest("writes both marker files under the default data dir", () => {
    const { code, home, stderr } = runInstaller({ XDG_DATA_HOME: "" })
    expect(code).toBe(0)
    const dir = join(home, ".local", "share", "altimate-code")
    // A non-empty version is required — the CLI deletes an empty marker unread.
    expect(readFileSync(join(dir, ".installed-version"), "utf-8").trim().length).toBeGreaterThan(0)
    // "local", not "curl": runInstaller uses --binary, which is deliberately attributed
    // separately so a dev/air-gapped install cannot inflate the curl metric.
    expect(readFileSync(join(dir, ".install-source"), "utf-8").trim()).toBe("local")
    rmSync(home, { recursive: true, force: true })
    expect(stderr).not.toMatch(/syntax error|command not found/)
  })

  shtest("honours $XDG_DATA_HOME", () => {
    const xdg = mkdtempSync(join(os.tmpdir(), "install-exec-xdg-"))
    const { code, home } = runInstaller({ XDG_DATA_HOME: xdg })
    expect(code).toBe(0)
    expect(existsSync(join(xdg, "altimate-code", ".installed-version"))).toBe(true)
    // Must NOT also land in the home-relative fallback.
    expect(existsSync(join(home, ".local", "share", "altimate-code", ".installed-version"))).toBe(false)
    rmSync(xdg, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  shtest("an unwritable data dir does not fail the install", () => {
    // Parent is a regular file, so mkdir -p cannot succeed under it.
    const blocked = mkdtempSync(join(os.tmpdir(), "install-exec-blocked-"))
    const asFile = join(blocked, "not-a-dir")
    writeFileSync(asFile, "x")
    const { code, home } = runInstaller({ XDG_DATA_HOME: join(asFile, "nested") })
    expect(code).toBe(0)
    rmSync(blocked, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
})

describe("install.ps1 — post-install marker", () => {
  const markerBlock = INSTALL_PS1.slice(
    INSTALL_PS1.indexOf("Post-install marker"),
    INSTALL_PS1.indexOf("PATH (user scope"),
  )
  // Comments in this block deliberately name %LOCALAPPDATA% to explain why it is wrong,
  // so the "never LOCALAPPDATA" assertion has to look at code only.
  const markerCode = markerBlock
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")

  test("writes the marker and attributes itself as powershell", () => {
    expect(markerCode).toMatch(/\.installed-version/)
    expect(markerCode).toMatch(/"powershell"/)
  })

  test("uses the XDG/.local\\share path, never LOCALAPPDATA", () => {
    // The CLI reads the data dir through Node's os.homedir() and never consults
    // %LOCALAPPDATA%, so a marker written there would be silently ignored at read time.
    expect(markerCode).toMatch(/XDG_DATA_HOME/)
    // [IO.Path]::Combine(USERPROFILE, ".local", "share") — Combine rather than a literal
    // path so PSDrive resolution cannot throw, matching welcome.ts's <home>/.local/share.
    expect(markerCode).toMatch(/USERPROFILE/)
    expect(markerCode).toMatch(/"\.local", ?"share"/)
    expect(markerCode).not.toMatch(/LOCALAPPDATA/)
  })

  test("falls back to a non-empty version and cannot abort the install", () => {
    expect(markerCode).toMatch(/"unknown"/)
    expect(markerCode).toMatch(/} catch \{/)
  })

  test("computes its paths INSIDE the try, not above it", () => {
    // $ErrorActionPreference is "Stop", so a null $env:USERPROFILE or an XDG_DATA_HOME
    // naming a bad PSDrive throws. Above the try that terminates the installer after the
    // binary is placed but before the PATH write — installed, but not on PATH. The old
    // "} catch {" assertion passed with the assignments outside, so pin the order.
    const tryIdx = markerCode.indexOf("try {")
    const rootIdx = markerCode.indexOf("$dataRoot =")
    const dirIdx = markerCode.indexOf("$dataDir =")
    expect(tryIdx).toBeGreaterThan(0)
    expect(rootIdx).toBeGreaterThan(tryIdx)
    expect(dirIdx).toBeGreaterThan(tryIdx)
  })

  test("publishes the companion before the trigger", () => {
    // .installed-version is the reader's trigger; writing it first would let a CLI
    // starting in between report "unknown", or observe a truncated (empty) file and
    // drop the install entirely.
    const source = markerCode.indexOf('".install-source"')
    const version = markerCode.indexOf('".installed-version"')
    expect(source).toBeGreaterThan(0)
    expect(version).toBeGreaterThan(source)
  })

  test("writes without a BOM", () => {
    // The documented entrypoint is `powershell -c "irm ... | iex"` — Windows PowerShell 5.1,
    // where `-Encoding utf8` prepends a UTF-8 BOM. install-source is matched against a fixed
    // allowlist, so a BOM would silently degrade every PowerShell install to "unknown".
    expect(markerCode).not.toMatch(/-Encoding utf8/)
    expect(markerCode.match(/-Encoding ascii/g)).toHaveLength(2)
  })
})

describe("is_upgrade ordering", () => {
  test("index.ts calls the welcome banner BEFORE Telemetry.init()", () => {
    // The primary protection for is_upgrade. The banner probes whether
    // ~/.altimate/machine-id exists and init() mints it, so the banner must run first.
    // Swapping these silently flips every install to is_upgrade: true.
    // Code only: the comment above the banner call names Telemetry.init() to explain the
    // ordering, so a naive indexOf over the raw source finds the comment, not the call.
    const src = readFileSync(join(REPO_ROOT, "packages/opencode/src/index.ts"), "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
    const banner = src.indexOf("showWelcomeBannerIfNeeded()")
    const init = src.indexOf("Telemetry.init()")
    expect(banner).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(0)
    expect(banner).toBeLessThan(init)
  })

  afterEach(() => mock.restore())

  test("an unawaited Telemetry.init() has not minted a machine-id when the banner runs", async () => {
    // Defence in depth behind the ordering test above. index.ts now runs the banner before
    // init(), so is_upgrade no longer depends on this — but init() is also called from other
    // entrypoints, and any caller that emits an install-shaped event before awaiting it still
    // relies on the mint happening after doInit's first await (Config.get). This pins that
    // behaviour so a refactor making the mint synchronous is caught here rather than showing
    // up as every install reporting is_upgrade: true.
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const origDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    // Both gates, not just one: doInit() returns before minting if EITHER is set, which
    // would make the "machine-id exists after await" assertion fail on a machine or CI
    // runner that exports OPENCODE_DISABLE_TELEMETRY.
    const origOpencodeDisabled = process.env.OPENCODE_DISABLE_TELEMETRY
    const tmpHome = mkdtempSync(join(os.tmpdir(), "install-telemetry-home-"))
    spyOn(os, "homedir").mockImplementation(() => tmpHome)
    spyOn(global, "fetch").mockImplementation((async () => new Response("", { status: 200 })) as any)

    try {
      // The baked-in sink is refused under a test runner, and doInit returns before minting
      // when it has no connection string — which would make this test vacuously pass.
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      delete process.env.OPENCODE_DISABLE_TELEMETRY
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://example.invalid"
      // init() is `initPromise ??= doInit()`; shutdown() is the only seam that clears it, so
      // an earlier init in this process would otherwise be handed back already resolved.
      await Telemetry.shutdown()

      const pending = Telemetry.init()
      const machineIdPath = path.join(tmpHome, ".altimate", "machine-id")

      // The instant that matters — the same turn of the event loop in which index.ts calls
      // showWelcomeBannerIfNeeded().
      expect(existsSync(machineIdPath)).toBe(false)

      await pending
      // Proves the assertion above is not vacuous: this path really does mint, just later.
      expect(existsSync(machineIdPath)).toBe(true)
    } finally {
      await Telemetry.shutdown()
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      if (origDisabled !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = origDisabled
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
      if (origOpencodeDisabled !== undefined) process.env.OPENCODE_DISABLE_TELEMETRY = origOpencodeDisabled
      else delete process.env.OPENCODE_DISABLE_TELEMETRY
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

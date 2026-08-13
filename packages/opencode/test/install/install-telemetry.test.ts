/**
 * altimate_change — install telemetry (AI-8448).
 *
 * `first_launch` is the only install metric, and it is triggered by a marker file rather than by
 * the installer talking to the network. Before this, only npm's postinstall wrote that marker, so
 * moving the advertised install path to altimate.sh/install took installs out of instrumentation
 * and showed up as a dip in the dashboard.
 *
 * The shell installers are asserted at the source level, matching windows-install.test.ts: running
 * them would download a release. What matters is that they write the marker where the CLI actually
 * looks, which is the part that fails silently.
 */
import { describe, expect, test, afterEach, spyOn, mock } from "bun:test"
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
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

  test("attributes itself as curl", () => {
    expect(INSTALL_SH).toMatch(/\.install-source/)
    expect(INSTALL_SH).toMatch(/printf '%s' "curl"/)
  })

  test("marker is written after the install actually happened, not before", () => {
    // Ordering matters twice: check_version exits 0 early when the requested version is
    // already present (no install, so no event), and a marker written ahead of a failed
    // download would report an install that never landed.
    const dispatch = INSTALL_SH.indexOf("    download_and_install")
    const markerCall = INSTALL_SH.lastIndexOf("\nwrite_install_marker")
    expect(dispatch).toBeGreaterThan(0)
    expect(markerCall).toBeGreaterThan(dispatch)
  })

  test("marker failures cannot abort the install", () => {
    // A read-only or absent $HOME must cost the event, never the install.
    const start = INSTALL_SH.indexOf("write_install_marker() {")
    const fn = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start))
    expect(fn).toMatch(/mkdir -p "\$data_dir" 2>\/dev\/null \|\| return 0/)
    expect(fn.match(/\|\| return 0/g)?.length).toBeGreaterThanOrEqual(3)
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
    expect(markerCode).toMatch(/\.local\\share/)
    expect(markerCode).not.toMatch(/LOCALAPPDATA/)
  })

  test("falls back to a non-empty version and cannot abort the install", () => {
    expect(markerCode).toMatch(/"unknown"/)
    expect(markerCode).toMatch(/} catch \{/)
  })

  test("writes without a BOM", () => {
    // The documented entrypoint is `powershell -c "irm ... | iex"` — Windows PowerShell 5.1,
    // where `-Encoding utf8` prepends a UTF-8 BOM. install-source is matched against a fixed
    // allowlist, so a BOM would silently degrade every PowerShell install to "unknown".
    expect(markerCode).not.toMatch(/-Encoding utf8/)
    expect(markerCode.match(/-Encoding ascii/g)).toHaveLength(2)
  })
})

describe("is_upgrade ordering invariant", () => {
  afterEach(() => mock.restore())

  test("an unawaited Telemetry.init() has not minted a machine-id when the banner runs", async () => {
    // src/index.ts fires Telemetry.init() WITHOUT awaiting it, then calls
    // showWelcomeBannerIfNeeded() synchronously on the next line. is_upgrade is only
    // meaningful because doInit() reaches its first await (Config.get) before minting the
    // machine-id — so the banner's existsSync still sees pre-launch state.
    //
    // Add an await ahead of that mint, or make it synchronous, and this invariant flips:
    // every install would then report is_upgrade: true and brand-new installs would vanish
    // from the metric without a single test failing. Hence this test.
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const origDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    const tmpHome = mkdtempSync(join(os.tmpdir(), "install-telemetry-home-"))
    spyOn(os, "homedir").mockImplementation(() => tmpHome)
    spyOn(global, "fetch").mockImplementation((async () => new Response("", { status: 200 })) as any)

    try {
      // The baked-in sink is refused under a test runner, and doInit returns before minting
      // when it has no connection string — which would make this test vacuously pass.
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
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
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

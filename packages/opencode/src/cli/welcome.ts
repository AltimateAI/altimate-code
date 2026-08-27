import fs from "fs"
import path from "path"
import os from "os"
import { Installation } from "../installation"
import { EOL } from "os"
// altimate_change start — import Telemetry for first_launch event
import { Telemetry } from "../altimate/telemetry"
// altimate_change end

const APP_NAME = "altimate-code"
const MARKER_FILE = ".installed-version"
// altimate_change start — written alongside MARKER_FILE by whichever installer ran
// (postinstall.mjs, install, install.ps1) so first_launch can attribute the install.
const SOURCE_FILE = ".install-source"
// "vscode-extension" is the dominant installer by volume: the VS Code extension's
// native installer pulls the binary straight from GitHub releases, bypassing npm and
// both shell scripts (it stopped spawning `curl | bash` because EDR tooling flagged
// it — vscode-dbt-power-user#2049). It writes the marker so those installs land here
// rather than going uncounted.
const INSTALL_METHODS = ["curl", "powershell", "npm", "vscode-extension"] as const
type InstallMethod = (typeof INSTALL_METHODS)[number] | "unknown"

/** Remove SOURCE_FILE, tolerating absence. Kept separate so the empty-marker path can
 * clear an orphan without pretending to read a value it will not use. */
function clearInstallSource(dataDir: string): void {
  try {
    fs.unlinkSync(path.join(dataDir, SOURCE_FILE))
  } catch {
    // Absent, or unlink refused — nothing further to do either way.
  }
}

/**
 * Read the installer that wrote the marker, then remove the file so it stays in
 * lockstep with MARKER_FILE — a stale value must never be attributed to a later
 * install whose installer did not write one.
 *
 * Returns "unknown" for a missing, unreadable, or unrecognized value: the marker
 * predates this field on upgrade from an older version, and an unrecognized
 * string must not reach the event as a free-form value.
 *
 * The unlink runs in `finally`, so a file that exists but cannot be READ (EACCES,
 * a directory in its place) is still cleared. Leaving it behind would let a stale
 * value be attributed to the next install whose installer wrote only the version.
 */
function readInstallMethod(dataDir: string): InstallMethod {
  const sourcePath = path.join(dataDir, SOURCE_FILE)
  try {
    const raw = fs.readFileSync(sourcePath, "utf-8").trim()
    return (INSTALL_METHODS as readonly string[]).includes(raw) ? (raw as InstallMethod) : "unknown"
  } catch {
    return "unknown"
  } finally {
    clearInstallSource(dataDir)
  }
}
// altimate_change end

/** Resolve the data directory at call time (respects XDG_DATA_HOME changes in tests). */
function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(xdgData, APP_NAME)
}

/**
 * Check for a post-install/upgrade marker written by postinstall.mjs.
 * If found, display a welcome box on stderr, then remove the marker.
 *
 * npm v7+ silences ALL postinstall output (stdout AND stderr), so
 * the postinstall script only writes a marker file. This function
 * picks it up on first CLI run and shows the welcome box before
 * the TUI launches.
 */
export function showWelcomeBannerIfNeeded(): void {
  try {
    const dataDir = getDataDir()
    const markerPath = path.join(dataDir, MARKER_FILE)
    if (!fs.existsSync(markerPath)) return

    const installedVersion = fs.readFileSync(markerPath, "utf-8").trim()
    if (!installedVersion) {
      fs.unlinkSync(markerPath)
      // altimate_change — clear the companion file too, so an orphaned source value
      // cannot be attributed to a later install. Both install scripts write "unknown"
      // rather than an empty version, so this path should now only be reachable from
      // a truncated or hand-edited marker.
      clearInstallSource(dataDir)
      return
    }

    // Remove marker first to avoid showing twice even if display fails.
    //
    // altimate_change — this makes first_launch deliberately at-most-once: the marker
    // is gone before Telemetry flushes, so a process that dies inside the flush
    // interval loses the event permanently rather than re-firing it on every
    // subsequent launch. That trade is intentional — an offline or crash-looping
    // machine repeating first_launch would corrupt install counts far worse than a
    // rare miss. Do NOT make deletion contingent on a successful flush.
    fs.unlinkSync(markerPath)

    // altimate_change start — `is_upgrade` means "this machine had run altimate-code before",
    // probed as: did ~/.altimate/machine-id exist? Probe with existsSync only — do NOT mint
    // here. Minting is Telemetry.doInit()'s job; the first_launch machine_id is attached at
    // flush time from telemetry module state, so it does not depend on minting here.
    //
    // src/index.ts calls this function BEFORE Telemetry.init() precisely so this probe cannot
    // race the mint. Keep that order.
    //
    // KNOWN SEMANTIC LIMIT: this is "has prior run", not "was the binary absent". A machine
    // that ever ran the CLI — an old curl install, a trial — reports is_upgrade: true even
    // when an installer genuinely placed a new binary, and `altimate uninstall` leaves
    // machine-id in place (cli/cmd/uninstall.ts removes data/cache/config/state, not
    // ~/.altimate). Install dashboards filtering `is_upgrade != "true"` therefore undercount
    // reinstalls onto known machines. Deliberate: it keeps the count deduplicated per machine.
    // The installers know the true answer (the VS Code extension already distinguishes
    // first-install from auto-update) — carrying that in the marker would be the fix if a
    // strict install count is ever required. Documented in docs/docs/reference/telemetry.md.
    //
    // FIXME(telemetry-init-config-opt-out): doInit() may run before Instance.provide() has made
    // Config.get() resolvable (see the try/catch around Config.get in telemetry/index.ts::doInit
    // — the catch branch proceeds with telemetry enabled). A user who opted out via the
    // `telemetry.disabled` config key — with no env var set — can therefore still have early
    // events transmitted. The env-var opt-out (ALTIMATE_TELEMETRY_DISABLED /
    // OPENCODE_DISABLE_TELEMETRY) is unaffected — that check needs no Instance context.
    // Pre-existing and NOT specific to this event: every event emitted from CLI middleware
    // shares the same gate. It is called out here because this event's volume grew ~30x when
    // the shell and extension installers began writing the marker, so the exposure window is
    // now routinely hit rather than theoretical. Fixing it belongs in telemetry init (make
    // Config resolvable there, or adopt an explicit fail-closed policy module-wide) rather
    // than in this function, which cannot resolve config without duplicating the merge and
    // JSONC semantics of config/config.ts.
    const machineIdPath = path.join(os.homedir(), ".altimate", "machine-id")
    const isUpgrade = fs.existsSync(machineIdPath)
    // altimate_change end

    // altimate_change start — track first launch for new user counting (privacy-safe: only version + machine_id)
    Telemetry.track({
      type: "first_launch",
      timestamp: Date.now(),
      session_id: "",
      version: installedVersion,
      is_upgrade: isUpgrade,
      install_method: readInstallMethod(dataDir),
    })
    // altimate_change end

    if (!isUpgrade) return

    const tty = process.stderr.isTTY
    if (!tty) return

    // Show the welcome box that postinstall couldn't display
    const orange = "\x1b[38;5;214m"
    const reset = "\x1b[0m"
    const bold = "\x1b[1m"

    // altimate_change start — use installedVersion (from marker) instead of currentVersion for accurate banner
    const v = `altimate-code v${installedVersion} installed`
    // altimate_change end
    const lines = [
      "",
      "  Get started:",
      "    altimate              Open the TUI",
      '    altimate run "hello"  Run a quick task',
      "    altimate --help       See all commands",
      "",
    ]
    const contentWidth = Math.max(v.length, ...lines.map((l) => l.length)) + 2
    const pad = (s: string) => s + " ".repeat(contentWidth - s.length)
    const top = `  ${orange}╭${"─".repeat(contentWidth + 2)}╮${reset}`
    const bot = `  ${orange}╰${"─".repeat(contentWidth + 2)}╯${reset}`
    const empty = `  ${orange}│${reset} ${" ".repeat(contentWidth)} ${orange}│${reset}`
    const row = (s: string) => `  ${orange}│${reset} ${pad(s)} ${orange}│${reset}`

    process.stderr.write(EOL)
    process.stderr.write(top + EOL)
    process.stderr.write(empty + EOL)
    process.stderr.write(row(` ${bold}${v}${reset}`) + EOL)
    for (const line of lines) process.stderr.write(row(line) + EOL)
    process.stderr.write(bot + EOL)
    process.stderr.write(EOL)
  } catch {
    // Non-fatal — never let banner display break the CLI
  }
}

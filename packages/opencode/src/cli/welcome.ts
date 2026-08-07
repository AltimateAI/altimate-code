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
    const markerPath = path.join(getDataDir(), MARKER_FILE)
    if (!fs.existsSync(markerPath)) return

    const installedVersion = fs.readFileSync(markerPath, "utf-8").trim()
    if (!installedVersion) {
      fs.unlinkSync(markerPath)
      return
    }

    // Remove marker first to avoid showing twice even if display fails
    fs.unlinkSync(markerPath)

    // altimate_change start — "upgrade" means the machine-id file already existed before this
    // launch. Probe existence with existsSync only — do NOT mint here. Minting is left to
    // Telemetry.doInit() (its job, not the welcome banner's); the first_launch machine_id is
    // attached at flush time from telemetry module state, so it does not depend on minting here.
    // NOTE: doInit's early call runs before an Instance is available, so its CONFIG opt-out gate
    // fails open and it can still mint for a config-only opt-out user. That is a pre-existing
    // telemetry-init gap (tracked separately), not something this banner can fix — this code just
    // stops adding a SECOND minting site under an even weaker (env-only) gate.
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

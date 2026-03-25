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

    // altimate_change start — use ~/.altimate/machine-id existence as a proxy for upgrade vs fresh install
    // Since postinstall.mjs always writes the current version to the marker file, we can't reliably
    // use installedVersion !== currentVersion for release builds. Instead, if machine-id exists,
    // they've run the CLI before.
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

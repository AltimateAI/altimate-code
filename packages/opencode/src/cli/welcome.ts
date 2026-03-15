import fs from "fs"
import path from "path"
import os from "os"
import { Installation } from "../installation"
import { EOL } from "os"

const APP_NAME = "altimate-code"
const MARKER_FILE = ".installed-version"

/** Resolve the data directory at call time (respects XDG_DATA_HOME changes in tests). */
function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(xdgData, APP_NAME)
}

/**
 * Check for a post-install/upgrade marker written by postinstall.mjs.
 * If found, display a brief upgrade confirmation on stderr, then remove the marker.
 *
 * The postinstall script shows the full welcome box (with get-started hints).
 * This function handles the case where postinstall output was silenced (npm v7+)
 * or the install method didn't run postinstall at all (brew, curl).
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

    const currentVersion = Installation.VERSION.replace(/^v/, "")
    const isUpgrade = installedVersion === currentVersion && installedVersion !== "local"

    if (!isUpgrade) return

    // Show a brief confirmation — the full welcome box is in postinstall.mjs
    const tty = process.stderr.isTTY
    if (!tty) return

    const orange = "\x1b[38;5;214m"
    const reset = "\x1b[0m"
    const bold = "\x1b[1m"

    process.stderr.write(EOL)
    process.stderr.write(`  ${orange}${bold}altimate-code v${currentVersion}${reset} installed successfully!${EOL}`)
    process.stderr.write(EOL)
  } catch {
    // Non-fatal — never let banner display break the CLI
  }
}

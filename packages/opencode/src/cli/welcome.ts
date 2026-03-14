import fs from "fs"
import path from "path"
import os from "os"
import { Installation } from "../installation"
import { extractChangelog } from "./changelog"
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
 * If found, display a welcome banner (and changelog on upgrade), then remove the marker.
 *
 * npm v7+ silences postinstall stdout, so this is the reliable way to show the banner.
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

    // Show welcome box
    const tty = process.stderr.isTTY
    if (!tty) return

    const orange = "\x1b[38;5;214m"
    const reset = "\x1b[0m"
    const bold = "\x1b[1m"

    process.stderr.write(EOL)
    process.stderr.write(`  ${orange}${bold}altimate-code v${currentVersion}${reset} installed successfully!${EOL}`)
    process.stderr.write(EOL)

    // Try to show changelog for this version
    const changelog = extractChangelog("0.0.0", currentVersion)
    if (changelog) {
      // Extract only the latest version section
      const latestSection = changelog.split(/\n## \[/)[0]
      if (latestSection) {
        const dim = "\x1b[2m"
        const cyan = "\x1b[36m"
        const lines = latestSection.split("\n")
        for (const line of lines) {
          if (line.startsWith("## [")) {
            process.stderr.write(`  ${cyan}${line}${reset}${EOL}`)
          } else if (line.startsWith("### ")) {
            process.stderr.write(`  ${bold}${line}${reset}${EOL}`)
          } else if (line.trim()) {
            process.stderr.write(`  ${dim}${line}${reset}${EOL}`)
          }
        }
        process.stderr.write(EOL)
      }
    }
  } catch {
    // Non-fatal — never let banner display break the CLI
  }
}

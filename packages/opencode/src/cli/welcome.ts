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
  } catch {
    // Non-fatal — never let banner display break the CLI
  }
}

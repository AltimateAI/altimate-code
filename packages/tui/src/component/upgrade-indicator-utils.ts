// altimate_change start — fork-original component re-homed from packages/opencode/src/cli/cmd/tui
// during the v1.17.9 TUI extraction. Installation.VERSION -> InstallationVersion (core).
import semver from "semver"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const UPGRADE_KV_KEY = "update_available_version"

function isNewer(candidate: string, current: string): boolean {
  // Dev mode: show indicator for any valid semver candidate
  if (current === "local") {
    return semver.valid(candidate) !== null
  }
  if (!semver.valid(candidate) || !semver.valid(current)) {
    return false
  }
  return semver.gt(candidate, current)
}

export function getAvailableVersion(kvValue: unknown): string | undefined {
  if (typeof kvValue !== "string" || !kvValue) return undefined
  if (kvValue === InstallationVersion) return undefined
  if (!isNewer(kvValue, InstallationVersion)) return undefined
  return kvValue
}
// altimate_change end

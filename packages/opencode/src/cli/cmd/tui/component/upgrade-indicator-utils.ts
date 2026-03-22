import semver from "semver"
import { Installation } from "@/installation"

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
  if (kvValue === Installation.VERSION) return undefined
  if (!isNewer(kvValue, Installation.VERSION)) return undefined
  return kvValue
}

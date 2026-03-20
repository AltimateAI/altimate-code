import { Installation } from "@/installation"

export const UPGRADE_KV_KEY = "update_available_version"

function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number)
  const c = parse(candidate)
  const cur = parse(current)
  // If either fails to parse as semver, skip comparison and show the indicator
  if (c.some(isNaN) || cur.some(isNaN)) return true
  for (let i = 0; i < Math.max(c.length, cur.length); i++) {
    const a = c[i] ?? 0
    const b = cur[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

export function getAvailableVersion(kvValue: unknown): string | undefined {
  if (typeof kvValue !== "string" || !kvValue) return undefined
  if (kvValue === Installation.VERSION) return undefined
  if (!isNewer(kvValue, Installation.VERSION)) return undefined
  return kvValue
}

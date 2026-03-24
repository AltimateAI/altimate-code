import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"
// altimate_change start — robust upgrade notification with zero external dependencies
import { Log } from "@/util/log"

const log = Log.create({ service: "upgrade" })

/**
 * Compare two semver-like version strings. Returns:
 *   1  if a > b
 *   0  if a === b
 *  -1  if a < b
 *
 * Handles standard "major.minor.patch" and ignores prerelease suffixes
 * for the numeric comparison (prerelease is always < release).
 *
 * Zero external dependencies — this function MUST NOT import any package.
 * If it throws, the entire upgrade path breaks and users get locked on
 * old versions with no way to self-heal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Strip leading "v" if present
  const cleanA = a.replace(/^v/, "")
  const cleanB = b.replace(/^v/, "")

  // Split off prerelease suffix
  const [coreA, preA] = cleanA.split("-", 2)
  const [coreB, preB] = cleanB.split("-", 2)

  const partsA = coreA.split(".").map(Number)
  const partsB = coreB.split(".").map(Number)

  // Compare major.minor.patch numerically
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (isNaN(numA) || isNaN(numB)) return 0 // unparseable → treat as equal (safe default)
    if (numA > numB) return 1
    if (numA < numB) return -1
  }

  // Same core version: release > prerelease (e.g., 1.0.0 > 1.0.0-beta.1)
  if (!preA && preB) return 1
  if (preA && !preB) return -1

  return 0
}

/**
 * Returns true if `version` looks like a valid semver string (x.y.z with optional pre).
 * Intentionally lenient — just checks for at least "N.N.N" pattern.
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version.replace(/^v/, ""))
}

export async function upgrade() {
  const config = await Config.global()
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch((err) => {
    log.warn("failed to fetch latest version", { error: String(err), method })
    return undefined
  })
  if (!latest) return
  if (Installation.VERSION === latest) return

  // Prevent downgrade: if current version is already >= latest, skip
  if (
    Installation.VERSION !== "local" &&
    isValidVersion(Installation.VERSION) &&
    isValidVersion(latest) &&
    compareVersions(Installation.VERSION, latest) >= 0
  ) {
    return
  }

  const notify = () => Bus.publish(Installation.Event.UpdateAvailable, { version: latest })

  // Always notify when update is available, regardless of autoupdate setting
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) {
    await notify()
    return
  }
  if (config.autoupdate === "notify") {
    await notify()
    return
  }

  // Can't auto-upgrade for unknown or unsupported methods — notify instead
  if (method === "unknown" || method === "yarn") {
    await notify()
    return
  }

  await Installation.upgrade(method, latest)
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(async (err) => {
      log.warn("auto-upgrade failed, notifying instead", { error: String(err), method, target: latest })
      await notify()
    })
}
// altimate_change end

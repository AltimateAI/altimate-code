import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion, InstallationChannel, isPublishableChannel } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
// altimate_change start — re-export the centralized channel guard so existing importers
// (cli/cmd/upgrade.ts, installation/upgrade.test.ts) keep resolving it from here.
export { isPublishableChannel }
// altimate_change end

// altimate_change start — robust upgrade notification with zero external dependencies
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
// altimate_change end

export async function upgrade() {
  // altimate_change start — skip the upgrade check for local / branch / dev builds.
  // These are never published to npm or GitHub releases, so the version lookup
  // 404s and spams the TUI bottom bar (e.g. a build off branch
  // "upstream/merge-v1.17.9" whose channel becomes that branch name). isLocal()
  // covers explicit local builds; the channel-shape check covers branch-name
  // channels that aren't a valid npm dist-tag.
  if (Installation.isLocal() || !isPublishableChannel(InstallationChannel)) return
  // altimate_change end
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const method = await Installation.method()
  // altimate_change start — log fetch failures instead of swallowing them silently
  const latest = await Installation.latest(method).catch((err) => {
    console.warn(`[upgrade] failed to fetch latest version (method=${method}): ${String(err)}`)
    return undefined
  })
  // altimate_change end
  if (!latest) return
  if (InstallationVersion === latest) return

  // altimate_change start — prevent downgrade when local version is already newer than latest release
  if (
    InstallationVersion !== "local" &&
    isValidVersion(InstallationVersion) &&
    isValidVersion(latest) &&
    compareVersions(InstallationVersion, latest) >= 0
  ) {
    return
  }
  // altimate_change end

  const notify = () =>
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })

  // altimate_change start — always notify when an update is available, regardless of autoupdate setting
  // Upstream returns early on `autoupdate === false`; we surface the available update instead so
  // users on pinned/disabled-autoupdate installs still learn a newer version exists.
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE || Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    notify()
    return
  }
  // altimate_change end

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    notify()
    return
  }

  // altimate_change start — can't auto-upgrade for unknown or unsupported (yarn) methods; notify instead
  // v1.17.9's Installation.upgrade() switch has no `yarn` case (hits default → UpgradeFailedError),
  // so route yarn to a notify like `unknown` rather than letting the upgrade attempt fail.
  if (method === "unknown" || method === "yarn") {
    notify()
    return
  }
  // altimate_change end

  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    // altimate_change start — log auto-upgrade failures and fall back to a notify instead of swallowing
    .catch((err) => {
      console.warn(`[upgrade] auto-upgrade failed, notifying instead (method=${method}, target=${latest}): ${String(err)}`)
      notify()
    })
  // altimate_change end
}

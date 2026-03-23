import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"
// altimate_change start — robust upgrade notification
import semver from "semver"
import { Log } from "@/util/log"

const log = Log.create({ service: "upgrade" })

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
    semver.valid(Installation.VERSION) &&
    semver.valid(latest) &&
    semver.gte(Installation.VERSION, latest)
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

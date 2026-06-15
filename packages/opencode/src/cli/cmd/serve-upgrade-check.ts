// altimate_change start — self-update trigger for headless serve
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { upgrade } from "../upgrade"
import { Log } from "../../util/log"

const log = Log.create({ service: "serve" })

/** Delay before the one-shot startup check, letting the listener settle first. */
export const STARTUP_UPGRADE_DELAY_MS = 1000

/**
 * Runs a single best-effort upgrade check, mirroring the TUI worker
 * (`cli/cmd/tui/worker.ts` → `checkUpgrade`): provide an `Instance` context for
 * `upgrade()` but — exactly like the worker — do NOT dispose it.
 *
 * `upgrade()` reads only global config + `Installation`, but `Bus.publish`
 * (its update notifications) needs an ambient instance. We use the same
 * `process.cwd()` key the server's default-directory requests use
 * (`server/server.ts:196`), so we reuse/seed that shared cached instance rather
 * than a throwaway one, and Bus notifications still reach default-directory SSE
 * subscribers.
 *
 * Crucially we never dispose: an earlier version wrapped this in `bootstrap()`,
 * whose `finally` → `Instance.dispose()` tears down the entire `process.cwd()`
 * bucket — including state created by concurrent server requests that defaulted
 * to that directory (use-after-dispose / needless churn). The worker avoids
 * this by running in a separate thread; in-process we avoid it by not disposing.
 *
 * Resolves, never rejects: `upgrade()` swallows its own errors via the inner
 * catch; the outer guard only fires for an `Instance.provide` failure.
 */
export async function runStartupUpgradeCheck(): Promise<void> {
  try {
    await Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      fn: () => upgrade().catch((err) => log.error("startup upgrade check failed", { error: String(err) })),
    })
  } catch (err) {
    log.error("startup upgrade instance failed", { error: String(err) })
  }
}

/** Schedules {@link runStartupUpgradeCheck} after a short settle delay; non-blocking. */
export function scheduleStartupUpgradeCheck(): void {
  setTimeout(() => void runStartupUpgradeCheck(), STARTUP_UPGRADE_DELAY_MS).unref?.()
}
// altimate_change end

// altimate_change start — self-update trigger for headless serve
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { upgrade } from "../upgrade"
import { Log } from "../../util/log"

const log = Log.create({ service: "serve" })

/** Delay before the one-shot startup check, letting the listener settle first. */
export const STARTUP_UPGRADE_DELAY_MS = 1000

/**
 * Collaborators for {@link runStartupUpgradeCheck}, injectable for tests.
 *
 * Injected rather than module-mocked on purpose: bun's `mock.module` is
 * process-global, so mocking `../upgrade` / `../../project/instance` here would
 * clobber those modules for every other test in the run (e.g. blow away
 * `cli/upgrade`'s `compareVersions`/`isValidVersion` exports).
 */
export interface StartupUpgradeDeps {
  /**
   * Runs `fn` inside an ambient `Instance` for `directory` and, like the TUI
   * worker, does NOT dispose it (see note on the default below).
   */
  provide: (directory: string, fn: () => Promise<unknown>) => Promise<unknown>
  /** The upgrade check itself. */
  run: () => Promise<unknown>
}

const defaultDeps: StartupUpgradeDeps = {
  // Mirror the TUI worker (cli/cmd/tui/worker.ts → checkUpgrade): provide an
  // Instance context for upgrade() — Bus.publish needs one — but never dispose.
  //
  // We use the same process.cwd() key the server's default-directory requests
  // use (server/server.ts:196), so we reuse/seed that shared cached instance and
  // Bus notifications still reach default-directory SSE subscribers. Crucially we
  // do NOT dispose: an earlier version wrapped this in bootstrap(), whose
  // finally → Instance.dispose() tears down the entire process.cwd() bucket —
  // including state created by concurrent server requests that defaulted to that
  // directory (use-after-dispose / needless churn). The worker avoids this by
  // running in a separate thread; in-process we avoid it by not disposing.
  provide: (directory, fn) => Instance.provide({ directory, init: InstanceBootstrap, fn }),
  run: upgrade,
}

/**
 * Runs a single best-effort upgrade check. Resolves, never rejects, via two
 * layers: the inner `.catch` swallows any error from `run()` (`upgrade()` can
 * throw, e.g. from `Config.global()` / `Installation.method()`), and the outer
 * try/catch guards an `Instance.provide` (bootstrap) failure. A flaky
 * network/registry therefore can't take the server down. Errors are passed as
 * `Error` objects so `Log` formats the message + `cause` chain.
 */
export async function runStartupUpgradeCheck(deps: StartupUpgradeDeps = defaultDeps): Promise<void> {
  try {
    await deps.provide(process.cwd(), () =>
      deps.run().catch((err) => log.error("startup upgrade check failed", { error: err })),
    )
  } catch (err) {
    log.error("startup upgrade instance failed", { error: err })
  }
}

/** Schedules {@link runStartupUpgradeCheck} after a short settle delay; non-blocking. */
export function scheduleStartupUpgradeCheck(): void {
  setTimeout(() => void runStartupUpgradeCheck(), STARTUP_UPGRADE_DELAY_MS).unref?.()
}
// altimate_change end

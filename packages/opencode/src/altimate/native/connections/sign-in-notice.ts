/**
 * Shows a warehouse's interactive sign-in (Snowflake `externalbrowser` SSO) while
 * the driver waits on it. Without this the SDK opens a browser tab somewhere and
 * waits two minutes behind a spinner; a tab that opened behind other windows, or
 * never opened, looks exactly like a hang, and the agent retries into another wait.
 */
import { onBrowserSignIn, redactSignInUrl, type BrowserSignInNotice } from "@altimateai/drivers"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { fileLog } from "@/altimate/util/file-log"

const COMPLETED_TOAST_MS = 4_000

export interface SignInToast {
  title: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
}

/** C0/C1 control characters and line separators: the URL comes from the identity provider. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "")
}

function label(n: BrowserSignInNotice): string {
  const name = n.warehouse.charAt(0).toUpperCase() + n.warehouse.slice(1)
  return n.account ? `${name} (account ${clean(n.account)})` : name
}

/** What to show for a notice; undefined when nothing should be shown (a failure is reported by the tool). */
export function toastFor(n: BrowserSignInNotice): SignInToast | undefined {
  if (n.phase === "waiting") {
    const minutes = Math.max(1, Math.round((n.timeoutMs ?? 120_000) / 60_000))
    const link = n.url ? ` If no browser tab opened, open this link: ${clean(n.url)}` : ""
    return {
      title: "Waiting for sign-in",
      message: `Sign in to ${label(n)} in your browser. Waiting up to ${minutes} minute${minutes === 1 ? "" : "s"}.${link}`,
      variant: "warning",
      duration: n.timeoutMs ?? 120_000,
    }
  }
  if (n.phase === "completed") {
    return { title: "Signed in", message: `Signed in to ${label(n)}.`, variant: "success", duration: COMPLETED_TOAST_MS }
  }
  return undefined
}

export interface SignInNoticeDeps {
  headless: () => boolean
  toast: (t: SignInToast) => Promise<void>
  printLine: (line: string) => void
}

const defaultDeps: SignInNoticeDeps = {
  headless: () => process.env["ALTIMATE_CODE_HEADLESS"] === "1",
  toast: async (t) => {
    await AppRuntime.runPromise(EventV2Bridge.Service.use((events) => events.publish(TuiEvent.ToastShow, t)))
  },
  printLine: (line) => {
    try {
      process.stderr.write(line + "\n")
    } catch {
      // stderr closed — the log still has it
    }
  },
}

export function handle(n: BrowserSignInNotice, deps: SignInNoticeDeps = defaultDeps): void {
  fileLog("INFO", "warehouse-sign-in", "browser sign-in", {
    warehouse: n.warehouse,
    account: n.account,
    phase: n.phase,
    ...(n.url ? { url: redactSignInUrl(n.url) } : {}),
    ...(n.timeoutMs ? { timeout_ms: n.timeoutMs } : {}),
  })
  const t = toastFor(n)
  if (!t) return
  if (deps.headless()) {
    // `run` has no screen for a toast; the waiting line is the one that matters.
    if (n.phase === "waiting") deps.printLine(`${t.title}: ${t.message}`)
    return
  }
  deps.toast(t).catch((err) => fileLog("WARN", "warehouse-sign-in", "could not show the sign-in notice", { err: String(err) }))
}

let unsubscribe: (() => void) | undefined

/** Idempotent; called before every warehouse connect. */
export function install(deps: SignInNoticeDeps = defaultDeps): void {
  if (unsubscribe) return
  unsubscribe = onBrowserSignIn((n) => handle(n, deps))
}

export function resetForTests(): void {
  unsubscribe?.()
  unsubscribe = undefined
}

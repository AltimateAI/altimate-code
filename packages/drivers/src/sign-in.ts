import { spawn } from "child_process"

/**
 * Interactive sign-in a driver is waiting on (today: Snowflake `externalbrowser`
 * SSO). The SDK opens the browser and waits silently; without this the user sees
 * only a spinner and cannot tell a pending sign-in from a hang.
 */
export interface BrowserSignInNotice {
  warehouse: string
  /** Identifies which account is asking, e.g. the Snowflake account locator. */
  account?: string
  phase: "waiting" | "completed" | "failed"
  /** The sign-in page. Only on `waiting`. */
  url?: string
  /** How long the driver waits for the sign-in before failing. Only on `waiting`. */
  timeoutMs?: number
}

type Listener = (notice: BrowserSignInNotice) => void

// Process-global: the driver and its subscriber can reach this file through
// different module graphs (the bundle and a dynamic driver import), and a
// per-module set would silently drop every notice.
const LISTENERS_KEY = Symbol.for("altimate.drivers.browserSignInListeners")
const listeners: Set<Listener> = ((globalThis as Record<symbol, unknown>)[LISTENERS_KEY] as Set<Listener>) ??
  ((globalThis as Record<symbol, unknown>)[LISTENERS_KEY] = new Set<Listener>())

/** Subscribe to sign-in notices from every driver. Returns the unsubscribe. */
export function onBrowserSignIn(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitBrowserSignIn(notice: BrowserSignInNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice)
    } catch {
      // a broken listener must not fail the connection
    }
  }
}

let opener: (url: string) => void = launchBrowser

/** Opens a URL in the default browser, the way the SDK's own opener does. Failure is silent: the URL is also surfaced to the user. */
export function openInBrowser(url: string): void {
  opener(url)
}

/** Replaces the browser launcher; tests pass a recorder so nothing opens. Returns the restore. */
export function setBrowserOpenerForTests(fn: (url: string) => void): () => void {
  opener = fn
  return () => {
    opener = launchBrowser
  }
}

function launchBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? // No shell, so `&` in the SAML query needs no escaping (unlike `cmd /c start`).
        ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore", windowsHide: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // no browser launcher — the notice still carries the URL
  }
}

/** The sign-in URL without its query string, for logs. The query carries the SAML request. */
export function redactSignInUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return "<invalid url>"
  }
}

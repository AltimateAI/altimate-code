// altimate_change start — restore the terminal when the process exits without tearing the renderer down
/**
 * OpenTUI turns on mouse tracking, focus/paste reporting and extended keyboard
 * modes, and only switches them off when the renderer is destroyed. A process
 * that exits without that (an exit from deep in a tool, an uncaught error path
 * the renderer does not catch) leaves the terminal reporting every mouse move and
 * key press as text — `[555;96;44M…` typed into the shell prompt, Esc included.
 *
 * Only on an unclean exit: after a clean teardown the modes are already off, and
 * popping the keyboard-mode stack again could remove the shell's own setting.
 * Covers a normal exit and SIGTERM (`kill <pid>`), whose default action ends the
 * process without an `exit` event. Nothing here can run after SIGKILL or a native crash.
 */
import { writeSync } from "fs"

/** Undoes exactly the modes OpenTUI 0.3.x enables (mouse 1000/1002/1003/1006, focus 1004,
 * bracketed paste 2004, colour-scheme reports 2031, kitty keyboard push, modifyOtherKeys),
 * shows the cursor and leaves the alternate screen. */
export const TERMINAL_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2031l" +
  "\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?1049l"

/** How long SIGTERM waits for the TUI's own shutdown before ending the process. */
export const SIGTERM_GRACE_MS = 3_000

export interface TerminalRestoreDeps {
  onExit: (fn: () => void) => () => void
  onTerminate: (fn: () => void) => () => void
  /** The TUI's own graceful shutdown (the path SIGHUP takes), so its finalizers run. */
  shutdown: () => void
  /** Runs `fn` after `ms`; returns a cancel. */
  later: (fn: () => void, ms: number) => () => void
  exit: (code: number) => void
  write: (text: string) => void
  isTTY: () => boolean
  /** Leave raw input mode; the renderer's teardown does this on a clean exit. */
  cookInput: () => void
}

const defaultDeps: TerminalRestoreDeps = {
  onExit: (fn) => {
    process.once("exit", fn)
    return () => process.off("exit", fn)
  },
  onTerminate: (fn) => {
    process.on("SIGTERM", fn)
    return () => process.off("SIGTERM", fn)
  },
  shutdown: () => {},
  later: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return () => clearTimeout(t)
  },
  exit: (code) => process.exit(code),
  write: (text) => writeSync(1, text),
  isTTY: () => Boolean(process.stdout.isTTY),
  cookInput: () => {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false)
  },
}

/** Registers the exit guard for `renderer`; returns the unregister. */
export function restoreTerminalOnUncleanExit(
  renderer: { readonly isDestroyed: boolean },
  overrides: Partial<TerminalRestoreDeps> = {},
): () => void {
  const deps = { ...defaultDeps, ...overrides }
  const restore = () => {
    if (renderer.isDestroyed) return
    try {
      // Without this the shell is left without echo or line editing. Done whether or not stdout is a terminal:
      // stdin can be one while stdout is redirected.
      deps.cookInput()
    } catch {
      // stdin already gone
    }
    if (!deps.isTTY()) return
    try {
      deps.write(TERMINAL_RESET)
    } catch {
      // stdout already gone — nothing left to restore
    }
  }
  const offExit = deps.onExit(restore)
  // SIGTERM's default action ends the process with no cleanup at all. Take the TUI's own shutdown instead, as SIGHUP
  // does, so its finalizers run; if that has not ended the process within the grace period, exit with 143 (the
  // status the default action gives), which still runs the restore above.
  let cancelFallback: (() => void) | undefined
  const offTerminate = deps.onTerminate(() => {
    deps.shutdown()
    cancelFallback = deps.later(() => deps.exit(143), SIGTERM_GRACE_MS)
  })
  // Unregistered by the TUI's own teardown: a shutdown that completed in time cancels the fallback exit, which would
  // otherwise end a host process that is still running.
  return () => {
    offExit()
    offTerminate()
    cancelFallback?.()
  }
}
// altimate_change end

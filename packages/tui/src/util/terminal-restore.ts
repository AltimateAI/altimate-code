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
 * Nothing here can run after a hard kill or a native crash.
 */
import { writeSync } from "fs"

/** Undoes exactly the modes OpenTUI 0.3.x enables (mouse 1000/1002/1003/1006, focus 1004,
 * bracketed paste 2004, colour-scheme reports 2031, kitty keyboard push, modifyOtherKeys),
 * shows the cursor and leaves the alternate screen. */
export const TERMINAL_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2031l" +
  "\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?1049l"

export interface TerminalRestoreDeps {
  onExit: (fn: () => void) => () => void
  write: (text: string) => void
  isTTY: () => boolean
}

const defaultDeps: TerminalRestoreDeps = {
  onExit: (fn) => {
    process.once("exit", fn)
    return () => process.off("exit", fn)
  },
  write: (text) => writeSync(1, text),
  isTTY: () => Boolean(process.stdout.isTTY),
}

/** Registers the exit guard for `renderer`; returns the unregister. */
export function restoreTerminalOnUncleanExit(
  renderer: { readonly isDestroyed: boolean },
  deps: TerminalRestoreDeps = defaultDeps,
): () => void {
  return deps.onExit(() => {
    if (renderer.isDestroyed || !deps.isTTY()) return
    try {
      deps.write(TERMINAL_RESET)
    } catch {
      // stdout already gone — nothing left to restore
    }
  })
}
// altimate_change end

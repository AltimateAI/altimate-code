// altimate_change start — terminal restore on an unclean exit
import { describe, expect, test } from "bun:test"
import { restoreTerminalOnUncleanExit, TERMINAL_RESET } from "../src/util/terminal-restore"

function harness(opts: { destroyed: boolean; tty?: boolean }) {
  const renderer = { isDestroyed: opts.destroyed }
  let exitHandler: (() => void) | undefined
  let termHandler: (() => void) | undefined
  const exits: number[] = []
  const shutdowns: number[] = []
  const pending: Array<() => void> = []
  const cooked: number[] = []
  const written: string[] = []
  const unregister = restoreTerminalOnUncleanExit(renderer, {
    onExit: (fn) => {
      exitHandler = fn
      return () => {
        exitHandler = undefined
      }
    },
    onTerminate: (fn) => {
      termHandler = fn
      return () => {
        termHandler = undefined
      }
    },
    exit: (code) => {
      exits.push(code)
      exitHandler?.() // process.exit fires the exit event
    },
    shutdown: () => void shutdowns.push(1),
    later: (fn) => {
      pending.push(fn)
      return () => pending.splice(pending.indexOf(fn), 1)
    },
    cookInput: () => void cooked.push(1),
    write: (t) => void written.push(t),
    isTTY: () => opts.tty ?? true,
  })
  return {
    renderer,
    written,
    exits,
    shutdowns,
    cooked,
    exit: () => exitHandler?.(),
    term: () => termHandler?.(),
    elapse: () => pending.splice(0).forEach((fn) => fn()),
    unregister,
  }
}

describe("terminal restore on exit", () => {
  test("an exit that skipped the renderer teardown switches every reporting mode off", () => {
    const h = harness({ destroyed: false })
    h.exit()
    expect(h.written).toEqual([TERMINAL_RESET])
    for (const mode of ["?1000l", "?1002l", "?1003l", "?1006l", "?1004l", "?2004l", "?2031l", "<u", ">4;0m"]) {
      expect(TERMINAL_RESET).toContain("\x1b[" + mode)
    }
  })

  test("after a clean teardown nothing is written, so the shell's own keyboard mode is left alone", () => {
    const h = harness({ destroyed: false })
    h.renderer.isDestroyed = true
    h.exit()
    expect(h.written).toEqual([])
  })

  test("SIGTERM takes the TUI's own shutdown first, and only exits (restoring the terminal) if that stalls", () => {
    const h = harness({ destroyed: false })
    h.term()
    expect(h.shutdowns).toEqual([1])
    expect(h.exits).toEqual([])
    h.elapse() // the grace period passes with the process still up
    expect(h.exits).toEqual([143])
    expect(h.written).toEqual([TERMINAL_RESET])
  })

  test("an unclean exit also takes stdin out of raw mode, even with stdout redirected", () => {
    const h = harness({ destroyed: false })
    h.exit()
    expect(h.cooked).toEqual([1])
    const redirected = harness({ destroyed: false, tty: false })
    redirected.exit()
    expect(redirected.cooked).toEqual([1])
    expect(redirected.written).toEqual([])
  })

  test("repeated SIGTERMs arm one fallback, which the teardown cancels", () => {
    const h = harness({ destroyed: false })
    h.term()
    h.term()
    h.unregister()
    h.elapse()
    expect(h.exits).toEqual([])
  })

  test("a shutdown that finishes in time cancels the fallback exit", () => {
    const h = harness({ destroyed: false })
    h.term()
    h.unregister() // the TUI's own teardown ran
    h.elapse()
    expect(h.exits).toEqual([])
  })

  test("unregistering removes both guards", () => {
    const h = harness({ destroyed: false })
    h.unregister()
    h.term()
    h.exit()
    expect(h.written).toEqual([])
  })

  test("nothing is written when stdout is not a terminal", () => {
    const h = harness({ destroyed: false, tty: false })
    h.exit()
    expect(h.written).toEqual([])
  })
})
// altimate_change end

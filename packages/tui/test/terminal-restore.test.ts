// altimate_change start — terminal restore on an unclean exit
import { describe, expect, test } from "bun:test"
import { restoreTerminalOnUncleanExit, TERMINAL_RESET } from "../src/util/terminal-restore"

function harness(opts: { destroyed: boolean; tty?: boolean }) {
  const renderer = { isDestroyed: opts.destroyed }
  let exitHandler: (() => void) | undefined
  let termHandler: (() => void) | undefined
  const exits: number[] = []
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
    write: (t) => void written.push(t),
    isTTY: () => opts.tty ?? true,
  })
  return { renderer, written, exits, exit: () => exitHandler?.(), term: () => termHandler?.(), unregister }
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

  test("SIGTERM restores the terminal and still ends the process with 143", () => {
    // SIGTERM's default action ends the process without an `exit` event, so `kill <pid>` left the modes on.
    const h = harness({ destroyed: false })
    h.term()
    expect(h.written).toEqual([TERMINAL_RESET])
    expect(h.exits).toEqual([143])
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

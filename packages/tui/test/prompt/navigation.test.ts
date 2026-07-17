import { describe, expect, test } from "bun:test"
import {
  isPromptCursorOnFirstLine,
  isPromptCursorOnLastLine,
  movePromptCursorToLineEnd,
  movePromptCursorToLineHome,
  type PromptLineNavigationState,
} from "../../src/prompt/navigation"

// altimate_change start — prompt input line navigation tests
function inputLineState(scrollY: number, visualRow: number, totalLines: number): PromptLineNavigationState {
  return {
    scrollY,
    visualCursor: {
      visualRow,
    },
    editorView: {
      getTotalVirtualLineCount: () => totalLines,
    },
  }
}

describe("prompt input navigation", () => {
  test("detects first and last visual input lines", () => {
    expect(isPromptCursorOnFirstLine(inputLineState(0, 0, 3))).toBe(true)
    expect(isPromptCursorOnFirstLine(inputLineState(0, 1, 3))).toBe(false)
    expect(isPromptCursorOnFirstLine(inputLineState(1, 0, 3))).toBe(false)

    expect(isPromptCursorOnLastLine(inputLineState(0, 2, 3))).toBe(true)
    expect(isPromptCursorOnLastLine(inputLineState(1, 1, 3))).toBe(true)
    expect(isPromptCursorOnLastLine(inputLineState(0, 1, 3))).toBe(false)
  })

  test("moves to logical line home and end through textarea APIs", () => {
    const calls: string[] = []
    const input = {
      gotoLineHome() {
        calls.push("home")
        return true
      },
      gotoLineEnd() {
        calls.push("end")
        return true
      },
    }

    expect(movePromptCursorToLineHome(input)).toBe(true)
    expect(movePromptCursorToLineEnd(input)).toBe(true)
    expect(calls).toEqual(["home", "end"])
  })
})
// altimate_change end

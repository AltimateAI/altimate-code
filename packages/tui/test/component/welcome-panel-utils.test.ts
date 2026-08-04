import { expect, test } from "bun:test"
import {
  FULL_MIN_HEIGHT,
  FULL_MIN_WIDTH,
  MEDIUM_MIN_HEIGHT,
  MEDIUM_MIN_WIDTH,
  PANEL_VERTICAL_RESERVE,
  welcomePanelVariant,
} from "../../src/component/welcome-panel-utils"

// Comfortably above the full floor on one axis, used to isolate the OTHER axis
// so a single gate's removal is provable (each test below fails if its `<` check
// is deleted from the source).
const TALL = FULL_MIN_HEIGHT + 10
const WIDE = FULL_MIN_WIDTH + 20

test("full requires BOTH width and height to clear the full floor", () => {
  expect(welcomePanelVariant(WIDE, TALL)).toBe("full")
  expect(welcomePanelVariant(FULL_MIN_WIDTH, FULL_MIN_HEIGHT)).toBe("full") // exactly at the floor
})

test("full's width gate is real — width one below the floor drops to medium even when tall", () => {
  expect(welcomePanelVariant(FULL_MIN_WIDTH - 1, TALL)).toBe("medium")
})

test("full's height gate is real — height one below the floor drops to medium even when wide", () => {
  expect(welcomePanelVariant(WIDE, FULL_MIN_HEIGHT - 1)).toBe("medium")
})

test("compact's width gate is real — width one below the medium floor is compact even when tall", () => {
  expect(welcomePanelVariant(MEDIUM_MIN_WIDTH - 1, TALL)).toBe("compact")
})

test("compact's height gate is real — height one below the medium floor is compact even when wide", () => {
  expect(welcomePanelVariant(WIDE, MEDIUM_MIN_HEIGHT - 1)).toBe("compact")
})

test("compact→medium boundary is exact (at the floor is medium)", () => {
  expect(welcomePanelVariant(MEDIUM_MIN_WIDTH, MEDIUM_MIN_HEIGHT)).toBe("medium")
  expect(welcomePanelVariant(MEDIUM_MIN_WIDTH, TALL)).toBe("medium")
  expect(welcomePanelVariant(WIDE, MEDIUM_MIN_HEIGHT)).toBe("medium")
})

test("everyday terminals get medium, not the oversized wordmark", () => {
  // Inputs are AVAILABLE size (terminal minus padding/sidebar on width, minus
  // PANEL_VERTICAL_RESERVE on height). A 106x31 terminal → ~(102, 23):
  expect(welcomePanelVariant(102, 23)).toBe("medium")
  // 80x24 terminal → ~(76, 16) — medium exactly at the height floor:
  expect(welcomePanelVariant(76, 16)).toBe("medium")
  // #1067 session case: a 130-col terminal with the 42-col sidebar leaves ~84
  // usable cols → medium (was wrongly full when it used the whole terminal width).
  expect(welcomePanelVariant(130 - 42 - 4, 50 - PANEL_VERTICAL_RESERVE)).toBe("medium")
})

test("a short terminal drops to compact once prompt/footer chrome is reserved (#1067 height)", () => {
  // 120x22: wide, but only ~14 usable rows after the ~8-row chrome → compact,
  // where the raw terminal height (22) would have picked medium.
  expect(welcomePanelVariant(120 - 4, 22 - PANEL_VERTICAL_RESERVE)).toBe("compact")
})

test("degenerate sizes collapse to compact", () => {
  expect(welcomePanelVariant(0, 0)).toBe("compact")
  expect(welcomePanelVariant(1, 1)).toBe("compact")
})

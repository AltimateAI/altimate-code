import { expect, test } from "bun:test"
import {
  FULL_MIN_HEIGHT,
  FULL_MIN_WIDTH,
  HOME_VERTICAL_RESERVE,
  MEDIUM_MIN_HEIGHT,
  MEDIUM_MIN_WIDTH,
  PANEL_HORIZONTAL_PADDING,
  SESSION_VERTICAL_RESERVE,
  welcomePanelVariant,
} from "../../src/component/welcome-panel-utils"

// Comfortably above the full floor on one axis, used to isolate the OTHER axis
// so a single gate's removal is provable (each test below fails if its `<` check
// is deleted from the source, or flipped to `<=`).
const TALL = FULL_MIN_HEIGHT + 10
const WIDE = FULL_MIN_WIDTH + 20

// Map a terminal size to the AVAILABLE size each route feeds the pure function.
const home = (w: number, h: number) => welcomePanelVariant(w - PANEL_HORIZONTAL_PADDING, h - HOME_VERTICAL_RESERVE)
const session = (w: number, h: number, sidebar: boolean) =>
  welcomePanelVariant(w - (sidebar ? 42 : 0) - PANEL_HORIZONTAL_PADDING, h - SESSION_VERTICAL_RESERVE)

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
  expect(home(106, 31)).toBe("medium")
  expect(home(80, 24)).toBe("medium")
  // #1067 session case: a 130-col terminal with the 42-col sidebar leaves ~84
  // usable cols → medium (was wrongly full when it used the whole terminal width).
  expect(session(130, 50, true)).toBe("medium")
})

test("the classic 80x24 is medium on both routes, with margin off the compact floor", () => {
  // The review flagged 80x24 sitting on the exact medium floor; it now clears it
  // on both routes (home reserves more chrome, so it's the tighter one).
  expect(home(80, 24)).toBe("medium")
  expect(session(80, 24, false)).toBe("medium")
})

test("full engages on a large window; ~one row below the floor stays medium", () => {
  expect(home(120, 44)).toBe("full") // FULL_MIN_HEIGHT(34) + HOME_VERTICAL_RESERVE(10)
  expect(home(120, 43)).toBe("medium")
})

test("toggling the session sidebar flips the panel full → medium on a wide window (#1067)", () => {
  // The exact regression #1067 reports: on a wide window, opening the 42-col
  // sidebar must shrink the panel out of `full` — it no longer has ~110 usable cols.
  expect(session(150, 50, false)).toBe("full")
  expect(session(150, 50, true)).toBe("medium")
})

test("a short terminal drops to compact once the route's chrome is reserved (#1067 height)", () => {
  // 120x22: wide, but too few usable rows after the home chrome → compact, where
  // the raw terminal height (22) would have picked medium.
  expect(home(120, 22)).toBe("compact")
})

test("degenerate sizes collapse to compact", () => {
  expect(welcomePanelVariant(0, 0)).toBe("compact")
  expect(welcomePanelVariant(1, 1)).toBe("compact")
})

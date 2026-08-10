import { expect, test } from "bun:test"
import {
  FULL_MIN_HEIGHT,
  FULL_MIN_WIDTH,
  HOME_VERTICAL_RESERVE,
  MEDIUM_MIN_HEIGHT,
  MEDIUM_MIN_WIDTH,
  SESSION_VERTICAL_RESERVE,
  homeAvailable,
  sessionAvailable,
  welcomePanelVariant,
} from "../../src/component/welcome-panel-utils"

// Comfortably above the full floor on one axis, used to isolate the OTHER axis
// so a single gate's removal is provable (each test below fails if its `<` check
// is deleted from the source, or flipped to `<=`).
const TALL = FULL_MIN_HEIGHT + 10
const WIDE = FULL_MIN_WIDTH + 20

// Map a terminal size to a variant THROUGH the exact functions the routes call
// (homeAvailable / sessionAvailable), so these tests exercise the real call-site
// arithmetic rather than a private copy of it. `sidebarVisible` is the route's
// sidebarVisible() — the content column narrows whenever the sidebar is open.
const home = (w: number, h: number) => {
  const a = homeAvailable(w, h)
  return welcomePanelVariant(a.width, a.height)
}
const session = (w: number, h: number, sidebarVisible: boolean) => {
  const a = sessionAvailable(w, h, sidebarVisible)
  return welcomePanelVariant(a.width, a.height)
}

test("reserves stay pinned to the counted chrome", () => {
  // If someone changes the reserve to a wrong literal, this fails. The values are
  // derived sums of the documented per-route chrome (see welcome-panel-utils.ts).
  expect(HOME_VERTICAL_RESERVE).toBe(15)
  expect(SESSION_VERTICAL_RESERVE).toBe(9)
})

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
  // #1067 session case: a 130-col terminal with the in-flow 42-col sidebar leaves
  // ~84 usable cols → medium (was wrongly full when it used the whole terminal).
  expect(session(130, 50, true)).toBe("medium")
})

test("the classic 80x24 is medium on both routes (a real fit, not a fake margin)", () => {
  // 80x24 → home available (76 × 9), session available (76 × 15). Both clear the
  // medium floor (60 × 8) — the medium panel is ~8 rows, so this actually fits.
  expect(home(80, 24)).toBe("medium")
  expect(session(80, 24, false)).toBe("medium")
})

test("full engages on a large window; ~one row below the floor stays medium", () => {
  // full needs available height ≥ FULL_MIN_HEIGHT(30); home reserves 15, so the
  // terminal must be ≥ 45 rows.
  expect(home(120, 45)).toBe("full")
  expect(home(120, 44)).toBe("medium")
})

test("toggling the in-flow session sidebar flips the panel full → medium on a wide window (#1067)", () => {
  // The exact regression #1067 reports: on a wide window the sidebar is in-flow,
  // and opening it must shrink the panel out of `full` (no longer ≥110 usable cols).
  expect(session(150, 50, false)).toBe("full")
  expect(session(150, 50, true)).toBe("medium")
})

test("the content column narrows whenever the sidebar is open, incl. the overlay (aligned with messages)", () => {
  // On a ≤120-col terminal the sidebar is a dimmed full-area overlay, but the
  // content column (messages + panel) still narrows uniformly so they stay
  // aligned and both restore when it closes — sizing to the narrowed column, not
  // the transient obscured width. 100 cols: open → 54 usable → compact; closed →
  // 96 → medium. (Matches session's contentWidth basis; deliberate, per review.)
  expect(session(100, 50, true)).toBe("compact")
  expect(session(100, 50, false)).toBe("medium")
})

test("a short terminal drops to compact once the route's chrome is reserved (#1067 height)", () => {
  // 120x22: wide, but too few usable rows after the home chrome → compact, where
  // the raw terminal height (22) would have picked medium.
  expect(home(120, 22)).toBe("compact")
})

test("negative available height (a tiny terminal) collapses to compact, never throws", () => {
  // 80x5 → home available height 5 - 15 = -10; must resolve, not crash.
  expect(home(80, 5)).toBe("compact")
  expect(session(80, 5, false)).toBe("compact")
})

test("degenerate sizes collapse to compact", () => {
  expect(welcomePanelVariant(0, 0)).toBe("compact")
  expect(welcomePanelVariant(1, 1)).toBe("compact")
  expect(welcomePanelVariant(-5, -5)).toBe("compact")
})

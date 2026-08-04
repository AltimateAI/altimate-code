import { expect, test } from "bun:test"
import {
  COMPACT_MAX_HEIGHT,
  COMPACT_MAX_WIDTH,
  MEDIUM_MAX_HEIGHT,
  MEDIUM_MAX_WIDTH,
  welcomePanelVariant,
} from "../../src/component/welcome-panel-utils"

test("large terminals get the full two-column boot box", () => {
  expect(welcomePanelVariant(MEDIUM_MAX_WIDTH + 20, MEDIUM_MAX_HEIGHT + 10)).toBe("full")
  expect(welcomePanelVariant(MEDIUM_MAX_WIDTH, MEDIUM_MAX_HEIGHT)).toBe("full") // at the threshold
})

test("a narrow OR short terminal drops the wordmark (medium)", () => {
  expect(welcomePanelVariant(80, 24)).toBe("medium")
  expect(welcomePanelVariant(MEDIUM_MAX_WIDTH - 1, 40)).toBe("medium") // narrow but tall
  expect(welcomePanelVariant(120, MEDIUM_MAX_HEIGHT - 1)).toBe("medium") // wide but short
})

test("a very small terminal collapses to the single-line compact panel", () => {
  expect(welcomePanelVariant(50, 12)).toBe("compact")
  expect(welcomePanelVariant(COMPACT_MAX_WIDTH - 1, 40)).toBe("compact") // very narrow, any height
  expect(welcomePanelVariant(120, COMPACT_MAX_HEIGHT - 1)).toBe("compact") // very short, any width
})

test("both axes gate each step down — the smaller dimension wins", () => {
  // Wide enough for full on width, but height forces compact.
  expect(welcomePanelVariant(200, COMPACT_MAX_HEIGHT - 1)).toBe("compact")
  // Tall enough for full on height, but width forces compact.
  expect(welcomePanelVariant(COMPACT_MAX_WIDTH - 1, 200)).toBe("compact")
})

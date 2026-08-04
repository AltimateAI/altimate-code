// Pure breakpoint logic for WelcomePanel, split out (like upgrade-indicator-utils)
// so it's unit-testable without the component's render/context dependencies.
//
// The full two-column boot box (block wordmark + description) is a ~13-row
// bordered box, so on a typical terminal it eats ~40% of the screen with no way
// to shrink it (issue #1067). We scale it down by the space the panel ACTUALLY
// has on both axes:
//   - width:  the terminal minus the caller's padding and any sibling sidebar.
//   - height: the terminal minus the fixed chrome that always shares the column
//             with the panel (top spacer + prompt + footer), so a big panel is
//             chosen only when it won't crowd the prompt off a short terminal.
// `medium` (no wordmark) is the common case; `full` only when there's real room.
//
// Naming: these are the MINIMUMS a tier requires, matched with strict `<`
// (`width < FULL_MIN_WIDTH` → not full). MEDIUM_MIN_* is the floor for medium
// (below → compact); FULL_MIN_* is the floor for full (below → medium). All in
// terms of AVAILABLE (usable) size, not the raw terminal.

export type WelcomePanelVariant = "full" | "medium" | "compact"

/**
 * Rows the panel must leave for the always-present chrome below/around it (the
 * prompt, the footer, and the home top spacer). Callers subtract this from the
 * terminal height to get the panel's usable height. An estimate — the prompt can
 * grow with multi-line input, but at rest this is the fixed cost.
 */
export const PANEL_VERTICAL_RESERVE = 8

/** Minimum usable size for the medium panel; below either → compact (one line). */
export const MEDIUM_MIN_WIDTH = 60
export const MEDIUM_MIN_HEIGHT = 16
/** Minimum usable size for the full wordmark panel; below either → medium. */
export const FULL_MIN_WIDTH = 110
export const FULL_MIN_HEIGHT = 36

/**
 * Choose the WelcomePanel layout from the panel's AVAILABLE size — width already
 * minus padding/sidebar, height already minus PANEL_VERTICAL_RESERVE. Not the
 * raw terminal (that's the #1067 bug: a sidebar-narrowed column, or a short
 * terminal, would still pick `full`).
 */
export function welcomePanelVariant(width: number, height: number): WelcomePanelVariant {
  if (width < MEDIUM_MIN_WIDTH || height < MEDIUM_MIN_HEIGHT) return "compact"
  if (width < FULL_MIN_WIDTH || height < FULL_MIN_HEIGHT) return "medium"
  return "full"
}

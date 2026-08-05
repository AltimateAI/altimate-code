// Pure breakpoint logic for WelcomePanel, split out (like upgrade-indicator-utils)
// so it's unit-testable without the component's render/context dependencies.
//
// The full two-column boot box (block wordmark + description) is a ~13-row
// bordered box, so on a typical terminal it eats ~40% of the screen with no way
// to shrink it (issue #1067). We scale it down by the space the panel ACTUALLY
// has on both axes:
//   - width:  the terminal minus the caller's padding and any sibling sidebar.
//   - height: the terminal minus the fixed chrome that always shares the column
//             with the panel (see the per-route reserves below), so a big panel
//             is chosen only when it won't crowd the prompt off a short terminal.
// `medium` (no wordmark) is the common case; `full` only when there's real room.
//
// Naming: these are the MINIMUMS a tier requires, matched with strict `<`
// (`width < FULL_MIN_WIDTH` -> not full). MEDIUM_MIN_* is the floor for medium
// (below -> compact); FULL_MIN_* is the floor for full (below -> medium). All in
// terms of AVAILABLE (usable) size, not the raw terminal.

export type WelcomePanelVariant = "full" | "medium" | "compact"

// Rows the panel must leave for the always-present chrome that shares its column.
// The two routes have different chrome, so they reserve different amounts; the
// shared thresholds below then transition ~3 rows of terminal height apart
// between the routes (session, with less chrome, shows a bigger variant sooner).
// Estimates — the prompt can grow with multi-line input; this is the at-rest cost.
//
// home (routes/home.tsx): top spacer (2) + prompt wrapper paddingTop (1) + prompt
//   (~4) + footer (~3, feature-plugins/home/footer.tsx) ≈ 10.
export const HOME_VERTICAL_RESERVE = 10
// session (routes/session/index.tsx): two column gaps (2) + paddingBottom (1) +
//   prompt (~4); no top spacer, no footer in that column ≈ 7.
export const SESSION_VERTICAL_RESERVE = 7

// Columns the home slot spends on its own left/right padding (2 + 2); the caller
// subtracts this to get the panel's usable width. (Session's contentWidth applies
// the same 4 as part of its own content-column math.)
export const PANEL_HORIZONTAL_PADDING = 4

/** Minimum usable size for the medium panel; below either -> compact (one line). */
export const MEDIUM_MIN_WIDTH = 60
export const MEDIUM_MIN_HEIGHT = 13
/** Minimum usable size for the full wordmark panel; below either -> medium. */
export const FULL_MIN_WIDTH = 110
export const FULL_MIN_HEIGHT = 34

/**
 * Choose the WelcomePanel layout from the panel's AVAILABLE size — width already
 * minus padding/sidebar, height already minus the route's vertical reserve. Not
 * the raw terminal (that's the #1067 bug: a sidebar-narrowed column, or a short
 * terminal, would still pick `full`).
 */
export function welcomePanelVariant(width: number, height: number): WelcomePanelVariant {
  if (width < MEDIUM_MIN_WIDTH || height < MEDIUM_MIN_HEIGHT) return "compact"
  if (width < FULL_MIN_WIDTH || height < FULL_MIN_HEIGHT) return "medium"
  return "full"
}

// Pure breakpoint logic for WelcomePanel, split out (like upgrade-indicator-utils)
// so it's unit-testable without the component's render/context dependencies.
//
// The full two-column boot box (block wordmark + description) is a ~13-row
// bordered box, so on a typical terminal it eats ~40% of the screen with no way
// to shrink it (issue #1067). We scale it down by the space the panel ACTUALLY
// has on both axes:
//   - width:  the terminal minus the caller's padding and any sibling sidebar
//             that consumes layout width.
//   - height: the terminal minus the fixed chrome that always shares the column
//             with the panel (the per-route reserves below), so a big panel is
//             chosen only when it won't crowd the prompt off a short terminal.
// `medium` (no wordmark) is the common case; `full` only when there's real room.
//
// Route arithmetic lives here (homeAvailable / sessionAvailable) so the routes
// and the tests share ONE definition — a test that maps a terminal size to a
// variant then exercises the real call-site math, not a copy of it.

export type WelcomePanelVariant = "full" | "medium" | "compact"

// --- Chrome reserves (rows the panel must leave for always-present siblings) ---
//
// Prompt tree at rest (component/prompt/index.tsx): top rule 1 + inner paddingTop
// 1 + textarea 1 + separator 1 + agent/model meta row 1 + idle hint row 1 = 6.
// Measured against the rendered tree, not estimated — the earlier "~4" undercounted
// it (the meta and hint rows are always in flow).
const PROMPT_REST_HEIGHT = 6

// home (routes/home.tsx): top spacer 2 (`<box height={2}>`) + prompt wrapper
// paddingTop 1 + prompt 6 + home_bottom slot 3 (feature-plugins/home/tips.tsx
// paddingTop, rendered unconditionally — flexbox shrinks content, not padding) +
// footer 3 (feature-plugins/home/footer.tsx) = 15.
export const HOME_VERTICAL_RESERVE = 2 + 1 + PROMPT_REST_HEIGHT + 3 + 3
// session (routes/session/index.tsx): two column gaps 2 + paddingBottom 1 +
// prompt 6 = 9. No top spacer and no footer share this column.
export const SESSION_VERTICAL_RESERVE = 2 + 1 + PROMPT_REST_HEIGHT

// Columns the home slot spends on its own left/right padding (2 + 2). Session
// subtracts the same via sessionAvailable(); both routes import this constant so
// the value has a single source of truth.
export const PANEL_HORIZONTAL_PADDING = 4
// Width the session sidebar occupies WHEN it consumes layout width (i.e. it is
// rendered in-flow, not as an overlay). Shared with the route + tests so they
// can't drift — the drift that produced #1067.
export const SIDEBAR_WIDTH = 42

// --- Thresholds ---
// MEDIUM_MIN_* is a real FIT requirement: below it the medium panel (~8 rows /
// ~a title + one/two-line description) would not fit, so drop to the one-line
// compact. FULL_MIN_* is a product BREAKPOINT, not a fit minimum: the full panel
// is only ~13 rows, but we require far more available space so the branded
// wordmark appears only on a genuinely large terminal and never dominates a
// small one (the #1067 ask). All in AVAILABLE (usable) terms, not the raw
// terminal, matched with strict `<`.
export const MEDIUM_MIN_WIDTH = 60
export const MEDIUM_MIN_HEIGHT = 8
export const FULL_MIN_WIDTH = 110
// ~45-row home terminal / ~39-row session terminal after the reserves above.
export const FULL_MIN_HEIGHT = 30

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

/** Available panel size on the home route for a given terminal size. */
export function homeAvailable(terminalWidth: number, terminalHeight: number): { width: number; height: number } {
  return {
    width: terminalWidth - PANEL_HORIZONTAL_PADDING,
    height: terminalHeight - HOME_VERTICAL_RESERVE,
  }
}

/**
 * Available panel size on the session route. Subtracts SIDEBAR_WIDTH whenever the
 * sidebar is open (`sidebarVisible`) — the panel shares the same content-column
 * basis as the messages (session's `contentWidth`), so the two stay aligned.
 *
 * On narrow terminals the sidebar renders as a dimmed full-area overlay rather
 * than in-flow; the content column still narrows uniformly (panel + messages)
 * and both restore to full width when it closes, so we deliberately size to the
 * narrowed column rather than the transient obscured width.
 */
export function sessionAvailable(
  terminalWidth: number,
  terminalHeight: number,
  sidebarVisible: boolean,
): { width: number; height: number } {
  return {
    width: terminalWidth - (sidebarVisible ? SIDEBAR_WIDTH : 0) - PANEL_HORIZONTAL_PADDING,
    height: terminalHeight - SESSION_VERTICAL_RESERVE,
  }
}

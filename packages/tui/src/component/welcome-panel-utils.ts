// Pure breakpoint logic for WelcomePanel, split out (like upgrade-indicator-utils)
// so it's unit-testable without the component's render/context dependencies.
//
// The full two-column boot box (block wordmark + description) is ~65 cols wide
// and ~8 rows tall, which eats half a small terminal (issue #1067). We scale it
// down by terminal size. Both axes matter — the wordmark is wide AND tall — so
// each threshold is a min across width and height. Values follow the repo's
// breakpoint idiom (routes/session/permission.tsx uses width < 80; upgrade-
// indicator uses width < 100).

export type WelcomePanelVariant = "full" | "medium" | "compact"

// The full panel is ~13 rows tall, so it's reserved for genuinely large windows
// — on a typical laptop terminal (80–110 wide, 24–35 tall) it would still eat
// ~40% of the screen, which is the problem #1067 is about. So `medium` (no
// wordmark, ~6 rows) is the common case; `full` only when there's real room.
/** Below these, drop to the single-line compact panel. */
export const COMPACT_MAX_WIDTH = 60
export const COMPACT_MAX_HEIGHT = 18
/** At/above these, show the full two-column wordmark panel; below → medium. */
export const MEDIUM_MAX_WIDTH = 110
export const MEDIUM_MAX_HEIGHT = 44

/** Choose the WelcomePanel layout for a given terminal size. */
export function welcomePanelVariant(width: number, height: number): WelcomePanelVariant {
  if (width < COMPACT_MAX_WIDTH || height < COMPACT_MAX_HEIGHT) return "compact"
  if (width < MEDIUM_MAX_WIDTH || height < MEDIUM_MAX_HEIGHT) return "medium"
  return "full"
}

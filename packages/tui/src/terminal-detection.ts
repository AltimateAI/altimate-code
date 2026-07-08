// altimate_change start — fix: pure-TS helper extracted from app.tsx for direct test coverage (#704)
/**
 * Detect terminal background mode from the COLORFGBG env var.
 *
 * Format is `fg;bg` or `fg;default;bg` (rxvt/urxvt). The last semicolon-
 * separated component is the background palette index. Only indices that
 * are canonically light (7 = light-gray, 15 = bright-white) classify as
 * "light" — other bright indices (9 red, 12 blue, 13 magenta) are dark
 * by luminance and must not be treated as light.
 *
 * Returns `null` when the value is missing, malformed (e.g. "default"),
 * or outside the 0-15 ANSI range.
 */
export function detectModeFromCOLORFGBG(value: string | undefined): "dark" | "light" | null {
  if (!value) return null
  const parts = value.split(";")
  const last = parts[parts.length - 1]?.trim()
  if (!last) return null
  const bg = parseInt(last, 10)
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null
  return bg === 7 || bg === 15 ? "light" : "dark"
}
// altimate_change end

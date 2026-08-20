import { execFile } from "node:child_process"

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

/** Signals available when choosing a startup theme mode, cheapest first. */
export interface ModeSignals {
  /** `COLORFGBG` env var, set by rxvt/urxvt/konsole and some others. */
  colorfgbg?: string | undefined
  /** Answer to the OSC 11 background query, when the terminal replies. */
  osc?: "dark" | "light" | null | undefined
  /** OS-level appearance, where the platform exposes one. */
  appearance?: "dark" | "light" | null | undefined
}

/**
 * Choose the startup theme mode from whatever signals are available.
 *
 * Ordered by how well each signal describes *this terminal window*: an
 * explicit background beats an OS-wide preference, because a user may run a
 * dark-profile terminal under a light system theme.
 *
 * The final fallback is the reason #617, #704 and #736 kept recurring. Apple
 * Terminal sets no COLORFGBG and does not reliably answer OSC 11, so every
 * light-background user on it fell through to `"dark"` and got pale text on a
 * pale background. Two earlier fixes adjusted colours; the defect was that the
 * chain ended in a guess with no way to be right.
 */
export function resolveInitialMode(signals: ModeSignals): "dark" | "light" {
  const fromEnv = detectModeFromCOLORFGBG(signals.colorfgbg)
  // Honour both directions. The previous call site kept only "light", so a
  // terminal that reported a dark background still paid for the OSC timeout.
  if (fromEnv) return fromEnv
  if (signals.osc) return signals.osc
  if (signals.appearance) return signals.appearance
  return "dark"
}

/**
 * OS appearance, for platforms that expose one. Returns null when unknown.
 *
 * macOS only. `AppleInterfaceStyle` is set to "Dark" in dark mode and is
 * *absent* in light mode, so a non-zero exit is the light answer, not an error.
 * This is the signal that was missing: every report of this bug came from
 * darwin, on a terminal that answers neither of the cheaper probes.
 */
export function detectSystemAppearance(
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 400,
): Promise<"dark" | "light" | null> {
  if (platform !== "darwin") return Promise.resolve(null)

  return new Promise((resolve) => {
    try {
      execFile(
        "defaults",
        ["read", "-g", "AppleInterfaceStyle"],
        { timeout: timeoutMs, encoding: "utf8" },
        (error, stdout) => {
          if (error) {
            // `defaults` exits non-zero when the key is unset, which is exactly
            // how macOS represents light mode. Distinguish that from a real
            // failure: a timeout or a missing binary tells us nothing.
            const failed = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as any).killed === true
            resolve(failed ? null : "light")
            return
          }
          resolve(stdout.trim().toLowerCase() === "dark" ? "dark" : "light")
        },
      )
    } catch {
      resolve(null)
    }
  })
}

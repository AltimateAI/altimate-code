/**
 * Startup theme-mode detection.
 *
 * This is the third attempt at the same defect: #617 → #704 → #736, each
 * reporting code rendered in near-white on a light terminal. The first two
 * fixes adjusted colour values. They did not hold, because the actual defect is
 * that the mode-resolution chain ended in a hardcoded `"dark"` — so on a
 * terminal that answers neither COLORFGBG nor OSC 11 (Apple Terminal, which is
 * what #736's metadata reports) a light-background user could never be
 * detected correctly, whatever the palette said.
 *
 * These tests pin the chain itself rather than any particular colour.
 */
import { describe, expect, test } from "bun:test"
import { detectModeFromCOLORFGBG, detectSystemAppearance, resolveInitialMode } from "../src/terminal-detection"

describe("detectModeFromCOLORFGBG", () => {
  test("reads the background index from fg;bg", () => {
    expect(detectModeFromCOLORFGBG("0;15")).toBe("light")
    expect(detectModeFromCOLORFGBG("15;0")).toBe("dark")
  })

  test("reads the rxvt fg;default;bg form", () => {
    expect(detectModeFromCOLORFGBG("0;default;15")).toBe("light")
    expect(detectModeFromCOLORFGBG("15;default;0")).toBe("dark")
  })

  test("treats only canonically light indices as light", () => {
    // 7 (light-gray) and 15 (bright-white) are light; other bright indices are
    // dark by luminance and must not be mistaken for light backgrounds.
    expect(detectModeFromCOLORFGBG("0;7")).toBe("light")
    for (const bg of [9, 12, 13]) {
      expect(detectModeFromCOLORFGBG(`0;${bg}`)).toBe("dark")
    }
  })

  test("returns null when absent, malformed, or out of range", () => {
    expect(detectModeFromCOLORFGBG(undefined)).toBeNull()
    expect(detectModeFromCOLORFGBG("")).toBeNull()
    expect(detectModeFromCOLORFGBG("0;default")).toBeNull()
    expect(detectModeFromCOLORFGBG("0;99")).toBeNull()
    expect(detectModeFromCOLORFGBG("0;-1")).toBeNull()
  })
})

describe("resolveInitialMode", () => {
  test("COLORFGBG wins — it describes this window and costs nothing", () => {
    expect(resolveInitialMode({ colorfgbg: "0;15", osc: "dark", appearance: "dark" })).toBe("light")
    expect(resolveInitialMode({ colorfgbg: "15;0", osc: "light", appearance: "light" })).toBe("dark")
  })

  test("honours a dark COLORFGBG instead of discarding it", () => {
    // The previous call site kept only "light", so a terminal reporting a dark
    // background still paid the full OSC timeout before agreeing.
    expect(resolveInitialMode({ colorfgbg: "15;0" })).toBe("dark")
  })

  test("falls back to the OSC 11 answer when COLORFGBG is absent", () => {
    expect(resolveInitialMode({ osc: "light", appearance: "dark" })).toBe("light")
    expect(resolveInitialMode({ osc: "dark", appearance: "light" })).toBe("dark")
  })

  test("prefers the terminal's own background over the OS preference", () => {
    // A dark-profile terminal under a light system theme must stay dark.
    expect(resolveInitialMode({ osc: "dark", appearance: "light" })).toBe("dark")
  })

  test("uses OS appearance only when the terminal says nothing", () => {
    expect(resolveInitialMode({ appearance: "light" })).toBe("light")
    expect(resolveInitialMode({ appearance: "dark" })).toBe("dark")
  })

  test("REGRESSION #736: light Apple Terminal with no COLORFGBG and no OSC reply", () => {
    // Exactly the reported environment: darwin, macOS appearance Light,
    // TERM_PROGRAM=Apple_Terminal. No COLORFGBG is set and OSC 11 goes
    // unanswered, so both cheap signals are absent. Before this change the
    // chain returned "dark" and rendered pale code on a pale background.
    expect(resolveInitialMode({ colorfgbg: undefined, osc: null, appearance: "light" })).toBe("light")
  })

  test("still defaults to dark when nothing is known", () => {
    expect(resolveInitialMode({})).toBe("dark")
    expect(resolveInitialMode({ colorfgbg: undefined, osc: null, appearance: null })).toBe("dark")
  })
})

describe("detectSystemAppearance", () => {
  test("returns null off macOS without spawning anything", async () => {
    expect(await detectSystemAppearance("linux")).toBeNull()
    expect(await detectSystemAppearance("win32")).toBeNull()
  })

  test("on macOS reports a usable answer", async () => {
    // `AppleInterfaceStyle` is absent in light mode, so `defaults` exits
    // non-zero — that is the light answer, not a failure. The distinction is
    // the whole point of the probe, so assert we never turn it into null.
    const result = await detectSystemAppearance("darwin")

    if (process.platform === "darwin") {
      expect(result === "dark" || result === "light").toBe(true)
    } else {
      // Off-platform the binary is missing; that genuinely tells us nothing.
      expect(result).toBeNull()
    }
  })
})

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
  test("the terminal's own OSC answer outranks the inherited env var", () => {
    // COLORFGBG survives ssh, tmux, sudo and profile switches, so it can
    // describe a terminal the user is no longer looking at. A live OSC reply
    // cannot.
    expect(resolveInitialMode({ colorfgbg: "15;0", osc: "light" })).toBe("light")
    expect(resolveInitialMode({ colorfgbg: "0;15", osc: "dark" })).toBe("dark")
  })

  test("uses COLORFGBG in both directions when the terminal stays silent", () => {
    expect(resolveInitialMode({ colorfgbg: "0;15", osc: null })).toBe("light")
    // Previously a dark reading here was discarded and the caller waited anyway.
    expect(resolveInitialMode({ colorfgbg: "15;0", osc: null })).toBe("dark")
  })

  test("OS appearance is consulted only when the terminal says nothing at all", () => {
    expect(resolveInitialMode({ osc: "dark", appearance: "light" })).toBe("dark")
    expect(resolveInitialMode({ colorfgbg: "15;0", appearance: "light" })).toBe("dark")
    expect(resolveInitialMode({ appearance: "light" })).toBe("light")
  })

  test("#736 shape: no COLORFGBG, no OSC reply, light macOS appearance", () => {
    // Named for the shape it covers, not for the whole bug: this asserts the
    // resolver's contract only. Whether app.tsx supplies these signals is a
    // separate question, exercised by the probe tests below.
    expect(resolveInitialMode({ colorfgbg: undefined, osc: null, appearance: "light" })).toBe("light")
  })

  test("still defaults to dark when nothing is known", () => {
    expect(resolveInitialMode({})).toBe("dark")
    expect(resolveInitialMode({ colorfgbg: undefined, osc: null, appearance: null })).toBe("dark")
  })
})

describe("detectSystemAppearance", () => {
  /** Records what was spawned so "does not spawn" can be asserted, not assumed. */
  function spy(behaviour: (cb: (err: unknown, stdout: string) => void) => void) {
    const spawned: string[] = []
    const exec = (file: string, _a: string[], _o: unknown, cb: (e: unknown, s: string) => void) => {
      spawned.push(file)
      behaviour(cb)
      return undefined
    }
    return { spawned, exec: exec as any }
  }

  test("does not spawn anything off macOS", async () => {
    const { spawned, exec } = spy((cb) => cb(null, "Dark"))

    expect(await detectSystemAppearance("linux", 400, {}, exec)).toBeNull()
    expect(await detectSystemAppearance("win32", 400, {}, exec)).toBeNull()
    // The point of the test is the absence of the spawn, so assert it directly.
    expect(spawned).toEqual([])
  })

  test("does not spawn over ssh — that appearance belongs to the remote host", async () => {
    const { spawned, exec } = spy((cb) => cb(null, "Dark"))

    expect(await detectSystemAppearance("darwin", 400, { SSH_CONNECTION: "1.2.3.4 22" }, exec)).toBeNull()
    expect(spawned).toEqual([])
  })

  test("does not spawn in CI", async () => {
    const { spawned, exec } = spy((cb) => cb(null, "Dark"))

    expect(await detectSystemAppearance("darwin", 400, { CI: "true" }, exec)).toBeNull()
    expect(spawned).toEqual([])
  })

  test("reads Dark from stdout", async () => {
    const { exec } = spy((cb) => cb(null, "Dark\n"))
    expect(await detectSystemAppearance("darwin", 400, {}, exec)).toBe("dark")
  })

  test("treats the documented missing-key failure as light", async () => {
    // macOS leaves the key unset in light mode; `defaults` exits 1 saying so.
    const { exec } = spy((cb) =>
      cb(Object.assign(new Error("x"), { stderr: "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist" }), ""),
    )
    expect(await detectSystemAppearance("darwin", 400, {}, exec)).toBe("light")
  })

  test("does NOT call a permission or spawn failure light", async () => {
    // The distinction codex flagged: only the missing-key diagnostic means
    // light. Everything else is unknown, and guessing light on a dark terminal
    // produces the inverse of the bug being fixed.
    for (const code of ["EACCES", "EMFILE", "ENOENT", "ENOMEM"]) {
      const { exec } = spy((cb) => cb(Object.assign(new Error("boom"), { code }), ""))
      expect(await detectSystemAppearance("darwin", 400, {}, exec)).toBeNull()
    }
  })

  test("does NOT call a timeout light", async () => {
    const { exec } = spy((cb) => cb(Object.assign(new Error("timed out"), { killed: true, code: null }), ""))
    expect(await detectSystemAppearance("darwin", 400, {}, exec)).toBeNull()
  })

  test("invokes an absolute path, not whatever PATH resolves", async () => {
    // A stray executable named `defaults` must not get to answer this.
    const { spawned, exec } = spy((cb) => cb(null, "Dark"))
    await detectSystemAppearance("darwin", 400, {}, exec)

    expect(spawned).toEqual(["/usr/bin/defaults"])
  })
})

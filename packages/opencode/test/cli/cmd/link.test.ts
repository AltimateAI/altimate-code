// altimate_change - new file
// Unit coverage for the pure-logic helpers in
// packages/opencode/src/cli/cmd/link.ts that back the `altimate-code link`
// picker's clickable-workspace-name affordance: control-char sanitization,
// terminal capability detection, and the OSC 8 wrapper itself. URL joining
// (`buildManageUrl`) is tested in
// test/altimate/workspace/browser-handoff.test.ts, where the function now
// lives (shared with the TUI plugin). The interactive `@clack/prompts` flow
// (LinkCommand.handler) needs a TTY and is covered by manual verification
// (PR #1274), not here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { hyperlink, stripControlChars, terminalSupportsHyperlinks } from "../../../src/cli/cmd/link"

// Shared by both describe blocks below that exercise terminalSupportsHyperlinks
// (directly, or indirectly via hyperlink()). Object.defineProperty defaults
// omitted attributes (enumerable/writable) to false, so restoring via
// `{ value, configurable: true }` alone would silently collapse those flags
// from whatever the real descriptor had — capture and restore the full
// descriptor instead. (CodeRabbit, PR #1274 round 4.) The env vars cleared
// here are every signal terminalSupportsHyperlinks() reads — an ambient
// WT_SESSION/KONSOLE_VERSION/VTE_VERSION on the host or CI runner would
// otherwise make an "unsupported" test spuriously pass.
const TERMINAL_ENV_KEYS = ["TERM", "TERM_PROGRAM", "WT_SESSION", "KONSOLE_VERSION", "VTE_VERSION"] as const
const ORIGINAL_TTY_DESCRIPTOR = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

function clearTerminalEnv() {
  for (const key of TERMINAL_ENV_KEYS) delete process.env[key]
}

function setTTY(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true })
}

function restoreTTY() {
  // Whether `isTTY` is an own property of process.stdout genuinely depends
  // on whether stdout IS a real TTY — it is NOT always inherited/undefined
  // (a later review round claimed otherwise; verified wrong empirically, see
  // below). Node backs `process.stdout` with different stream classes
  // depending on what fd 1 actually is: a `tty.WriteStream` when it's a
  // terminal (which sets `this.isTTY = true` as a genuine own instance
  // property — confirmed via `Object.getOwnPropertyDescriptor` inside a real
  // pty, e.g. `tmux new-session ... bun -e '...'`, where it returns
  // `{value: true, writable: true, enumerable: true, configurable: true}`,
  // not undefined), versus a plain stream with no `isTTY` at all when piped/
  // redirected (which is how it always runs under `bun test`/CI, hence
  // ORIGINAL_TTY_DESCRIPTOR being undefined in THAT case specifically).
  // So: re-define when there was a real descriptor to restore (interactive
  // `bun test` run), delete when there wasn't (everywhere else) — both
  // branches are reachable and necessary, not dead code. (cubic, PR #1274
  // round 5, on the previous version of this function that always no-op'd
  // for the common non-TTY case.)
  if (ORIGINAL_TTY_DESCRIPTOR) Object.defineProperty(process.stdout, "isTTY", ORIGINAL_TTY_DESCRIPTOR)
  else delete (process.stdout as { isTTY?: boolean }).isTTY
}

describe("restoreTTY (test-helper regression)", () => {
  test("actually removes the isTTY property setTTY() added, instead of leaving it dangling", () => {
    const before = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    setTTY(true)
    // If the assertion below throws, restoreTTY() must still run — otherwise
    // this test's own process-global mutation leaks into every test after
    // it. (cubic, PR #1274 round 6.)
    try {
      expect(Object.getOwnPropertyDescriptor(process.stdout, "isTTY")).toBeDefined()
    } finally {
      restoreTTY()
    }
    expect(Object.getOwnPropertyDescriptor(process.stdout, "isTTY")).toEqual(before)
  })
})

describe("stripControlChars", () => {
  test("removes C0 control bytes including ESC", () => {
    expect(stripControlChars("a\x1bb\x00c")).toBe("abc")
  })

  test("removes DEL and C1 control bytes", () => {
    expect(stripControlChars("a\x7fb\x9fc\x80d")).toBe("abcd")
  })

  test("neutralizes an embedded OSC 8 sequence into inert text", () => {
    const malicious = "name\x1b]8;;http://evil.example\x1b\\CLICK ME\x1b]8;;\x1b\\"
    const sanitized = stripControlChars(malicious)
    expect(sanitized).not.toContain("\x1b")
    // The literal (non-ESC) bytes survive as inert text — only the escape
    // bytes that would make it a live control sequence are stripped.
    expect(sanitized).toBe("name]8;;http://evil.example\\CLICK ME]8;;\\")
  })

  test("leaves ordinary printable text untouched", () => {
    expect(stripControlChars("Rakuten Analytics Pipeline")).toBe("Rakuten Analytics Pipeline")
  })
})

describe("terminalSupportsHyperlinks", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(clearTerminalEnv)

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    restoreTTY()
  })

  test("false when stdout is not a TTY, regardless of TERM_PROGRAM", () => {
    setTTY(false)
    process.env.TERM_PROGRAM = "iTerm.app"
    expect(terminalSupportsHyperlinks()).toBe(false)
  })

  test("false for TERM=dumb or TERM=linux even on a TTY", () => {
    setTTY(true)
    process.env.TERM = "dumb"
    expect(terminalSupportsHyperlinks()).toBe(false)
    process.env.TERM = "linux"
    expect(terminalSupportsHyperlinks()).toBe(false)
  })

  test("true for known-supporting TERM_PROGRAM values", () => {
    setTTY(true)
    for (const program of ["iTerm.app", "WezTerm", "Hyper", "vscode", "ghostty", "Tabby", "rio"]) {
      process.env.TERM_PROGRAM = program
      expect(terminalSupportsHyperlinks()).toBe(true)
    }
  })

  test("false for Apple_Terminal — OSC 8 support can't be inferred from TERM_PROGRAM alone", () => {
    setTTY(true)
    process.env.TERM_PROGRAM = "Apple_Terminal"
    expect(terminalSupportsHyperlinks()).toBe(false)
  })

  test("true when WT_SESSION is set (Windows Terminal)", () => {
    setTTY(true)
    process.env.WT_SESSION = "some-guid"
    expect(terminalSupportsHyperlinks()).toBe(true)
  })

  test("true when KONSOLE_VERSION is set", () => {
    setTTY(true)
    process.env.KONSOLE_VERSION = "220400"
    expect(terminalSupportsHyperlinks()).toBe(true)
  })

  test("VTE_VERSION >= 5000 (>= 0.50.0) is supported, below it is not", () => {
    setTTY(true)
    process.env.VTE_VERSION = "5000"
    expect(terminalSupportsHyperlinks()).toBe(true)
    process.env.VTE_VERSION = "4800"
    expect(terminalSupportsHyperlinks()).toBe(false)
  })

  test("false with no recognized signal at all", () => {
    setTTY(true)
    expect(terminalSupportsHyperlinks()).toBe(false)
  })
})

// buildManageUrl's own tests moved to
// test/altimate/workspace/browser-handoff.test.ts (PR #1274 round 7) — the
// function itself moved there too, since it's now shared by the CLI and the
// TUI plugin rather than a private cli/cmd/link.ts helper.

describe("hyperlink", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(clearTerminalEnv)

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    restoreTTY()
  })

  test("returns text unchanged when url is null", () => {
    expect(hyperlink("anas-skill-test", null)).toBe("anas-skill-test")
  })

  test("sanitizes text even when url is null", () => {
    const malicious = "name\x1b]8;;http://evil.example\x1b\\CLICK ME\x1b]8;;\x1b\\"
    const out = hyperlink(malicious, null)
    expect(out).not.toContain("\x1b")
    expect(out).toBe("name]8;;http://evil.example\\CLICK ME]8;;\\")
  })

  test("returns bare sanitized text with no escape bytes at all when stdout isn't a TTY", () => {
    // Even with a recognized TERM_PROGRAM — stdin can be a TTY (satisfying
    // the handler's interactive-input check) while stdout is redirected to
    // a file or piped, in which case no terminal is reading these bytes and
    // raw OSC 8 would land as literal junk in the captured output.
    setTTY(false)
    process.env.TERM_PROGRAM = "iTerm.app"
    const out = hyperlink("anas-skill-test", "https://tenant.ws.myaltimate.com/w/4242")
    expect(out).toBe("anas-skill-test")
    expect(out).not.toContain("\x1b")
  })

  test("wraps text in OSC 8 with no underline on a TTY whose terminal isn't recognized", () => {
    setTTY(true)
    delete process.env.TERM_PROGRAM
    const out = hyperlink("anas-skill-test", "https://tenant.ws.myaltimate.com/w/4242")
    expect(out).toBe("\x1b]8;;https://tenant.ws.myaltimate.com/w/4242\x1b\\anas-skill-test\x1b]8;;\x1b\\")
    expect(out).not.toContain("\x1b[4m")
  })

  test("wraps text in OSC 8 plus underline when the terminal is recognized as supporting", () => {
    setTTY(true)
    process.env.TERM_PROGRAM = "iTerm.app"
    const out = hyperlink("anas-skill-test", "https://tenant.ws.myaltimate.com/w/4242")
    expect(out).toBe(
      "\x1b]8;;https://tenant.ws.myaltimate.com/w/4242\x1b\\\x1b[4manas-skill-test\x1b[24m\x1b]8;;\x1b\\",
    )
  })

  test("sanitizes an adversarial name so it cannot open a second, spoofed link", () => {
    setTTY(true)
    delete process.env.TERM_PROGRAM
    const malicious = "name\x1b]8;;http://evil.example\x1b\\CLICK ME\x1b]8;;\x1b\\"
    const out = hyperlink(malicious, "https://tenant.ws.myaltimate.com/w/4242")
    // Exactly one real OSC 8 open + one real OSC 8 close — the malicious
    // payload's own OSC 8 bytes were stripped, leaving only inert text.
    expect(out.split("\x1b]8;;").length - 1).toBe(2)
    expect(out).toContain("name]8;;http://evil.example\\CLICK ME]8;;\\")
  })

  test("refuses a non-http(s) url — no OSC 8 bytes, just the sanitized text", () => {
    setTTY(true)
    process.env.TERM_PROGRAM = "iTerm.app"
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://host/path"]) {
      const out = hyperlink("name", url)
      expect(out).toBe("name")
      expect(out).not.toContain("\x1b")
    }
  })

  test("refuses a url that parses as http(s) but still carries a live control byte", () => {
    // isSafeHttpUrl only checks that `new URL(url)` parses and the protocol
    // is http(s) — it does not sanitize, and a string can contain a live
    // ESC byte and still parse successfully. hyperlink() interpolates the
    // ORIGINAL string, not new URL(url)'s re-serialized/encoded form, so
    // that parse check alone doesn't guarantee `url` is safe to embed.
    setTTY(true)
    process.env.TERM_PROGRAM = "iTerm.app"
    const maliciousUrl = "https://evil.example/\x1b]8;;http://spoofed.example\x1b\\CLICK\x1b]8;;\x1b\\"
    const out = hyperlink("name", maliciousUrl)
    expect(out).toBe("name")
    expect(out).not.toContain("\x1b")
  })
})

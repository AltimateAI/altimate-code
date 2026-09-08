// altimate_change - new file
// Unit coverage for the pure-logic helpers in
// packages/opencode/src/cli/cmd/link.ts that back the `altimate-code link`
// picker's clickable-workspace-name affordance: control-char sanitization,
// terminal capability detection, URL joining, and the OSC 8 wrapper itself.
// The interactive `@clack/prompts` flow (LinkCommand.handler) needs a TTY
// and is covered by manual verification (PR #1274), not here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildManageUrl, hyperlink, stripControlChars, terminalSupportsHyperlinks } from "../../../src/cli/cmd/link"

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
  if (ORIGINAL_TTY_DESCRIPTOR) Object.defineProperty(process.stdout, "isTTY", ORIGINAL_TTY_DESCRIPTOR)
}

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

describe("buildManageUrl", () => {
  test("appends /w/<id> to a bare origin", () => {
    expect(buildManageUrl(new URL("https://tenant.ws.myaltimate.com"), 4242)).toBe(
      "https://tenant.ws.myaltimate.com/w/4242",
    )
  })

  test("joins via pathname, not string concatenation, when the base carries a query/fragment", () => {
    // The dev-only ALTIMATE_WORKSPACE_WEB_URL override can be an arbitrary
    // URL (e.g. a local dev server) — naive `toString() + "/w/id"`
    // concatenation would land the path inside the query string instead.
    const url = buildManageUrl(new URL("http://localhost:3003/base?x=1#frag"), 42)
    expect(url).toBe("http://localhost:3003/base/w/42")
  })

  test("normalizes a trailing slash on the base path", () => {
    expect(buildManageUrl(new URL("https://host/base/"), 7)).toBe("https://host/base/w/7")
  })
})

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
})

/**
 * Adversarial coverage for the v0.11.2 patch payload (v0.11.1..HEAD, 2 squash-merged PRs).
 *
 *   1. #1302 — Altimate Base is offered to every user on an implicit free Zen default (closes #1301).
 *      The TUI side is covered by packages/tui tests (local, cycle-stability, ready-pending,
 *      history-startup-race, dialog-altimate-base). The server side lives in
 *      `Provider.readDefaultModelState()` / `Provider.defaultModel()` and the ACP default scan, covered
 *      by `test/provider/provider.test.ts` and `test/acp/default-model.test.ts` for the happy shapes
 *      (public tier vs keyed Zen vs registered Base, recents precedence, decline honoured).
 *   2. #1274 — clickable workspace names: `stripControlChars` / `hyperlink` /
 *      `terminalSupportsHyperlinks` in `src/cli/cmd/link.ts`, covered by `test/cli/cmd/link.test.ts`.
 *
 * This file adds the boundary classes those suites do not reach:
 *
 *   - `readDefaultModelState()` against a HOSTILE model.json: not-an-object JSON, `recent` that is an
 *     object / string / null, recent entries missing fields or with non-string fields, prototype-key
 *     provider/model ids, a `declinedManagedBaseDefault` that is truthy-but-not-`true` ("yes", 1, {}),
 *     and a file that is not JSON at all. The contract is: never throw, never return a malformed
 *     entry, and treat anything but literal `true` as "not declined" (a decline is an explicit act;
 *     garbage must not manufacture one, and must not silently erase one either — see the last test).
 *   - `stripControlChars` idempotence and the full C0/DEL/C1/bidi ranges by exhaustive scan (not the
 *     handful of sampled bytes the main suite uses), plus the guarantee that ordinary Unicode
 *     (CJK, combining marks, emoji, RTL letters themselves) survives.
 *   - `hyperlink` with a `url` that parses but carries control bytes at every position (start, middle,
 *     end, inside the query), with non-http(s) schemes that `new URL()` accepts, with an `http:`
 *     scheme (allowed), and with a `text` made ENTIRELY of control bytes (the sanitized text is empty,
 *     and the function must still return a string, never throw).
 *   - `terminalSupportsHyperlinks` under adversarial env: `VTE_VERSION` that is empty, negative,
 *     `Infinity`, or exactly the 5000 boundary; `TERM_PROGRAM` with a lookalike casing; and the
 *     precedence of `TERM=dumb` over every positive signal.
 *
 * Rules: no `mock.module()`; env is saved/restored per test; the real state dir is never touched
 * (`withTestStateHome`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { Provider } from "@/provider/provider"
import { hyperlink, stripControlChars, terminalSupportsHyperlinks } from "@/cli/cmd/link"
import { withTestStateHome } from "../fixture/fixture"

async function writeModelJson(raw: string) {
  await fs.mkdir(Global.Path.state, { recursive: true })
  await fs.writeFile(path.join(Global.Path.state, "model.json"), raw)
}

describe("v0.11.2 adversarial: Provider.readDefaultModelState against a hostile model.json", () => {
  test("non-object JSON roots yield an empty, not-declined state without throwing", async () => {
    for (const raw of ["null", "42", '"string"', "true", "[]", "[1,2,3]"]) {
      await withTestStateHome(async () => {
        await writeModelJson(raw)
        const state = await Provider.readDefaultModelState()
        expect(state).toEqual({ recent: [], declinedManagedBaseDefault: false })
      })
    }
  })

  test("a file that is not JSON at all is treated as absent", async () => {
    await withTestStateHome(async () => {
      await writeModelJson("{ this is not json")
      expect(await Provider.readDefaultModelState()).toEqual({ recent: [], declinedManagedBaseDefault: false })
    })
  })

  test("`recent` that is not an array is ignored, whatever its type", async () => {
    for (const recent of ['"opencode/big-pickle"', "null", "{}", '{"providerID":"opencode","modelID":"x"}', "7"]) {
      await withTestStateHome(async () => {
        await writeModelJson(`{"recent": ${recent}}`)
        expect((await Provider.readDefaultModelState()).recent).toEqual([])
      })
    }
  })

  test("malformed recent entries are dropped individually; well-formed neighbours survive in order", async () => {
    await withTestStateHome(async () => {
      await writeModelJson(
        JSON.stringify({
          recent: [
            null,
            "opencode/big-pickle",
            { providerID: "opencode" },
            { modelID: "big-pickle" },
            { providerID: 1, modelID: "big-pickle" },
            { providerID: "opencode", modelID: ["big-pickle"] },
            { providerID: "anthropic", modelID: "claude-sonnet-5" },
            { providerID: "", modelID: "" },
            { providerID: "opencode", modelID: "big-pickle" },
          ],
        }),
      )
      const { recent } = await Provider.readDefaultModelState()
      // Every surviving entry has string ids; the two well-formed ones keep their relative order.
      for (const entry of recent) {
        expect(typeof entry.providerID).toBe("string")
        expect(typeof entry.modelID).toBe("string")
      }
      const survivors = recent.map((entry) => `${entry.providerID}/${entry.modelID}`)
      expect(survivors.indexOf("anthropic/claude-sonnet-5")).toBeGreaterThanOrEqual(0)
      expect(survivors.indexOf("opencode/big-pickle")).toBeGreaterThan(survivors.indexOf("anthropic/claude-sonnet-5"))
    })
  })

  test("prototype-key ids in recent are plain strings, not property lookups", async () => {
    await withTestStateHome(async () => {
      await writeModelJson(
        JSON.stringify({ recent: [{ providerID: "__proto__", modelID: "constructor" }, { providerID: "toString", modelID: "valueOf" }] }),
      )
      const { recent } = await Provider.readDefaultModelState()
      // Reading the state must not resolve these against Object.prototype; it either keeps them as
      // inert strings or drops them. Either way nothing throws and nothing is a function.
      for (const entry of recent) {
        expect(typeof entry.providerID).toBe("string")
        expect(typeof entry.modelID).toBe("string")
      }
      expect(Object.getPrototypeOf(recent)).toBe(Array.prototype)
    })
  })

  test("only a literal `true` counts as a decline", async () => {
    for (const value of ['"true"', '"yes"', "1", "{}", "[]", '"declined"', "null", "0", "false"]) {
      await withTestStateHome(async () => {
        await writeModelJson(`{"recent": [], "declinedManagedBaseDefault": ${value}}`)
        expect((await Provider.readDefaultModelState()).declinedManagedBaseDefault).toBe(false)
      })
    }
    await withTestStateHome(async () => {
      await writeModelJson(`{"recent": [], "declinedManagedBaseDefault": true}`)
      expect((await Provider.readDefaultModelState()).declinedManagedBaseDefault).toBe(true)
    })
  })

  test("a decline survives a hostile `recent` in the same file", async () => {
    // A corrupted recents array must not take the decline flag down with it: the two fields are
    // independent, and losing the decline would silently re-enrol a refusing user.
    await withTestStateHome(async () => {
      await writeModelJson(`{"recent": "garbage", "declinedManagedBaseDefault": true}`)
      expect(await Provider.readDefaultModelState()).toEqual({ recent: [], declinedManagedBaseDefault: true })
    })
  })

  test("readDefaultModelState reads the isolated test state dir, never the real one", async () => {
    const real = process.env.OPENCODE_TEST_STATE_HOME
    await withTestStateHome(async () => {
      expect(Global.Path.state).toBe(process.env.OPENCODE_TEST_STATE_HOME!)
      expect(Global.Path.state).not.toBe(real ?? "")
    })
  })
})

describe("v0.11.2 adversarial: stripControlChars", () => {
  test("strips every C0, DEL, C1 and bidi control code point, by exhaustive scan", () => {
    const ranges: [number, number][] = [
      [0x00, 0x1f],
      [0x7f, 0x9f],
      [0x200e, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
    ]
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCodePoint(cp)
        expect(stripControlChars(`a${ch}b`)).toBe("ab")
      }
    }
  })

  test("is idempotent and preserves ordinary Unicode, including RTL letters and emoji", () => {
    const samples = ["données-équipe", "日本語ワークスペース", "עברית", "العربية", "🚀 launch", "é", "a\tb"]
    for (const s of samples) {
      const once = stripControlChars(s)
      expect(stripControlChars(once)).toBe(once)
      if (s !== "a\tb") expect(once).toBe(s)
    }
    expect(stripControlChars("a\tb")).toBe("ab")
  })

  test("input made entirely of control bytes becomes the empty string", () => {
    expect(stripControlChars("\x1b\x9b\x7f\u202e\u2066\u200f")).toBe("")
    expect(stripControlChars("")).toBe("")
  })
})

describe("v0.11.2 adversarial: hyperlink", () => {
  const saved: Record<string, string | undefined> = {}
  const savedIsTTY = process.stdout.isTTY
  beforeEach(() => {
    for (const k of ["TERM", "TERM_PROGRAM", "WT_SESSION", "KONSOLE_VERSION", "VTE_VERSION"]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    process.env.TERM_PROGRAM = "iTerm.app"
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true })
  })

  test("a URL carrying a control byte anywhere falls back to plain sanitized text", () => {
    const bad = [
      "\x1bhttps://example.com/w/1",
      "https://exam\x1bple.com/w/1",
      "https://example.com/w/1\x1b]8;;https://evil.example\x1b\\",
      "https://example.com/w/1?x=\x9b",
      "https://example.com/w/1#\x7f",
    ]
    for (const url of bad) {
      const out = hyperlink("name", url)
      expect(out).toBe("name")
      expect(out).not.toContain("\x1b")
    }
  })

  test("non-http(s) schemes that `new URL()` accepts never become links", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi", "mailto:a@b.c"]) {
      expect(hyperlink("name", url)).toBe("name")
    }
  })

  test("plain http: is allowed and the link wraps exactly the sanitized text", () => {
    const out = hyperlink("na\x1bme", "http://example.com/w/1")
    expect(out).toContain("\x1b]8;;http://example.com/w/1\x1b\\")
    expect(out).toContain("name")
    expect(out).not.toContain("na\x1bme")
  })

  test("an OSC 8 breakout in the text is defused: the only link targets in the output are ours", () => {
    const out = hyperlink("\x1b]8;;https://evil.example\x1b\\", "https://example.com/w/1")
    expect(typeof out).toBe("string")
    // The text's ESC bytes are gone, so "]8;;https://evil.example\\" is inert visible text, never an
    // OSC 8 sequence: every ESC-introduced link opener in the output points at our URL or is the
    // empty closer.
    const openers = out.split("\x1b]8;;").slice(1)
    expect(openers.length).toBe(2)
    expect(openers[0].startsWith("https://example.com/w/1\x1b\\")).toBe(true)
    expect(openers[1].startsWith("\x1b\\")).toBe(true)
    expect(out).not.toContain("\x1b]8;;https://evil")
  })

  test("text made entirely of control bytes yields a string and never throws", () => {
    const out = hyperlink("\x1b\x9b\u202e", "https://example.com/w/1")
    expect(typeof out).toBe("string")
    // Remove our own wrapper sequences; nothing of the hostile text may remain.
    const stripped = out.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[2?4m/g, "")
    expect(stripped).toBe("")
  })

  test("empty text is returned untouched even with a valid URL", () => {
    expect(hyperlink("", "https://example.com/w/1")).toBe("")
  })
})

describe("v0.11.2 adversarial: terminalSupportsHyperlinks env edge cases", () => {
  const saved: Record<string, string | undefined> = {}
  const savedIsTTY = process.stdout.isTTY
  beforeEach(() => {
    for (const k of ["TERM", "TERM_PROGRAM", "WT_SESSION", "KONSOLE_VERSION", "VTE_VERSION"]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true })
  })

  test("VTE_VERSION boundary: 4999 no, 5000 yes; garbage, empty, negative and Infinity are not treated as support", () => {
    process.env.VTE_VERSION = "4999"
    expect(terminalSupportsHyperlinks()).toBe(false)
    process.env.VTE_VERSION = "5000"
    expect(terminalSupportsHyperlinks()).toBe(true)
    for (const v of ["", "abc", "-1", "NaN"]) {
      process.env.VTE_VERSION = v
      expect(terminalSupportsHyperlinks()).toBe(false)
    }
    // `Number("Infinity") >= 5000` is true; document the behaviour rather than let it drift silently.
    process.env.VTE_VERSION = "Infinity"
    expect(terminalSupportsHyperlinks()).toBe(true)
  })

  test("TERM_PROGRAM matching is exact: lookalike casing is not on the allowlist", () => {
    for (const p of ["iterm.app", "ITERM.APP", "WEZTERM", "VSCode", "Apple_Terminal", ""]) {
      process.env.TERM_PROGRAM = p
      expect(terminalSupportsHyperlinks()).toBe(false)
    }
  })

  test("TERM=dumb or TERM=linux wins over every positive signal", () => {
    process.env.TERM_PROGRAM = "iTerm.app"
    process.env.WT_SESSION = "1"
    process.env.KONSOLE_VERSION = "230000"
    process.env.VTE_VERSION = "9999"
    for (const term of ["dumb", "linux"]) {
      process.env.TERM = term
      expect(terminalSupportsHyperlinks()).toBe(false)
    }
  })

  test("a non-TTY stdout is never treated as supporting hyperlinks", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    process.env.TERM_PROGRAM = "iTerm.app"
    expect(terminalSupportsHyperlinks()).toBe(false)
    expect(hyperlink("name", "https://example.com/w/1")).toBe("name")
  })
})

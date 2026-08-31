import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRunModeDefault } from "@/cli/cmd/run/run-mode"
import { Flag } from "@/flag/flag"
// altimate_change — behavioural coverage of the child-env marker strip
import { stripRunModeMarkers } from "@/tool/bash"

// ─── `altimate-code run` implies run mode ───────────────────────
// External drivers (harbor, CI) invoke `run` without exporting
// ALTIMATE_RUN_MODE; the run command applies the default itself, with an
// explicit ALTIMATE_RUN_MODE=0 opt-out. Interactive TUI/serve entrypoints
// never call applyRunModeDefault, so their behavior is untouched.

describe("applyRunModeDefault", () => {
  test("sets ALTIMATE_RUN_MODE=1 when unset", () => {
    const env: Record<string, string | undefined> = {}
    applyRunModeDefault(env)
    expect(env["ALTIMATE_RUN_MODE"]).toBe("1")
  })

  test("blank/whitespace value is treated as unset", () => {
    for (const blank of ["", "   "]) {
      const env: Record<string, string | undefined> = { ALTIMATE_RUN_MODE: blank }
      applyRunModeDefault(env)
      expect(env["ALTIMATE_RUN_MODE"]).toBe("1")
    }
  })

  test("explicit opt-out ALTIMATE_RUN_MODE=0 is preserved", () => {
    const env: Record<string, string | undefined> = { ALTIMATE_RUN_MODE: "0" }
    applyRunModeDefault(env)
    expect(env["ALTIMATE_RUN_MODE"]).toBe("0")
  })

  test("explicit opt-out ALTIMATE_RUN_MODE=false is preserved", () => {
    const env: Record<string, string | undefined> = { ALTIMATE_RUN_MODE: "false" }
    applyRunModeDefault(env)
    expect(env["ALTIMATE_RUN_MODE"]).toBe("false")
  })

  test("explicit ALTIMATE_RUN_MODE=1 stays set", () => {
    const env: Record<string, string | undefined> = { ALTIMATE_RUN_MODE: "1" }
    applyRunModeDefault(env)
    expect(env["ALTIMATE_RUN_MODE"]).toBe("1")
  })

  test("--attach leaves the env untouched", () => {
    const env: Record<string, string | undefined> = {}
    applyRunModeDefault(env, { attach: true })
    expect(env["ALTIMATE_RUN_MODE"]).toBeUndefined()
  })

  // A resumed run's history starts with an earlier invocation's task, so the
  // pin selector must not treat "first user message" as this run's request.
  test("a fresh run sets no resumed marker", () => {
    const env: Record<string, string | undefined> = {}
    applyRunModeDefault(env)
    expect(env["ALTIMATE_RUN_RESUMED"]).toBeUndefined()
  })

  test("a resumed run marks the session", () => {
    const env: Record<string, string | undefined> = {}
    applyRunModeDefault(env, { resumed: true })
    expect(env["ALTIMATE_RUN_MODE"]).toBe("1")
    expect(env["ALTIMATE_RUN_RESUMED"]).toBe("1")
  })

  test("the resumed marker is set even when run mode was exported explicitly", () => {
    const env: Record<string, string | undefined> = { ALTIMATE_RUN_MODE: "1" }
    applyRunModeDefault(env, { resumed: true })
    expect(env["ALTIMATE_RUN_RESUMED"]).toBe("1")
  })

  test("--attach sets no resumed marker either — the agent runs remotely", () => {
    const env: Record<string, string | undefined> = {}
    applyRunModeDefault(env, { attach: true, resumed: true })
    expect(env["ALTIMATE_RUN_RESUMED"]).toBeUndefined()
  })
})

describe("Flag.ALTIMATE_RUN_MODE integration", () => {
  const saved = process.env["ALTIMATE_RUN_MODE"]

  beforeEach(() => {
    delete process.env["ALTIMATE_RUN_MODE"]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env["ALTIMATE_RUN_MODE"]
    else process.env["ALTIMATE_RUN_MODE"] = saved
  })

  test("run implies run mode: default application arms the flag", () => {
    expect(Flag.ALTIMATE_RUN_MODE).toBe(false)
    applyRunModeDefault(process.env)
    expect(Flag.ALTIMATE_RUN_MODE).toBe(true)
  })

  test("opt-out: ALTIMATE_RUN_MODE=0 keeps the flag disarmed", () => {
    process.env["ALTIMATE_RUN_MODE"] = "0"
    applyRunModeDefault(process.env)
    expect(Flag.ALTIMATE_RUN_MODE).toBe(false)
  })

  test("--attach never arms the flag", () => {
    applyRunModeDefault(process.env, { attach: true })
    expect(Flag.ALTIMATE_RUN_MODE).toBe(false)
  })
})

describe("Flag.parseRunModeValue (strict trimmed boolean parser)", () => {
  test("trimmed truthy values arm", () => {
    expect(Flag.parseRunModeValue("1")).toBe(true)
    expect(Flag.parseRunModeValue(" 1 ")).toBe(true)
    expect(Flag.parseRunModeValue("true")).toBe(true)
    expect(Flag.parseRunModeValue(" TRUE ")).toBe(true)
  })

  test("falsy and blank values disarm", () => {
    expect(Flag.parseRunModeValue("0")).toBe(false)
    expect(Flag.parseRunModeValue(" false ")).toBe(false)
    expect(Flag.parseRunModeValue("")).toBe(false)
    expect(Flag.parseRunModeValue("   ")).toBe(false)
    expect(Flag.parseRunModeValue(undefined)).toBe(false)
  })

  test("invalid values warn and disarm rather than silently flipping", () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    try {
      expect(Flag.parseRunModeValue("yes-please")).toBe(false)
      expect(warnings.some((w) => w.includes("ALTIMATE_RUN_MODE"))).toBe(true)
    } finally {
      console.warn = original
    }
  })

  test("whitespace-padded env value arms the flag end to end", () => {
    const saved = process.env["ALTIMATE_RUN_MODE"]
    process.env["ALTIMATE_RUN_MODE"] = " 1 "
    try {
      expect(Flag.ALTIMATE_RUN_MODE).toBe(true)
    } finally {
      if (saved === undefined) delete process.env["ALTIMATE_RUN_MODE"]
      else process.env["ALTIMATE_RUN_MODE"] = saved
    }
  })
})

// altimate_change start — PR #1171 review, raised independently on three
// threads: `run` sets ALTIMATE_RUN_MODE on its own process, and the bash tool
// spread process.env into every child while stripping only the sibling
// ALTIMATE_NON_INTERACTIVE. A nested `serve`/TUI therefore inherited run mode
// and armed run-mode-only mechanisms in an interactive session.
describe("run-mode markers do not leak into bash child processes", () => {
  test("an active marker is stripped from the child environment", () => {
    for (const value of ["1", "true", " 1 ", "TRUE"]) {
      const env = stripRunModeMarkers({ ALTIMATE_RUN_MODE: value, ALTIMATE_RUN_RESUMED: "1", PATH: "/bin" })
      expect(env["ALTIMATE_RUN_MODE"]).toBeUndefined()
      expect(env["ALTIMATE_RUN_RESUMED"]).toBeUndefined()
      // unrelated variables are untouched
      expect(env["PATH"]).toBe("/bin")
    }
  })

  test("an explicit opt-out SURVIVES — deleting it would let a nested run re-arm run mode", () => {
    for (const value of ["0", "false"]) {
      const env = stripRunModeMarkers({ ALTIMATE_RUN_MODE: value })
      expect(env["ALTIMATE_RUN_MODE"]).toBe(value)
      // and a nested run must therefore stay opted out
      applyRunModeDefault(env)
      expect(Flag.parseRunModeValue(env["ALTIMATE_RUN_MODE"]!)).toBe(false)
    }
  })

  test("a nested run re-arms run mode for itself, so stripping an active marker loses nothing", () => {
    const childEnv = stripRunModeMarkers({ ALTIMATE_RUN_MODE: "1" })
    expect(childEnv["ALTIMATE_RUN_MODE"]).toBeUndefined()
    // applyRunModeDefault is what `run` calls at handler startup
    applyRunModeDefault(childEnv)
    expect(childEnv["ALTIMATE_RUN_MODE"]).toBe("1")
  })

  test("an absent marker stays absent", () => {
    const env = stripRunModeMarkers({})
    expect("ALTIMATE_RUN_MODE" in env).toBe(false)
  })
})
// altimate_change end

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRunModeDefault } from "@/cli/cmd/run/run-mode"
import { Flag } from "@/flag/flag"
// altimate_change — behavioural coverage of the child-env marker strip
import { stripHostMarkers, stripRunModeMarkers } from "@/tool/bash"

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
describe("host markers do not leak into child processes", () => {
  // The IDE extension's pin and the serve/headless/non-interactive markers describe the
  // process the extension (or `run`) launched. A child that starts its own nested
  // `altimate-code serve` must not inherit them — from `bash` OR from the persistent
  // `shell` tool, which spreads `process.env` the same way and was missed in v0.12.0.
  test("the serve marker and the pin trio are stripped, unrelated variables survive", () => {
    const env = stripHostMarkers({
      ALTIMATE_CODE_SERVE: "1",
      ALTIMATE_PINNED_WORKSPACE_ID: "237",
      ALTIMATE_PINNED_WORKSPACE_NAME: "x",
      ALTIMATE_PINNED_WORKSPACE_ROOT: "/p",
      ALTIMATE_NON_INTERACTIVE: "1",
      ALTIMATE_CODE_HEADLESS: "1",
      ALTIMATE_WORKSPACE: "1",
      PATH: "/bin",
    })
    for (const k of [
      "ALTIMATE_CODE_SERVE",
      "ALTIMATE_PINNED_WORKSPACE_ID",
      "ALTIMATE_PINNED_WORKSPACE_NAME",
      "ALTIMATE_PINNED_WORKSPACE_ROOT",
      "ALTIMATE_NON_INTERACTIVE",
      "ALTIMATE_CODE_HEADLESS",
    ]) {
      expect(env[k]).toBeUndefined()
    }
    expect(env["ALTIMATE_WORKSPACE"]).toBe("1")
    expect(env["PATH"]).toBe("/bin")
  })

  test("the shell tool's child environment is stripped the same way as bash's", async () => {
    const { shellChildEnv } = await import("../../../src/tool/shell")
    const env = shellChildEnv(
      { FROM_PLUGIN: "1", ALTIMATE_PINNED_WORKSPACE_ID: "from-plugin-too" },
      { ALTIMATE_CODE_SERVE: "1", ALTIMATE_PINNED_WORKSPACE_ROOT: "/p", ALTIMATE_RUN_MODE: "1", PATH: "/bin" },
    )
    expect(env.ALTIMATE_CODE_SERVE).toBeUndefined()
    expect(env.ALTIMATE_PINNED_WORKSPACE_ROOT).toBeUndefined()
    expect(env.ALTIMATE_PINNED_WORKSPACE_ID).toBeUndefined() // a plugin cannot smuggle one in either
    expect(env.ALTIMATE_RUN_MODE).toBeUndefined()
    expect(env.FROM_PLUGIN).toBe("1")
    expect(env.PATH).toBe("/bin")
  })

  test("with no explicit base, the child environment is the real process environment, stripped", async () => {
    // The only production call site passes `extra` alone and relies on the default base.
    const { shellChildEnv } = await import("../../../src/tool/shell")
    const savedRun = process.env.ALTIMATE_RUN_MODE
    const savedSentinel = process.env.ALTIMATE_TEST_SENTINEL_937
    process.env.ALTIMATE_RUN_MODE = "1"
    process.env.ALTIMATE_TEST_SENTINEL_937 = "present"
    try {
      const env = shellChildEnv({ FROM_PLUGIN: "1" })
      expect(env.ALTIMATE_TEST_SENTINEL_937).toBe("present") // process.env came through
      expect(env.ALTIMATE_RUN_MODE).toBeUndefined() // and was stripped
      expect(env.FROM_PLUGIN).toBe("1")
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path) // Windows enumerates `Path`
    } finally {
      if (savedRun === undefined) delete process.env.ALTIMATE_RUN_MODE
      else process.env.ALTIMATE_RUN_MODE = savedRun
      if (savedSentinel === undefined) delete process.env.ALTIMATE_TEST_SENTINEL_937
      else process.env.ALTIMATE_TEST_SENTINEL_937 = savedSentinel
    }
  })

  test("on Windows every spelling of a marker is stripped; on POSIX only the exact name", () => {
    const env = { altimate_code_serve: "1", Altimate_Pinned_Workspace_Id: "7", ALTIMATE_CODE_SERVE: "1", PATH: "x" }
    const win = stripHostMarkers({ ...env }, "win32")
    expect(win.altimate_code_serve).toBeUndefined()
    expect(win.Altimate_Pinned_Workspace_Id).toBeUndefined()
    expect(win.ALTIMATE_CODE_SERVE).toBeUndefined()
    expect(win.PATH).toBe("x")
    const posix = stripHostMarkers({ ...env }, "linux")
    expect(posix.altimate_code_serve).toBe("1") // a different variable there
    expect(posix.ALTIMATE_CODE_SERVE).toBeUndefined()
  })
})

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

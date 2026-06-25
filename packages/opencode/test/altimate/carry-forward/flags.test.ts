/**
 * Carry-forward regression guard: the fork's behavior flags survived the
 * OpenCode v1.17.9 upstream merge and resolve at runtime.
 *
 * Two flag surfaces are live post-merge:
 *  - packages/core/src/flag/flag.ts  (used by the TUI + opencode imports) —
 *    altimate flags are GETTERS, so they re-read process.env on each access.
 *  - packages/opencode/src/flag/flag.ts — most altimate flags are evaluated as
 *    `const` at module load; only ALTIMATE_CLI_YOLO is a live getter (the
 *    --yolo CLI flag sets the env var in middleware after module load).
 *
 * We test runtime resolution via the core getters (deterministic regardless of
 * import order) and via the opencode YOLO getter, plus dual env-var support
 * (ALTIMATE_CLI_* primary, OPENCODE_* fallback). A flag-parity check guards the
 * documented split-brain risk: the two flag surfaces must agree.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Flag as OcFlag } from "../../../src/flag/flag"

const ALT_KEYS = [
  "ALTIMATE_CLI_YOLO",
  "ALTIMATE_CALM_MODE",
  "ALTIMATE_SMOOTH_STREAMING",
  "ALTIMATE_LINE_STREAMING",
  "ALTIMATE_CONTENT_MAX_WIDTH",
  "OPENCODE_YOLO",
  "OPENCODE_CALM_MODE",
  "OPENCODE_SMOOTH_STREAMING",
  "OPENCODE_LINE_STREAMING",
  "OPENCODE_CONTENT_MAX_WIDTH",
]

afterEach(() => {
  for (const k of ALT_KEYS) delete process.env[k]
})

describe("carry-forward: fork flags resolve at runtime", () => {
  test("core flag surface exposes all 5 fork flags", () => {
    expect("ALTIMATE_CLI_YOLO" in CoreFlag).toBe(true)
    expect("ALTIMATE_CALM_MODE" in CoreFlag).toBe(true)
    expect("ALTIMATE_SMOOTH_STREAMING" in CoreFlag).toBe(true)
    expect("ALTIMATE_LINE_STREAMING" in CoreFlag).toBe(true)
    expect("ALTIMATE_CONTENT_MAX_WIDTH" in CoreFlag).toBe(true)
  })

  test("ALTIMATE_CALM_MODE implies smooth + line streaming + width cap 100 (core getters)", () => {
    process.env.ALTIMATE_CALM_MODE = "1"
    expect(CoreFlag.ALTIMATE_CALM_MODE).toBe(true)
    expect(CoreFlag.ALTIMATE_SMOOTH_STREAMING).toBe(true)
    expect(CoreFlag.ALTIMATE_LINE_STREAMING).toBe(true)
    expect(CoreFlag.ALTIMATE_CONTENT_MAX_WIDTH).toBe(100)
  })

  test("calm mode off => streaming flags off and no implicit width cap", () => {
    expect(CoreFlag.ALTIMATE_CALM_MODE).toBe(false)
    expect(CoreFlag.ALTIMATE_SMOOTH_STREAMING).toBe(false)
    expect(CoreFlag.ALTIMATE_LINE_STREAMING).toBe(false)
    expect(CoreFlag.ALTIMATE_CONTENT_MAX_WIDTH).toBeUndefined()
  })

  test("OPENCODE_* fallback works when ALTIMATE_* is unset (dual env support)", () => {
    process.env.OPENCODE_CALM_MODE = "1"
    expect(CoreFlag.ALTIMATE_CALM_MODE).toBe(true)
    expect(CoreFlag.ALTIMATE_SMOOTH_STREAMING).toBe(true)
  })

  test("explicit ALTIMATE_CONTENT_MAX_WIDTH overrides the calm-mode default", () => {
    process.env.ALTIMATE_CALM_MODE = "1"
    process.env.ALTIMATE_CONTENT_MAX_WIDTH = "120"
    expect(CoreFlag.ALTIMATE_CONTENT_MAX_WIDTH).toBe(120)
  })

  test("ALTIMATE_CLI_YOLO is a live getter on the opencode surface (set by --yolo middleware)", () => {
    expect(OcFlag.ALTIMATE_CLI_YOLO).toBe(false)
    process.env.ALTIMATE_CLI_YOLO = "1"
    expect(OcFlag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("ALTIMATE_CLI_YOLO falls back to OPENCODE_YOLO only when unset (opencode surface)", () => {
    process.env.OPENCODE_YOLO = "1"
    expect(OcFlag.ALTIMATE_CLI_YOLO).toBe(true)
    // ALTIMATE_CLI_YOLO is authoritative when explicitly set, even to false
    process.env.ALTIMATE_CLI_YOLO = "0"
    expect(OcFlag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag parity: core + opencode YOLO getters agree on the same env (split-brain guard)", () => {
    process.env.ALTIMATE_CLI_YOLO = "1"
    expect(CoreFlag.ALTIMATE_CLI_YOLO).toBe(OcFlag.ALTIMATE_CLI_YOLO)
    expect(CoreFlag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("OPENCODE_PERMISSION passthrough flag is exposed (tool-stripping support)", () => {
    expect("OPENCODE_PERMISSION" in OcFlag).toBe(true)
  })
})

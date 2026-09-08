/**
 * Adversarial coverage for the v0.11.0-beta.4 release payload (v0.11.0-beta.3..HEAD).
 *
 * The release is a single fix (#1260) plus review-driven hardening: the free-tier
 * ("altimate-free" / Altimate Base) header timeout was raised from the OpenAI 10s
 * default to a 5-minute default, tunable via ALTIMATE_BASE_HEADER_TIMEOUT_MS.
 *
 * The entire behavioral surface of the release is the parse of that env var. The
 * parsing is factored into the pure `Provider.resolveFreeTierHeaderTimeout(raw)`
 * (no env/IO) precisely so it can be pinned here without an Effect runtime:
 *   - undefined / blank            → 5-minute default (unset, not an error)
 *   - a valid whole-ms override    → honored
 *   - a fractional value >= floor  → floored (Math.floor)
 *   - sub-second / seconds-typo footguns (1.5, 10, 999, 0.5) → null (caller warns + defaults)
 *   - non-numeric / negative / non-finite garbage           → null
 *   - the retired "disable" strings (0/off/false/none)       → null; they NO LONGER
 *     disable the timeout (turning the header abort off would let a dead-but-connected
 *     gateway hang the CLI forever, since the SSE chunk watchdog only starts once
 *     headers arrive)
 *
 * `null` is the "present but invalid → fall back to default" signal; `freeTierHeaderTimeout()`
 * (the env-reading wrapper, not unit-tested here) maps it to the default plus a warning.
 */
import { describe, test, expect } from "bun:test"
import { Provider } from "../../src/provider/provider"

const DEFAULT = 300_000
const resolve = Provider.resolveFreeTierHeaderTimeout

describe("v0.11.0-beta.4: Provider.resolveFreeTierHeaderTimeout() parsing", () => {
  test("undefined (unset) → 5-minute default", () => {
    expect(resolve(undefined)).toBe(DEFAULT)
  })

  test("empty / whitespace-only → default (not null, not NaN)", () => {
    expect(resolve("")).toBe(DEFAULT)
    expect(resolve("   ")).toBe(DEFAULT)
  })

  test("valid whole-millisecond override is honored", () => {
    expect(resolve("600000")).toBe(600_000)
  })

  test("surrounding whitespace is trimmed", () => {
    expect(resolve("  120000  ")).toBe(120_000)
  })

  test("exactly at the 1000ms floor is accepted", () => {
    expect(resolve("1000")).toBe(1_000)
  })

  test("fractional value above the floor is floored down", () => {
    expect(resolve("60000.9")).toBe(60_000)
  })

  test("large opt-in ceiling has no upper cap", () => {
    expect(resolve("3600000")).toBe(3_600_000) // 1 hour
  })

  test("scientific notation is accepted when it clears the floor", () => {
    expect(resolve("1e6")).toBe(1_000_000)
  })

  // Footguns worse than the bug being fixed: a sub-second header timeout aborts
  // virtually every request. Each must be rejected (null → caller defaults), never taken.
  for (const footgun of ["1.5", "10", "999", "0.5", "-5", "0"]) {
    test(`sub-floor / non-positive "${footgun}" is rejected (null)`, () => {
      expect(resolve(footgun)).toBeNull()
    })
  }

  // Non-numeric garbage is rejected safely, never crashes and never yields NaN.
  for (const garbage of ["abc", "Infinity", "NaN", "1000ms", "0x10", "true"]) {
    test(`non-numeric "${garbage}" is rejected (null)`, () => {
      expect(resolve(garbage)).toBeNull()
    })
  }

  // The old "disable" vocabulary no longer disables the timeout — it is rejected and the
  // caller falls back to the default. Turning the header abort off entirely would let a
  // gateway that connects but never sends headers hang the CLI forever.
  for (const retired of ["off", "false", "none", "disable", "OFF", "None"]) {
    test(`retired disable token "${retired}" is rejected, never disables`, () => {
      expect(resolve(retired)).toBeNull()
    })
  }

  test("valid results are always a positive integer >= the floor", () => {
    for (const v of ["1000", "1500", "600000", "3600000"]) {
      const result = resolve(v)
      expect(typeof result).toBe("number")
      expect(result).toBeGreaterThanOrEqual(1_000)
      expect(Number.isInteger(result)).toBe(true)
    }
  })
})

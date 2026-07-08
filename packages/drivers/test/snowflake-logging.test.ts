/**
 * Unit tests for the snowflake-sdk console-logging suppression.
 *
 * Regression guard for the bug where snowflake-sdk's Winston Console transport
 * wrote JSON log lines into the interactive TUI render and corrupted it. The
 * leaked line was actually our OWN `configure({logLevel:"OFF"})` confirmation
 * (emitted at INFO by a live console transport), so the fix runs configure() with
 * stdout/stderr silenced. See packages/drivers/src/snowflake.ts.
 */
import { describe, test, expect } from "bun:test"
import { silenceConsole, suppressSnowflakeLogging } from "../src/snowflake"

describe("silenceConsole", () => {
  test("swallows stdout/stderr writes during the call, then restores them", () => {
    const origOut = process.stdout.write
    const origErr = process.stderr.write
    let swappedDuringCall = false

    const result = silenceConsole(() => {
      // Inside the guard, write must be replaced (so SDK lines are discarded).
      swappedDuringCall = process.stdout.write !== origOut && process.stderr.write !== origErr
      // These would corrupt the TUI; they are swallowed by the noop writer.
      process.stdout.write("leak-to-stdout\n")
      process.stderr.write("leak-to-stderr\n")
      return 42
    })

    expect(result).toBe(42) // returns the inner value
    expect(swappedDuringCall).toBe(true) // writes were redirected during the call
    // Crucially: the original write functions are restored (identity check).
    expect(process.stdout.write).toBe(origOut)
    expect(process.stderr.write).toBe(origErr)
  })

  test("restores stdout/stderr even when the callback throws", () => {
    const origOut = process.stdout.write
    const origErr = process.stderr.write

    expect(() =>
      silenceConsole(() => {
        throw new Error("boom")
      }),
    ).toThrow("boom")

    expect(process.stdout.write).toBe(origOut)
    expect(process.stderr.write).toBe(origErr)
  })
})

describe("suppressSnowflakeLogging", () => {
  test("calls configure with OFF + additionalLogToConsole:false, swallowing its self-log", () => {
    const configureArgs: any[] = []
    let leaked = ""
    const origOut = process.stdout.write
    // Capture anything that reaches the real stdout during suppression.
    process.stdout.write = ((chunk: any) => {
      leaked += String(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      const fakeSnowflake = {
        configure(opts: any) {
          configureArgs.push(opts)
          // The real SDK emits "Configuring logger with level: ..." here; emulate
          // that so the test proves it is swallowed, not printed.
          process.stdout.write('{"level":"INFO","message":"Configuring logger with level: -1"}\n')
        },
      }
      suppressSnowflakeLogging(fakeSnowflake)
    } finally {
      process.stdout.write = origOut
    }

    expect(configureArgs).toEqual([{ logLevel: "OFF", additionalLogToConsole: false }])
    // The self-confirmation line must NOT have reached the (captured) stdout.
    expect(leaked).toBe("")
  })

  test("is a no-op when the SDK has no configure (older SDK)", () => {
    expect(() => suppressSnowflakeLogging({})).not.toThrow()
    expect(() => suppressSnowflakeLogging(undefined)).not.toThrow()
  })

  test("swallows a configure() that throws (unsupported options)", () => {
    const origOut = process.stdout.write
    expect(() =>
      suppressSnowflakeLogging({
        configure() {
          throw new Error("unsupported option")
        },
      }),
    ).not.toThrow()
    // stdout restored regardless.
    expect(process.stdout.write).toBe(origOut)
  })
})

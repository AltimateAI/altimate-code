import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Global } from "../../../src/global"
import { TelemetryConfig } from "../../../src/altimate/telemetry/config-state"
import { Telemetry } from "../../../src/altimate/telemetry"

describe("TelemetryConfig.disabledState (no Instance)", () => {
  let dir: string
  // The preload points the global config at a per-run temp directory; other suites may have
  // seeded files there, so every global source the reader takes is set aside and put back.
  const GLOBAL_SOURCES = [
    "config.json",
    "opencode.json",
    "opencode.jsonc",
    "altimate-code.json",
    "altimate-code.jsonc",
    "config",
  ]
  // Both names of the inline config (the documented alias is read first).
  const INLINE_ENV = ["ALTIMATE_CLI_CONFIG_CONTENT", "OPENCODE_CONFIG_CONTENT"]
  const globalFile = () => path.join(Global.Path.config, "altimate-code.json")
  const legacyFile = () => path.join(Global.Path.config, "config")
  const savedFiles = new Map<string, string | undefined>()
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "telemetry-config-state-"))
    for (const key of INLINE_ENV) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    for (const name of GLOBAL_SOURCES) {
      const file = path.join(Global.Path.config, name)
      savedFiles.set(file, existsSync(file) ? readFileSync(file, "utf-8") : undefined)
      rmSync(file, { force: true })
    }
  })
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const [file, text] of savedFiles) {
      if (text === undefined) rmSync(file, { force: true })
      else writeFileSync(file, text)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("reading a config that uses env interpolation emits no telemetry", async () => {
    const track = spyOn(Telemetry, "track")
    const savedFlag = process.env.CONFIG_STATE_PROBE_FLAG
    try {
      process.env.CONFIG_STATE_PROBE_FLAG = "true"
      writeFileSync(globalFile(), '{ "telemetry": { "disabled": {env:CONFIG_STATE_PROBE_FLAG} }, "model": "${HOME}" }')
      expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
      // The parser tracks its row behind `import("@/altimate/telemetry")`. That module is loaded, so
      // awaiting the same import settles after any such callback queued during the read.
      await import("../../../src/altimate/telemetry")
      await Promise.resolve()
      expect(track.mock.calls.filter(([event]) => event.type === "config_env_interpolation")).toHaveLength(0)
    } finally {
      if (savedFlag === undefined) delete process.env.CONFIG_STATE_PROBE_FLAG
      else process.env.CONFIG_STATE_PROBE_FLAG = savedFlag
      track.mockRestore()
    }
  })

  test("a later source the loader would reject cannot override an earlier opt-out", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: true } }))
    // Config's schema rejects a numeric model, so the real loader fails on this source.
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ telemetry: { disabled: false }, model: 123 })
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("a missing {file:} reference makes the read unreadable", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: true } }))
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      telemetry: { disabled: false },
      model: `{file:${path.join(dir, "no-such-file")}}`,
    })
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("an empty source is skipped but a whitespace-only one is unreadable, as in the loader", async () => {
    writeFileSync(globalFile(), "")
    expect(await TelemetryConfig.disabledState(dir)).toBe("enabled")
    process.env.OPENCODE_CONFIG_CONTENT = " "
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
    delete process.env.OPENCODE_CONFIG_CONTENT
    writeFileSync(globalFile(), "  \n")
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("nothing sets it: enabled", async () => {
    expect(await TelemetryConfig.disabledState(dir)).toBe("enabled")
  })

  test("the global config turns it off", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: true } }))
    expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
  })

  test("the legacy TOML global config turns it off, and a broken one is unreadable", async () => {
    writeFileSync(legacyFile(), "[telemetry]\ndisabled = true\n")
    expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
    writeFileSync(legacyFile(), "[telemetry\ndisabled = \n")
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("a value Config's schema would reject is unreadable, not enabled", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: 0 } }))
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("a project's .altimate-code directory turns it off", async () => {
    mkdirSync(path.join(dir, ".altimate-code"))
    writeFileSync(path.join(dir, ".altimate-code", "altimate-code.json"), '{ "telemetry": { "disabled": true } }')
    expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
  })

  test("a later source overrides an earlier one, as in Config", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: true } }))
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ telemetry: { disabled: false } })
    expect(await TelemetryConfig.disabledState(dir)).toBe("enabled")
  })

  test("an unparseable source after the last setting makes it unreadable", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: false } }))
    process.env.OPENCODE_CONFIG_CONTENT = "{ not json"
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })

  test("a source that fails anywhere makes the read unreadable, as it fails Config's whole load", async () => {
    writeFileSync(globalFile(), "{ not json")
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ telemetry: { disabled: true } })
    expect(await TelemetryConfig.disabledState(dir)).toBe("unreadable")
  })
})

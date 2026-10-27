import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Global } from "../../../src/global"
import { TelemetryConfig } from "../../../src/altimate/telemetry/config-state"

describe("TelemetryConfig.disabledState (no Instance)", () => {
  let dir: string
  let savedContent: string | undefined
  // The preload points the global config at a per-run temp directory; other suites may have
  // seeded these files there, so each test puts back what it found.
  const globalFile = () => path.join(Global.Path.config, "altimate-code.json")
  const legacyFile = () => path.join(Global.Path.config, "config")
  const savedFiles = new Map<string, string | undefined>()

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "telemetry-config-state-"))
    savedContent = process.env.OPENCODE_CONFIG_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
    for (const file of [globalFile(), legacyFile()]) {
      savedFiles.set(file, existsSync(file) ? readFileSync(file, "utf-8") : undefined)
      rmSync(file, { force: true })
    }
  })
  afterEach(() => {
    if (savedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = savedContent
    for (const [file, text] of savedFiles) {
      if (text === undefined) rmSync(file, { force: true })
      else writeFileSync(file, text)
    }
    rmSync(dir, { recursive: true, force: true })
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

  test("a later source that sets the value settles an earlier unreadable one", async () => {
    writeFileSync(globalFile(), "{ not json")
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ telemetry: { disabled: true } })
    expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
  })
})

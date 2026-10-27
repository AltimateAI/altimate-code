import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Global } from "../../../src/global"
import { TelemetryConfig } from "../../../src/altimate/telemetry/config-state"

describe("TelemetryConfig.disabledState (no Instance)", () => {
  let dir: string
  let savedContent: string | undefined
  const globalFile = () => path.join(Global.Path.config, "altimate-code.json")

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "telemetry-config-state-"))
    savedContent = process.env.OPENCODE_CONFIG_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
  })
  afterEach(() => {
    if (savedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = savedContent
    rmSync(globalFile(), { force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test("nothing sets it: enabled", async () => {
    expect(await TelemetryConfig.disabledState(dir)).toBe("enabled")
  })

  test("the global config turns it off", async () => {
    writeFileSync(globalFile(), JSON.stringify({ telemetry: { disabled: true } }))
    expect(await TelemetryConfig.disabledState(dir)).toBe("disabled")
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

import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { TelemetryConfig } from "../../src/altimate/telemetry/config-state"

const keys = ["ALTIMATE_TELEMETRY_DISABLED", "OPENCODE_DISABLE_TELEMETRY", "ALTIMATE_CLI_DISABLE_TELEMETRY"]
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of keys) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("an unset environment does not opt out", () => {
  expect(TelemetryConfig.disablingEnvironmentVariable()).toBeUndefined()
})

test.each(["true", "TRUE", "True", "1"])("accepts %j", (value) => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = value
  expect(TelemetryConfig.disablingEnvironmentVariable()).toBe("ALTIMATE_TELEMETRY_DISABLED")
})

test.each(["", "false", "FALSE", "0", "yes", "on", "  true  ", "2"])("rejects %j", (value) => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = value
  expect(TelemetryConfig.disablingEnvironmentVariable()).toBeUndefined()
})

test.each(keys)("%s opts out independently of the other names", (selected) => {
  for (const key of keys) process.env[key] = "false"
  process.env[selected] = "1"
  expect(TelemetryConfig.disablingEnvironmentVariable()).toBe(selected)
  process.env[selected] = "0"
  expect(TelemetryConfig.disablingEnvironmentVariable()).toBeUndefined()
})

test.each(["src/altimate/plugin/altimate.ts", "src/altimate/telemetry/index.ts"])(
  "%s uses the shared opt-out",
  (relativePath) => {
    const source = readFileSync(path.resolve(__dirname, "../..", relativePath), "utf8")
    expect(source).toMatch(/^[^/\n]*TelemetryConfig\.disablingEnvironmentVariable\(\)/m)
  },
)

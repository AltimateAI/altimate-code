import { Database as SQLite } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { Telemetry } from "../../../src/altimate/telemetry"

const CS = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
const ENV = [
  "OPENCODE_TEST_HOME",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "ALTIMATE_TELEMETRY_DISABLED",
  "OPENCODE_DISABLE_TELEMETRY",
  "ALTIMATE_TELEMETRY_FORCE",
  "OPENCODE_CONFIG_CONTENT",
  "ALTIMATE_CLI_CONFIG_CONTENT",
  "ALTIMATE_CLI_DISABLE_TELEMETRY",
  "OPENCODE_AUTH_CONTENT",
] as const

describe("telemetry opt-out", () => {
  let home: string
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
  let configSpy: ReturnType<typeof spyOn<typeof Config, "get">>
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>
  let authFileSpy: ReturnType<typeof spyOn<typeof Auth, "filepath">>
  let authSpy: ReturnType<typeof spyOn<typeof Auth, "get">>
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    await Telemetry.shutdown()
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-opt-out-"))
    mkdirSync(path.join(home, ".altimate"))
    // Simulate a previously signed-in installation with an ID and no opt-out marker.
    writeFileSync(path.join(home, ".altimate", "machine-id"), "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")
    writeFileSync(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.example.invalid",
        altimateInstanceName: "workspace",
        altimateApiKey: "test-key",
      }),
    )
    for (const key of ENV) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.OPENCODE_TEST_HOME = home
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS
    Telemetry.setConfigDirectory(home)
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home)
    authFileSpy = spyOn(Auth, "filepath").mockReturnValue(path.join(home, "auth.json"))
    authSpy = spyOn(Auth, "get").mockResolvedValue(undefined)
    configSpy = spyOn(Config, "get").mockRejectedValue(new Error("InstanceRef not provided"))
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Telemetry must not invoke the transport"))
  })

  afterEach(async () => {
    await Telemetry.shutdown()
    Telemetry.setConfigDirectory(undefined)
    fetchSpy.mockRestore()
    configSpy.mockRestore()
    homedirSpy.mockRestore()
    authFileSpy.mockRestore()
    authSpy.mockRestore()
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(home, { recursive: true, force: true })
  })

  async function expectSilentLifecycle() {
    const startupEvent = {
      type: "startup_ready",
      session_id: "",
      command: "test",
      surface: "test",
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    } as const
    Telemetry.track(startupEvent)
    await Telemetry.init()
    const startupCalls = fetchSpy.mock.calls.length
    const enabled = Telemetry.isEnabled()

    Telemetry.setContext({ sessionId: "session", projectId: "project" })
    Telemetry.track({
      type: "session_start",
      timestamp: Date.now(),
      session_id: "session",
      project_id: "project",
      model_id: "model",
      provider_id: "provider",
      agent: "agent",
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
    })
    await Telemetry.refreshIdentity()
    await Telemetry.flush()
    const sessionCalls = fetchSpy.mock.calls.length - startupCalls

    // Leave a final event for shutdown to drain if tracking was accidentally enabled.
    Telemetry.track({
      type: "error",
      timestamp: Date.now(),
      session_id: "session",
      error_name: "TestError",
      error_message: "test",
      context: "test",
    })
    await Telemetry.shutdown()
    const shutdownCalls = fetchSpy.mock.calls.length - startupCalls - sessionCalls
    expect({ startupCalls, sessionCalls, shutdownCalls }).toEqual({ startupCalls: 0, sessionCalls: 0, shutdownCalls: 0 })
    expect(enabled).toBe(false)
  }

  test.each(["ALTIMATE_TELEMETRY_DISABLED", "OPENCODE_DISABLE_TELEMETRY", "ALTIMATE_CLI_DISABLE_TELEMETRY"])("%s suppresses all requests", async (key) => {
    process.env[key] = "1"
    await expectSilentLifecycle()
    // A later launch must also stay silent with the same existing machine ID.
    await expectSilentLifecycle()
  })

  test("a false canonical alias cannot override the legacy opt-out", async () => {
    process.env.ALTIMATE_CLI_DISABLE_TELEMETRY = "false"
    process.env.OPENCODE_DISABLE_TELEMETRY = "1"
    await expectSilentLifecycle()
  })

  test("opt-out takes precedence over the test force flag and explicit sink", async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "TRUE"
    process.env.ALTIMATE_TELEMETRY_FORCE = "true"
    await expectSilentLifecycle()
  })

  test("loaded telemetry.disabled suppresses all requests", async () => {
    configSpy.mockResolvedValue({ telemetry: { disabled: true } } as Awaited<ReturnType<typeof Config.get>>)
    await expectSilentLifecycle()
  })

  test("project telemetry.disabled suppresses all requests before instance startup", async () => {
    mkdirSync(path.join(home, ".altimate-code"))
    writeFileSync(path.join(home, ".altimate-code", "altimate-code.json"), '{ "telemetry": { "disabled": true } }')
    await expectSilentLifecycle()
  })

  test("a configured well-known source suppresses telemetry until full config is available", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "https://config.example.invalid": { type: "wellknown", key: "TEST_CONFIG_TOKEN", token: "test-token" },
    })
    await expectSilentLifecycle()
  })

  test("an unreadable auth store does not rule out a well-known opt-out", async () => {
    writeFileSync(Auth.filepath(), "{")
    await expectSilentLifecycle()
  })

  test("a partial config cannot enable telemetry after an organization config load failed", async () => {
    configSpy.mockResolvedValue({} as Awaited<ReturnType<typeof Config.get>>)
    const unresolved = spyOn(Config, "telemetryConfigUnresolved").mockReturnValue(true)
    try {
      await expectSilentLifecycle()
    } finally {
      unresolved.mockRestore()
    }
  })

  test("a configured organization source suppresses telemetry until full config is available", async () => {
    const dbPath = path.join(home, "account.db")
    const db = new SQLite(dbPath)
    db.exec(`
      CREATE TABLE account (id TEXT PRIMARY KEY);
      CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);
      INSERT INTO account VALUES ('account');
      INSERT INTO account_state VALUES (1, 'account', 'org');
    `)
    db.close()
    const database = spyOn(Database, "path").mockReturnValue(dbPath)
    try {
      await expectSilentLifecycle()
    } finally {
      database.mockRestore()
    }
  })

  test("a later init can enable telemetry after the startup config resolves", async () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    await Telemetry.init()
    expect(Telemetry.isEnabled()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    configSpy.mockResolvedValue({ telemetry: { disabled: false } } as Awaited<ReturnType<typeof Config.get>>)
    await Telemetry.init()
    expect(Telemetry.isEnabled()).toBe(true)
    Telemetry.track({
      type: "startup_ready",
      timestamp: Date.now(),
      session_id: "",
      command: "test",
      surface: "test",
      duration_ms: 1,
      fresh_install: false,
    })
    await Telemetry.flush()
    expect(fetchSpy.mock.calls.some(([url]) => url === "https://ingest.example.invalid/v2/track")).toBe(true)
    await Telemetry.refreshIdentity()
  })

  test("an unreadable config suppresses all requests", async () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    await expectSilentLifecycle()
  })
})

import { Database as SQLite } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { Telemetry } from "../../../src/altimate/telemetry"
import { TelemetryConfig } from "../../../src/altimate/telemetry/config-state"

const CS = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
const ENV = [
  "NODE_ENV",
  "BUN_TEST",
  "VITEST",
  "JEST_WORKER_ID",
  "OPENCODE_TEST_HOME",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "ALTIMATE_TELEMETRY_DISABLED",
  "OPENCODE_DISABLE_TELEMETRY",
  "ALTIMATE_CLI_DISABLE_TELEMETRY",
  "ALTIMATE_TELEMETRY_FORCE",
  "OPENCODE_CONFIG_CONTENT",
  "ALTIMATE_CLI_CONFIG_CONTENT",
  "OPENCODE_AUTH_CONTENT",
] as const

describe("telemetry opt-out", () => {
  let home: string
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
  let configSpy: ReturnType<typeof spyOn<typeof Config, "get">>
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>
  let authFileSpy: ReturnType<typeof spyOn<typeof Auth, "filepath">>
  let databaseSpy: ReturnType<typeof spyOn<typeof Database, "path">>
  let authSpy: ReturnType<typeof spyOn<typeof Auth, "get">>
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    await Telemetry.shutdown()
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-opt-out-"))
    mkdirSync(path.join(home, ".altimate"))
    // Simulate a previously signed-in installation with a machine ID.
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
    // Exercise the production opt-out behavior with both transports intercepted.
    process.env.NODE_ENV = "production"
    process.env.OPENCODE_TEST_HOME = home
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS
    Telemetry.setConfigDirectory(home)
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home)
    authFileSpy = spyOn(Auth, "filepath").mockReturnValue(path.join(home, "auth.json"))
    databaseSpy = spyOn(Database, "path").mockReturnValue(path.join(home, "missing.db"))
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
    databaseSpy.mockRestore()
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

  test.each(["ALTIMATE_TELEMETRY_DISABLED", "ALTIMATE_CLI_DISABLE_TELEMETRY", "OPENCODE_DISABLE_TELEMETRY"])("%s suppresses all requests", async (key) => {
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
    process.env.NODE_ENV = "test"
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
      PRAGMA journal_mode = WAL;
      CREATE TABLE account (id TEXT PRIMARY KEY);
      CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);
      INSERT INTO account VALUES ('account');
      INSERT INTO account_state VALUES (1, 'account', 'org');
    `)
    db.close()
    databaseSpy.mockReturnValue(dbPath)
    await expectSilentLifecycle()
  })

  test("a legacy account schema still defers to its selected organization's config", async () => {
    const dbPath = path.join(home, "account.db")
    const db = new SQLite(dbPath)
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE account (id TEXT PRIMARY KEY, selected_org_id TEXT);
        CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT);
        INSERT INTO account VALUES ('account', NULL);
        INSERT INTO account_state VALUES (1, 'account');
      `)
      databaseSpy.mockReturnValue(dbPath)
      expect(await TelemetryConfig.disabledState(home)).toBe("enabled")
      db.exec("UPDATE account SET selected_org_id = 'org'")
      expect(await TelemetryConfig.disabledState(home)).toBe("unreadable")
    } finally {
      db.close()
    }
  })

  test("the startup probe can read while an account writer holds a WAL transaction", async () => {
    const dbPath = path.join(home, "account.db")
    const writer = new SQLite(dbPath)
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE account (id TEXT PRIMARY KEY);
        CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);
        INSERT INTO account VALUES ('account');
        BEGIN IMMEDIATE;
        INSERT INTO account_state VALUES (1, 'account', 'org');
      `)
      databaseSpy.mockReturnValue(dbPath)
      expect(await TelemetryConfig.disabledState(home)).toBe("enabled")
      writer.exec("COMMIT")
      expect(await TelemetryConfig.disabledState(home)).toBe("unreadable")
    } finally {
      writer.close()
    }
  })

  function trackStartup() {
    Telemetry.track({
      type: "startup_ready",
      timestamp: Date.now(),
      session_id: "",
      command: "test",
      surface: "test",
      duration_ms: 1,
      fresh_install: false,
    })
  }

  function recordIngestion() {
    const names: string[] = []
    fetchSpy.mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], request?: Parameters<typeof fetch>[1]) => {
      if (url !== "https://ingest.example.invalid/v2/track") throw new Error("Unexpected telemetry request")
      for (const envelope of JSON.parse(String(request?.body))) names.push(envelope.data.baseData.name)
      return new Response(null, { status: 204 })
    }, { preconnect: fetch.preconnect }))
    return names
  }

  test("a later init sends held startup events exactly once", async () => {
    const names = recordIngestion()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    await Telemetry.refreshIdentity()
    await Telemetry.flush()
    expect(fetchSpy).not.toHaveBeenCalled()

    rmSync(path.join(home, ".altimate", "altimate.json"))
    configSpy.mockResolvedValue({ telemetry: { disabled: false } })
    await Telemetry.init()
    await Telemetry.flush()
    await Telemetry.shutdown()
    expect(names).toEqual(["startup_ready"])
  })

  test("only the owning project can release a held startup event", async () => {
    const names = recordIngestion()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    await Telemetry.shutdown({ preserveUnresolved: true })
    expect(fetchSpy).not.toHaveBeenCalled()

    const credentialsPath = path.join(home, ".altimate", "altimate.json")
    const credentials = readFileSync(credentialsPath)
    rmSync(credentialsPath)
    const other = path.join(home, "other")
    mkdirSync(other)
    Telemetry.setConfigDirectory(other)
    configSpy.mockResolvedValue({})
    Telemetry.track({
      type: "error",
      timestamp: Date.now(),
      error_name: "OtherProject",
      error_message: "test",
      context: "test",
      session_id: "",
    })
    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual(["error"])
    await Telemetry.refreshIdentity()
    const callsBeforeSwitch = fetchSpy.mock.calls.length

    Telemetry.setConfigDirectory(home)
    writeFileSync(credentialsPath, credentials)
    expect(Telemetry.isEnabled()).toBe(false)
    await Telemetry.refreshIdentity()
    expect(fetchSpy).toHaveBeenCalledTimes(callsBeforeSwitch)
    rmSync(credentialsPath)
    await Telemetry.shutdown({ preserveUnresolved: true })

    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual(["error", "startup_ready"])
  })

  test("resolution to disabled discards held startup events", async () => {
    const names = recordIngestion()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    configSpy.mockResolvedValue({ telemetry: { disabled: true } })
    await Telemetry.init()
    await Telemetry.flush()
    await Telemetry.refreshIdentity()
    expect(fetchSpy).not.toHaveBeenCalled()

    await Telemetry.shutdown()
    rmSync(path.join(home, ".altimate", "altimate.json"))
    configSpy.mockResolvedValue({})
    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual([])
  })

  test("exit while unresolved never sends and clears held events", async () => {
    const names = recordIngestion()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    trackStartup()
    await Telemetry.shutdown()
    expect(fetchSpy).not.toHaveBeenCalled()

    rmSync(path.join(home, ".altimate", "altimate.json"))
    configSpy.mockResolvedValue({})
    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual([])
  })

  test("malformed auth prevents an otherwise loaded config from enabling telemetry", async () => {
    writeFileSync(Auth.filepath(), "null")
    configSpy.mockResolvedValue({})
    await expectSilentLifecycle()
  })

  test("an unreadable config suppresses all requests", async () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    await expectSilentLifecycle()
  })
})

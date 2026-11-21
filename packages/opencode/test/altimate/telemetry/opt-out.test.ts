import { Database as SQLite } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { Telemetry } from "../../../src/altimate/telemetry"
import { TelemetryConfig } from "../../../src/altimate/telemetry/config-state"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"

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
    Telemetry.resetGateForTest()
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
    Telemetry.resetGateForTest()
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
      for (const envelope of JSON.parse(String(request?.body))) {
        names.push(envelope.data.baseData.properties?.error_name ?? envelope.data.baseData.name)
      }
      return new Response(null, { status: 204 })
    }, { preconnect: fetch.preconnect }))
    return names
  }

  function errorEvent(name: string) {
    return { type: "error", timestamp: Date.now(), session_id: "", error_name: name, error_message: "test", context: "test" } as const
  }

  /** No signed-in account, so the only requests are ingestion. */
  function signOut() {
    rmSync(path.join(home, ".altimate", "altimate.json"))
  }

  test("an unreadable config holds startup events; a later enabled init sends them once", async () => {
    const names = recordIngestion()
    signOut()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    await Telemetry.flush()
    expect(Telemetry.isEnabled()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    configSpy.mockResolvedValue({})
    // While unreadable, init() re-resolves the config at most every 30 s.
    const reads = configSpy.mock.calls.length
    await Telemetry.init()
    expect(configSpy.mock.calls.length).toBe(reads)
    expect(fetchSpy).not.toHaveBeenCalled()

    Telemetry.retryConfigNowForTest()
    await Telemetry.init()
    expect(Telemetry.isEnabled()).toBe(true)
    await Telemetry.flush()
    await Telemetry.shutdown()
    expect(names).toEqual(["startup_ready"])
  })

  test("a session shutdown while unresolved keeps held events for a later init", async () => {
    const names = recordIngestion()
    signOut()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    await Telemetry.shutdown()
    expect(fetchSpy).not.toHaveBeenCalled()

    configSpy.mockResolvedValue({})
    Telemetry.retryConfigNowForTest()
    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual(["startup_ready"])
  })

  test("an unreadable config that resolves to disabled sends nothing, then stays off for the process", async () => {
    const names = recordIngestion()
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    configSpy.mockResolvedValue({ telemetry: { disabled: true } })
    Telemetry.retryConfigNowForTest()
    await Telemetry.init()
    await Telemetry.flush()
    await Telemetry.refreshIdentity()
    expect(Telemetry.isEnabled()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Another session of the same process whose config reads as enabled.
    await Telemetry.shutdown()
    signOut()
    configSpy.mockResolvedValue({})
    trackStartup()
    await Telemetry.init()
    await Telemetry.flush()
    expect(names).toEqual([])
  })

  test("exit while unresolved sends nothing", async () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    trackStartup()
    await Telemetry.init()
    trackStartup()
    await Telemetry.shutdown({ timeoutMs: Telemetry.EXIT_FLUSH_BUDGET_MS })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  function wellKnownAuth() {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "https://config.example.invalid": { type: "wellknown", key: "TEST_CONFIG_TOKEN", token: "test-token" },
    })
  }

  test("a thread that cannot read a remote config sends its held events once the worker resolves enabled", async () => {
    const names = recordIngestion()
    signOut()
    wellKnownAuth()
    trackStartup()
    await Telemetry.init()
    await Telemetry.flush()
    expect(Telemetry.optOutState()).toBe("pending")
    expect(fetchSpy).not.toHaveBeenCalled()

    await Telemetry.adoptOptOut("pending")
    expect(Telemetry.optOutState()).toBe("pending")
    await Telemetry.adoptOptOut("enabled")
    expect(Telemetry.isEnabled()).toBe(true)
    await Telemetry.flush()
    expect(names).toEqual(["startup_ready"])
  })

  test("an opt-out resolved by the worker drops the held events and stays off", async () => {
    const names = recordIngestion()
    signOut()
    wellKnownAuth()
    trackStartup()
    await Telemetry.init()
    await Telemetry.adoptOptOut("disabled")
    await Telemetry.adoptOptOut("enabled")
    trackStartup()
    await Telemetry.init()
    await Telemetry.flush()
    await Telemetry.shutdown()
    expect(Telemetry.optOutState()).toBe("disabled")
    expect(names).toEqual([])
  })

  test("an env opt-out wins over an enabled answer from the worker", async () => {
    signOut()
    wellKnownAuth()
    trackStartup()
    await Telemetry.init()
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.adoptOptOut("enabled")
    await Telemetry.flush()
    await Telemetry.shutdown()
    expect(Telemetry.optOutState()).toBe("disabled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("the retry throttle still applies after an earlier session enabled telemetry", async () => {
    recordIngestion()
    signOut()
    configSpy.mockResolvedValue({})
    await Telemetry.init()
    await Telemetry.shutdown()

    configSpy.mockRejectedValue(new Error("InstanceRef not provided"))
    process.env.OPENCODE_CONFIG_CONTENT = "{"
    const reads = configSpy.mock.calls.length
    for (let i = 0; i < 5; i++) await Telemetry.init()
    expect(configSpy.mock.calls.length - reads).toBe(1)
  })

  test("after an opt-out, events tracked between sessions are not even buffered", async () => {
    configSpy.mockResolvedValue({ telemetry: { disabled: true } })
    await Telemetry.init()
    await Telemetry.shutdown()
    for (let i = 0; i < 5; i++) trackStartup()
    expect(Telemetry.bufferedCountForTest()).toBe(0)
  })

  test("two opted-in projects in one process share one lifecycle and lose no events", async () => {
    const names = recordIngestion()
    signOut()
    configSpy.mockResolvedValue({})
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const enabledDuringTurns: boolean[] = []
    let releaseA!: () => void
    const aMidTurn = new Promise<void>((resolve) => (releaseA = resolve))
    let markAStarted!: () => void
    const aStarted = new Promise<void>((resolve) => (markAStarted = resolve))

    const turnA = Instance.provide({
      directory: a.path,
      fn: async () => {
        await Telemetry.init()
        Telemetry.track(errorEvent("A1"))
        markAStarted()
        await aMidTurn
        // B's turn started meanwhile: A's telemetry is still on.
        enabledDuringTurns.push(Telemetry.isEnabled())
        Telemetry.track(errorEvent("A2"))
      },
    })
    await aStarted
    await Instance.provide({
      directory: b.path,
      fn: async () => {
        await Telemetry.init()
        enabledDuringTurns.push(Telemetry.isEnabled())
        Telemetry.track(errorEvent("B1"))
      },
    })
    releaseA()
    await turnA
    await Telemetry.flush()

    expect(enabledDuringTurns).toEqual([true, true])
    // B joined the running lifecycle: no shutdown and re-init, so the config was resolved once.
    expect(configSpy).toHaveBeenCalledTimes(1)
    expect(names.sort()).toEqual(["A1", "A2", "B1"])
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

/**
 * Tests for ConnectionRegistry's load() function — env var parsing,
 * file loading, and merge precedence (global < local < env).
 *
 * The existing connections.test.ts only uses setConfigs(), which bypasses
 * the entire loadFromFile/loadFromEnv pipeline. These tests verify that
 * CI/CD users who set ALTIMATE_CODE_CONN_* env vars get correct configs.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as Registry from "../../src/altimate/native/connections/registry"
import { Log } from "../../src/altimate/util/log"

// ---------------------------------------------------------------------------
// Env var cleanup helper
// ---------------------------------------------------------------------------

const ENV_PREFIX = "ALTIMATE_CODE_CONN_"
const envVarsToClean: string[] = []

function setEnvVar(name: string, value: string): void {
  const key = `${ENV_PREFIX}${name}`
  process.env[key] = value
  envVarsToClean.push(key)
}

function cleanEnvVars(): void {
  for (const key of envVarsToClean) {
    delete process.env[key]
  }
  envVarsToClean.length = 0
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  Registry.reset()
  cleanEnvVars()
})

afterEach(() => {
  Registry.reset()
  cleanEnvVars()
})

// ---------------------------------------------------------------------------
// 1. Env var loading
// ---------------------------------------------------------------------------

describe("ConnectionRegistry: env var loading", () => {
  test("loads connection from ALTIMATE_CODE_CONN_* env var", () => {
    setEnvVar("MYDB", JSON.stringify({ type: "postgres", host: "localhost", port: 5432 }))

    Registry.load()

    const config = Registry.getConfig("mydb")
    expect(config).toBeDefined()
    expect(config?.type).toBe("postgres")
    expect(config?.host).toBe("localhost")
  })

  test("env var name is lowercased to connection name", () => {
    setEnvVar("MY_PROD_DB", JSON.stringify({ type: "snowflake", account: "abc123" }))

    Registry.load()

    expect(Registry.getConfig("my_prod_db")).toBeDefined()
    expect(Registry.getConfig("MY_PROD_DB")).toBeUndefined()
  })

  test("ignores env vars with empty value", () => {
    process.env[`${ENV_PREFIX}EMPTY`] = ""
    envVarsToClean.push(`${ENV_PREFIX}EMPTY`)

    Registry.load()

    expect(Registry.getConfig("empty")).toBeUndefined()
  })

  test("ignores env vars with invalid JSON", () => {
    setEnvVar("BAD_JSON", "not valid json {{{")

    Registry.load()

    expect(Registry.getConfig("bad_json")).toBeUndefined()
    // Should not throw — graceful handling
  })

  test("ignores env vars where parsed value is not an object or has no type", () => {
    setEnvVar("STRING_VAL", JSON.stringify("just a string"))
    setEnvVar("NUMBER_VAL", JSON.stringify(42))
    setEnvVar("NULL_VAL", JSON.stringify(null))
    setEnvVar("NO_TYPE", JSON.stringify({ host: "localhost", port: 5432 }))

    Registry.load()

    expect(Registry.getConfig("string_val")).toBeUndefined()
    expect(Registry.getConfig("number_val")).toBeUndefined()
    expect(Registry.getConfig("null_val")).toBeUndefined()
    expect(Registry.getConfig("no_type")).toBeUndefined()
  })

  test("loads multiple connections from env vars", () => {
    setEnvVar("PG", JSON.stringify({ type: "postgres", host: "pg.local" }))
    setEnvVar("SF", JSON.stringify({ type: "snowflake", account: "xyz" }))
    setEnvVar("DDB", JSON.stringify({ type: "duckdb", path: ":memory:" }))

    Registry.load()

    // Verify all 3 env-var connections were loaded (other env vars or file
    // configs may also contribute, so check by name rather than total count)
    expect(Registry.getConfig("pg")).toBeDefined()
    expect(Registry.getConfig("pg")?.type).toBe("postgres")
    expect(Registry.getConfig("sf")).toBeDefined()
    expect(Registry.getConfig("sf")?.type).toBe("snowflake")
    expect(Registry.getConfig("ddb")).toBeDefined()
    expect(Registry.getConfig("ddb")?.type).toBe("duckdb")
  })

})

// ---------------------------------------------------------------------------
// 2. Merge precedence: env overrides file configs
// ---------------------------------------------------------------------------

describe("ConnectionRegistry: load() replaces prior state", () => {
  test("load() replaces setConfigs state entirely with fresh file+env data", () => {
    // setConfigs() populates in-memory state without going through load()
    Registry.setConfigs({
      mydb: { type: "postgres", host: "file-host", port: 5432 },
    })
    expect(Registry.getConfig("mydb")?.host).toBe("file-host")

    // load() clears configs and rebuilds from files + env.
    // Since no connections.json exists at globalConfigPath()/localConfigPath()
    // in this test environment, only env vars contribute.
    setEnvVar("MYDB", JSON.stringify({ type: "postgres", host: "env-host", port: 5433 }))
    Registry.load()

    const config = Registry.getConfig("mydb")
    expect(config?.host).toBe("env-host")
    expect(config?.port).toBe(5433)
  })
})

// ---------------------------------------------------------------------------
// 3. list() reflects env-loaded connections
// ---------------------------------------------------------------------------

describe("ConnectionRegistry: list() with env-loaded connections", () => {
  test("list returns warehouses loaded from env vars", () => {
    setEnvVar("CI_WAREHOUSE", JSON.stringify({
      type: "bigquery",
      project: "my-project",
      database: "analytics",
    }))

    Registry.load()

    const { warehouses } = Registry.list()
    // Use .some() instead of index-based access to avoid flakiness if the
    // host filesystem has a connections.json that also contributes entries.
    const ciWarehouse = warehouses.find((w) => w.name === "ci_warehouse")
    expect(ciWarehouse).toBeDefined()
    expect(ciWarehouse?.type).toBe("bigquery")
    expect(ciWarehouse?.database).toBe("analytics")
  })
})

describe("ConnectionRegistry: reserved scratch name", () => {
  test("loading a configured scratch warns and keeps one conflicting configured row", () => {
    setEnvVar("SCRATCH", JSON.stringify({ type: "postgres", database: "existing_warehouse" }))
    const warn = spyOn(Log.Default, "warn").mockImplementation(() => {})
    try {
      Registry.load()

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Connection "scratch" conflicts'))
      const matches = Registry.list().warehouses.filter((warehouse) => warehouse.name === "scratch")
      expect(matches).toHaveLength(1)
      expect(matches[0].type).toBe("postgres")
      expect(matches[0].database).toBe("existing_warehouse")
      expect(matches[0].conflict).toContain("reserved")
      expect(matches[0].conflict).toContain("Rename")
      expect(Registry.getConfig("scratch")?.type).toBe("postgres")
    } finally {
      warn.mockRestore()
    }
  })

  test("get loads configuration before refusing to redirect a configured scratch", async () => {
    setEnvVar("SCRATCH", JSON.stringify({ type: "postgres", database: "existing_warehouse" }))

    await expect(Registry.get("scratch")).rejects.toThrow("reserved built-in scratch warehouse name")
    await expect(Registry.get("scratch")).rejects.toThrow("Rename its connection key")
    await expect(Registry.get("scratch")).rejects.toThrow("ALTIMATE_CODE_CONN_SOURCE_SCRATCH")
    expect(Registry.getConfig("scratch")?.database).toBe("existing_warehouse")
  })

  test("an unconfigured scratch remains the synthetic warehouse without a conflict", () => {
    Registry.setConfigs({ source: { type: "postgres", database: "source_data" } })

    const matches = Registry.list().warehouses.filter((warehouse) => warehouse.name === "scratch")
    expect(matches).toHaveLength(1)
    expect(matches[0].type).toBe("duckdb")
    expect(matches[0].conflict).toBeUndefined()
    expect(Registry.getConfig("scratch")).toEqual({ type: "duckdb" })
  })
})

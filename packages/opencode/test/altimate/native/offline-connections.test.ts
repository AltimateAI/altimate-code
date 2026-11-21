// altimate_change - new file
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertLocalConnection } from "../../../src/altimate/native/connections/offline"
import { assertLocalDbt } from "../../../src/altimate/native/dbt/offline"

const envKeys = ["DBT_TARGET", "DBT_PROFILE", "DBT_PROFILES_DIR", "DBT_PROJECT_DIR", "ALTIMATE_OFFLINE"]
let savedEnv: Record<string, string | undefined>
beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
})
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

test("offline permits embedded databases and literal loopback", () => {
  for (const store of [":memory:", "/tmp/warehouse.db", "data.duckdb", "file:///tmp/local.db"])
    for (const type of ["duckdb", "sqlite"])
      expect(() => assertLocalConnection({ type, path: store })).not.toThrow()
  for (const host of ["localhost", "127.0.0.1", "127.0.1.2", "::1"])
    expect(() => assertLocalConnection({ type: "postgres", host })).not.toThrow()
  expect(() => assertLocalConnection({ type: "postgres", connectionString: "postgres://localhost/test" })).not.toThrow()
})
test("offline rejects remote targets, SSH, cloud auth, and URI host overrides", () => {
  for (const config of [
    { type: "duckdb", path: "md:cloud" },
    { type: "duckdb", path: "https://example.com/db" },
    { type: "sqlite", path: "file://example.com/share/db" },
    { type: "sqlite", path: "file:////server/share/db.sqlite" },
    { type: "sqlite", path: "file://localhost//server/share/db.sqlite" },
    { type: "sqlite", path: "file:///%2Fserver/share/db.sqlite" },
    { type: "sqlite", path: "\\\\example.com\\share\\db" },
    { type: "postgres", host: "localhost.evil.test" },
    { type: "postgres", host: "127.0.0.1", ssh_host: "remote" },
    { type: "snowflake", host: "localhost" },
    { type: "sqlserver", host: "localhost", authentication: "azure-active-directory-default" },
    { type: "sqlserver", host: "localhost", authentication: "default" },
    { type: "postgres", connection_string: "postgres://localhost/db?host=remote" },
    { type: "mongodb", connection_string: "mongodb+srv://localhost/db" },
    { type: "mongodb", connection_string: "mongodb://localhost/db?directConnection=true", direct_connection: false },
    { type: "mongodb", connection_string: "mongodb://localhost/db?directConnection=true&authMechanism=MONGODB-AWS" },
    { type: "trino", url: "https://example.com" },
  ]) expect(() => assertLocalConnection(config)).toThrow("Offline mode")
})
test("dbt checks selected target and CLI overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-"))
  try {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: test\nprofile: test\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  target: local\n  outputs:\n    local:\n      type: duckdb\n      path: ':memory:'\n    remote:\n      type: postgres\n      host: example.com\n")
    const args = ["--profiles-dir", root]
    await expect(assertLocalDbt(root, args)).resolves.toBeUndefined()
    await expect(assertLocalDbt(root, [...args, "--target=remote"])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, [...args, "--target", "local", "-t", "remote"])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, [...args, "-t", "remote", "--target", "local"])).resolves.toBeUndefined()
    await expect(assertLocalDbt(root, [...args, "--target", "local", "-tremote"])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, args, "cloud")).rejects.toThrow("Offline mode")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("dbt project directory follows environment and CLI precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-project-"))
  try {
    const other = path.join(root, "other")
    await fs.mkdir(other)
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: local\n")
    await fs.writeFile(path.join(other, "dbt_project.yml"), "profile: remote\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "local:\n  outputs:\n    default:\n      type: duckdb\n      path: ':memory:'\nremote:\n  outputs:\n    default:\n      type: postgres\n      host: example.com\n")
    process.env.DBT_PROJECT_DIR = other
    await expect(assertLocalDbt(root, ["--profiles-dir", root])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, ["--profiles-dir", root, "--project-dir", root])).resolves.toBeUndefined()
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("dbt policy failure surfaces on repeated SQL calls without a registry fallback", async () => {
  const Registry = await import("../../../src/altimate/native/connections/registry")
  const adapter = await import("../../../src/altimate/native/connections/register")
  const Dispatcher = await import("../../../src/altimate/native/dispatcher")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-fallback-"))
  const get = spyOn(Registry, "get")
  try {
    process.env.ALTIMATE_OFFLINE = "1"
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: postgres\n      host: example.com\n")
    adapter.resetDbtAdapter()
    adapter.dbtAdapterInternals.readConfig = async () => ({ projectRoot: root })
    adapter.registerAll()
    Registry.setConfigs({ fallback: { type: "sqlite", path: ":memory:" } })
    for (let i = 0; i < 2; i++) {
      const result = await Dispatcher.call("sql.execute", { sql: "SELECT 1" })
      expect((result as { error?: string }).error).toContain("Offline mode")
    }
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
    delete adapter.dbtAdapterInternals.readConfig
    adapter.resetDbtAdapter()
    Registry.reset()
    Dispatcher.reset()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("cached local connections never reread credentials offline", async () => {
  const Registry = await import("../../../src/altimate/native/connections/registry")
  const Credentials = await import("../../../src/altimate/native/connections/credential-store")
  const read = mock(async () => null)
  try {
    Credentials.setSecretBackendForTests({ name: "test", get: read, set: async () => {}, delete: async () => true })
    Registry.setConfigs({ local: { type: "sqlite", path: ":memory:" } })
    const connector = await Registry.get("local")
    expect(read).toHaveBeenCalled()
    read.mockClear()
    process.env.ALTIMATE_OFFLINE = "1"
    expect(await Registry.get("local")).toBe(connector)
    expect(await Registry.get("local")).toBe(connector)
    expect((await connector.execute("SELECT 1")).rows).toEqual([[1]])
    expect(read).not.toHaveBeenCalled()
  } finally {
    await Registry.closeAll()
    Registry.reset()
    Credentials.setSecretBackendForTests(undefined)
  }
})

test("cached remote target survives lost keychain credentials and closes on rejection", async () => {
  const Registry = await import("../../../src/altimate/native/connections/registry")
  const Credentials = await import("../../../src/altimate/native/connections/credential-store")
  const driver = await import("@altimateai/drivers/postgres")
  const close = mock(async () => {})
  const connector = { connect: async () => {}, close }
  const connect = spyOn(driver, "connect").mockResolvedValue(connector as any)
  const read = mock(async (account: string) => account.endsWith("/connection_string") ? "postgres://remote.example/db" : null)
  try {
    Credentials.setSecretBackendForTests({ name: "test", get: read, set: async () => {}, delete: async () => true })
    Registry.setConfigs({ remote: { type: "postgres", host: "localhost" } })
    expect(await Registry.get("remote")).toBe(connector)
    expect(connect.mock.calls[0][0].connection_string).toBe("postgres://remote.example/db")
    read.mockClear()
    read.mockImplementation(async () => { throw new Error("keychain locked") })
    process.env.ALTIMATE_OFFLINE = "1"
    await expect(Registry.get("remote")).rejects.toThrow("Offline mode")
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    await Registry.closeAll()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    connect.mockRestore()
    await Registry.closeAll()
    Registry.reset()
    Credentials.setSecretBackendForTests(undefined)
  }
})

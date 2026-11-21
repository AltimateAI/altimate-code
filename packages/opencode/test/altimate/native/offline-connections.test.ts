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
    { type: "trino", host: "127.0.0.1", protocol: "http://evil.example" },
    { type: "clickhouse", host: "127.0.0.1", protocol: "http://example.com:8123/" },
    { type: "oracle", connection_string: "db.example.com:1521/ORCL" },
    { type: "oracle", connection_string: "(DESCRIPTION=(ADDRESS=(HOST=db.example.com)))" },
    { type: "oracle", connection_string: "PRODTNS" },
    { type: "mysql", server: "db.example.com" },
    { type: "postgres", connection_string: "postgresql:///analytics?host=/var/run/postgresql&hostaddr=10.0.0.5" },
    { type: "sqlserver", host: "db.example.com\\SQLEXPRESS" },
    { type: "mysql", socketPath: "\\\\.\\pipe\\remote" },
  ]) expect(() => assertLocalConnection(config)).toThrow("Offline mode")
})

test("offline accepts plain protocols and local Oracle Easy Connect strings", () => {
  for (const config of [
    { type: "trino", host: "localhost", protocol: "https" },
    { type: "clickhouse", host: "127.0.0.1", protocol: "HTTP" },
    { type: "oracle", connection_string: "127.0.0.1:1521/ORCL" },
    { type: "oracle", connection_string: "//localhost/XEPDB1" },
    { type: "oracle", connection_string: "[::1]:1521/ORCL" },
    { type: "mysql", server: "127.0.0.1" },
    { type: "mysql", socketPath: "/tmp/mysql.sock" },
    { type: "postgres", host: "/var/run/postgresql" },
    { type: "postgres", connection_string: "postgresql:///analytics?host=/var/run/postgresql" },
    { type: "sqlserver", host: "localhost\\SQLEXPRESS" },
  ]) expect(() => assertLocalConnection(config)).not.toThrow()
})

test("dbt finds the project from a subdirectory and reads profiles from the working directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-discovery-"))
  try {
    const models = path.join(root, "models")
    const runDir = path.join(root, "run")
    await fs.mkdir(models)
    await fs.mkdir(runDir)
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    // The project's own profiles.yml is local, but dbt run from runDir reads runDir/profiles.yml.
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: duckdb\n      path: ':memory:'\n")
    await fs.writeFile(path.join(runDir, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: postgres\n      host: example.com\n")
    await expect(assertLocalDbt(models, [], "core", root)).resolves.toEqual({ profilesDir: root })
    await expect(assertLocalDbt(models, [], "core", runDir)).rejects.toThrow("Offline mode")
    // dbt expands ~ in DBT_PROFILES_DIR.
    process.env.DBT_PROFILES_DIR = "~/" + path.relative(os.homedir(), root)
    await expect(assertLocalDbt(models, [], "core", runDir)).resolves.toEqual({ profilesDir: root })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("dbt-duckdb profiles that reach remote storage or a remote server are refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-duckdb-"))
  try {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    for (const extra of [
      "external_root: s3://bucket/x",
      "external_root: \"{{ var('root') }}\"",
      "external_root: \"{{ env_var('OFFLINE_TEST_UNSET_ROOT') }}\"",
      "remote:\n        host: db.example.com",
      "filesystems:\n        - fs: s3",
    ]) {
      await fs.writeFile(path.join(root, "profiles.yml"), `test:\n  outputs:\n    default:\n      type: duckdb\n      path: local.duckdb\n      ${extra}\n`)
      await expect(assertLocalDbt(root, ["--profiles-dir", root])).rejects.toThrow("Offline mode")
    }
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: duckdb\n      path: local.duckdb\n      external_root: out/parquet\n")
    await expect(assertLocalDbt(root, ["--profiles-dir", root])).resolves.toEqual({ profilesDir: root })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("offline dbt runs with the checked profiles directory and no version check", async () => {
  const { runDbt } = await import("../../../src/altimate/native/dbt/runner")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-run-"))
  const previousPath = process.env.PATH
  try {
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "dbt"), "#!/bin/sh\necho \"$DBT_PROFILES_DIR|$DBT_VERSION_CHECK|$DBT_SEND_ANONYMOUS_USAGE_STATS|$DO_NOT_TRACK|$PGHOSTADDR|$pgservice\"\n", { mode: 0o755 })
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: duckdb\n      path: ':memory:'\n")
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`
    process.env.ALTIMATE_OFFLINE = "1"
    const previousHostaddr = process.env.PGHOSTADDR
    const previousService = process.env.pgservice
    process.env.PGHOSTADDR = "198.51.100.20"
    // A differently-cased name is dropped too.
    process.env.pgservice = "remote-service"
    try {
      const result = await runDbt({ command: "ls", project_dir: root, args: ["--profiles-dir", root] })
      expect(result.exit_code).toBe(0)
      // libpq's destination override is dropped; usage reporting and the version check are off.
      expect(result.stdout.trim()).toBe(`${root}|false|false|1||`)
    } finally {
      if (previousService === undefined) delete process.env.pgservice
      else process.env.pgservice = previousService
      if (previousHostaddr === undefined) delete process.env.PGHOSTADDR
      else process.env.PGHOSTADDR = previousHostaddr
    }
    expect((await runDbt({ command: "deps", project_dir: root })).stderr).toContain("Offline mode")
    expect((await runDbt({ command: "ls", project_dir: root, args: ["--send-anonymous-usage-stats"] })).stderr).toContain(
      "Offline mode disables dbt usage reporting.",
    )
    expect((await runDbt({ command: "init", args: ["--version"] })).stderr).toContain("Offline mode disables dbt version reporting.")
    // `dbt init` needs no existing project or profile.
    const empty = path.join(root, "new")
    await fs.mkdir(empty)
    expect((await runDbt({ command: "init", project_dir: empty })).exit_code).toBe(0)
  } finally {
    process.env.PATH = previousPath
    await fs.rm(root, { recursive: true, force: true })
  }
})
test("dbt checks selected target and CLI overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-"))
  try {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: test\nprofile: test\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  target: local\n  outputs:\n    local:\n      type: duckdb\n      path: ':memory:'\n    remote:\n      type: postgres\n      host: example.com\n")
    const args = ["--profiles-dir", root]
    await expect(assertLocalDbt(root, args)).resolves.toEqual({ profilesDir: root })
    await expect(assertLocalDbt(root, [...args, "--target=remote"])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, [...args, "--target", "local", "-t", "remote"])).rejects.toThrow("Offline mode")
    await expect(assertLocalDbt(root, [...args, "-t", "remote", "--target", "local"])).resolves.toEqual({ profilesDir: root })
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
    await expect(assertLocalDbt(root, ["--profiles-dir", root, "--project-dir", root])).resolves.toEqual({ profilesDir: root })
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

test("the dbt adapter is checked against the project it will run, not DBT_PROJECT_DIR", async () => {
  const adapter = await import("../../../src/altimate/native/connections/register")
  const Dispatcher = await import("../../../src/altimate/native/dispatcher")
  const Registry = await import("../../../src/altimate/native/connections/registry")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-projectdir-"))
  const create = mock(async () => ({}))
  try {
    const other = path.join(root, "other")
    await fs.mkdir(other)
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: remote\n")
    await fs.writeFile(path.join(other, "dbt_project.yml"), "profile: local\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "local:\n  outputs:\n    default:\n      type: duckdb\n      path: ':memory:'\nremote:\n  outputs:\n    default:\n      type: postgres\n      host: db.example.com\n")
    process.env.ALTIMATE_OFFLINE = "1"
    process.env.DBT_PROJECT_DIR = other
    adapter.resetDbtAdapter()
    adapter.dbtAdapterInternals.readConfig = async () => ({ projectRoot: root })
    adapter.dbtAdapterInternals.create = create
    adapter.registerAll()
    const result = await Dispatcher.call("sql.execute", { sql: "SELECT 1" })
    expect((result as { error?: string }).error).toContain("Offline mode")
    expect(create).not.toHaveBeenCalled()
  } finally {
    delete adapter.dbtAdapterInternals.readConfig
    delete adapter.dbtAdapterInternals.create
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

test("cached remote target is rejected and closed offline without rereading credentials", async () => {
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
    expect(await Registry.get("remote")).toBe(connector as any)
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

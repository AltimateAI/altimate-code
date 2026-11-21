// altimate_change - new file
import { afterEach, beforeEach, expect, test } from "bun:test"
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

test("offline permits local files, loopback hosts and Unix sockets", () => {
  for (const store of [":memory:", "/tmp/warehouse.db", "data.duckdb", "file:///tmp/local.db"])
    for (const type of ["duckdb", "sqlite"]) expect(() => assertLocalConnection({ type, path: store })).not.toThrow()
  for (const config of [
    { type: "postgres", host: "localhost" },
    { type: "postgres", host: "127.0.1.2" },
    { type: "postgres", host: "::1" },
    { type: "postgres", host: "/var/run/postgresql" },
    { type: "postgres" },
    { type: "mysql", server: "127.0.0.1" },
    { type: "mysql", socketPath: "/tmp/mysql.sock" },
    { type: "postgres", connectionString: "postgres://localhost/test" },
    { type: "trino", server: "http://localhost:8080" },
    { type: "postgres", connection_string: "postgresql:///analytics?host=/var/run/postgresql" },
    { type: "sqlserver", host: "localhost\\SQLEXPRESS" },
    { type: "redshift" },
    { type: "clickhouse", host: "127.0.0.1", protocol: "HTTPS" },
  ]) expect(() => assertLocalConnection(config)).not.toThrow()
})

test("offline refuses remote hosts, remote storage, SSH and what it cannot parse", () => {
  for (const config of [
    { type: "duckdb", path: "md:cloud" },
    { type: "duckdb", path: "s3://bucket/db.duckdb" },
    { type: "duckdb", path: "https://example.com/db" },
    { type: "duckdb", path: "{{ 'md:cloud' }}" },
    { type: "sqlite", path: "file://example.com/share/db" },
    { type: "sqlite", path: "\\\\example.com\\share\\db" },
    { type: "postgres", host: "localhost.evil.test" },
    { type: "postgres", host: "127.0.0.1", ssh_host: "remote" },
    { type: "mysql", server: "db.example.com" },
    { type: "mysql", socketPath: "\\\\.\\pipe\\remote" },
    { type: "snowflake", account: "acme" },
    { type: "snowflake", account: "acme", host: "localhost" },
    { type: "bigquery", project: "p", host: "127.0.0.1" },
    { type: "databricks", host: "localhost" },
    { type: "trino", server: "https://example.com" },
    { type: "postgres", connection_string: "not a url" },
    { type: "oracle", connection_string: "db.example.com:1521/ORCL" },
    { type: "postgres", connection_string: "postgresql://localhost/db?host=db.example.com" },
    { type: "postgres", connection_string: "postgresql://localhost/db?hostaddr=10.0.0.5" },
    { type: "postgres", connection_string: "postgresql:///analytics" },
    { type: "sqlite", path: "file:////server/share/db.sqlite" },
    { type: "postgres", host: "/tmp,db.example.com" },
    { type: "mysql", host: "/tmp/mysql" },
    { type: "mongodb", connection_string: "mongodb+srv://localhost/db" },
    { type: "mongodb", connection_string: "mongodb://localhost/db?replicaSet=rs0" },
    { type: "sqlserver", host: "db.example.com\\SQLEXPRESS" },
    { type: "sqlserver", host: "localhost", authentication: "azure-active-directory-default" },
    { type: "mongodb", connection_string: "mongodb://localhost/db?authMechanism=MONGODB-AWS" },
    { type: "sqlite", path: "store.sqlite", ssh_host: "bastion.example.com" },
    { type: "clickhouse", host: "127.0.0.1", protocol: "http://evil.example/#" },
    { type: "trino", host: "localhost", protocol: "https://evil.example" },
    { type: "mongodb", host: "localhost", direct_connection: false },
  ]) expect(() => assertLocalConnection(config)).toThrow("Offline mode")
})

test("dbt-duckdb settings are refused only when they point at something remote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-duckdb-"))
  const profile = (extra: string) =>
    fs.writeFile(path.join(root, "profiles.yml"), `test:\n  outputs:\n    default:\n      type: duckdb\n      path: local.duckdb\n      ${extra}\n`)
  try {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    for (const extra of [
      "external_root: s3://bucket/x",
      "external_root: \"{{ var('root') }}\"",
      "attach:\n        - path: md:shared",
      "attach:\n        - path: https://example.com/remote.duckdb",
      "attach:\n        - path: host=db.example.com dbname=x\n          type: postgres",
      "extensions:\n        - name: custom\n          repo: https://extensions.example.com",
      "remote:\n        host: db.example.com",
      "filesystems:\n        - fs: s3",
    ]) {
      await profile(extra)
      await expect(assertLocalDbt(root, ["--profiles-dir", root])).rejects.toThrow("Offline mode")
    }
    for (const extra of [
      "external_root: out/parquet",
      "extensions:\n        - icu\n        - spatial",
      "attach:\n        - path: other.duckdb\n          alias: other",
      "plugins:\n        - module: excel",
    ]) {
      await profile(extra)
      await expect(assertLocalDbt(root, ["--profiles-dir", root])).resolves.toEqual({ profilesDir: root })
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("offline dbt runs with the checked profiles directory and no usage reporting", async () => {
  const { runDbt } = await import("../../../src/altimate/native/dbt/runner")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-dbt-run-"))
  const previousPath = process.env.PATH
  try {
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "dbt"), '#!/bin/sh\necho "$DBT_PROFILES_DIR|$DBT_VERSION_CHECK|$DBT_SEND_ANONYMOUS_USAGE_STATS|$DO_NOT_TRACK"\n', { mode: 0o755 })
    await fs.writeFile(path.join(root, "dbt_project.yml"), "profile: test\n")
    await fs.writeFile(path.join(root, "profiles.yml"), "test:\n  outputs:\n    default:\n      type: duckdb\n      path: ':memory:'\n")
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`
    process.env.ALTIMATE_OFFLINE = "1"
    const result = await runDbt({ command: "ls", project_dir: root, args: ["--profiles-dir", root] })
    expect(result.stdout.trim()).toBe(`${root}|false|false|1`)
    expect((await runDbt({ command: "deps", project_dir: root })).stderr).toContain("Offline mode disables dbt dependency installation.")
    expect((await runDbt({ command: "ls", project_dir: root, args: ["--send-anonymous-usage-stats"] })).stderr).toContain(
      "Offline mode disables dbt usage reporting.",
    )
  } finally {
    process.env.PATH = previousPath
    await fs.rm(root, { recursive: true, force: true })
  }
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

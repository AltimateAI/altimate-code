// altimate_change - new file
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertLocalConnection } from "../../../src/altimate/native/connections/offline"
import { assertLocalDbt } from "../../../src/altimate/native/dbt/offline"

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
    await expect(assertLocalDbt(root, args, "cloud")).rejects.toThrow("Offline mode")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

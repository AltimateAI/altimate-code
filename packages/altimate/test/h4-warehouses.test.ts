import { expect, test } from "bun:test"
import { connect } from "@altimateai/drivers/duckdb"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { readLegacyWarehouses } from "../src/legacy-warehouses"
import { createHost } from "./lib/host"

async function fixture() {
  await mkdir("/private/tmp/altimate-h4/warehouse/tests", { recursive: true })
  const directory = await mkdtemp("/private/tmp/altimate-h4/warehouse/tests/case-")
  return {
    directory,
    home: join(directory, "home"),
    project: join(directory, "project"),
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  }
}

test("H4 global < project < env precedence and source-relative file paths", async () => {
  await using files = await fixture()
  await Bun.write(
    join(files.home, ".altimate-code/connections.json"),
    JSON.stringify({
      global: { type: "duckdb", path: "global.duckdb" },
      shared: { type: "duckdb", path: "global-shared.duckdb" },
    }),
  )
  await Bun.write(
    join(files.project, ".altimate-code/connections.json"),
    JSON.stringify({
      local: { type: "duckdb", path: "local.duckdb" },
      shared: { type: "duckdb", path: "project-shared.duckdb" },
    }),
  )
  const result = await readLegacyWarehouses({
    directory: files.project,
    home: files.home,
    env: {
      ALTIMATE_CODE_CONN_SHARED: JSON.stringify({ type: "DUCKDB", path: "env.duckdb", password: "fixture-secret" }),
    },
  })
  expect(result.warehouses).toEqual([
    { name: "global", type: "duckdb", path: join(files.home, ".altimate-code/global.duckdb") },
    { name: "shared", type: "duckdb", path: join(files.project, "env.duckdb") },
    { name: "local", type: "duckdb", path: join(files.project, "local.duckdb") },
  ])
  expect(JSON.stringify(result)).not.toContain("fixture-secret")
  expect(result.issues).toEqual([])
})

test("H4 inventories unsupported types and reports unusable DuckDB entries without secret values", async () => {
  await using files = await fixture()
  await Bun.write(
    join(files.home, ".altimate-code/connections.json"),
    JSON.stringify({
      remote: { type: "snowflake", password: "fixture-secret" },
      missing: { type: "duckdb", database: "old-alias" },
      invalid: { password: "fixture-secret" },
      wrongPath: { type: "duckdb", path: 42 },
    }),
  )
  const result = await readLegacyWarehouses({ directory: files.project, home: files.home, env: {} })
  expect(result.warehouses).toEqual([])
  expect(result.inventory).toHaveLength(3)
  expect(result.issues.map((issue) => issue.reason)).toEqual([
    "invalid-entry",
    "unsupported-type:snowflake",
    "missing-duckdb-path",
    "missing-duckdb-path",
  ])
  expect(JSON.stringify(result)).not.toContain("fixture-secret")
})

test("H4 malformed file and env input do not discard other usable connections", async () => {
  await using files = await fixture()
  await Bun.write(join(files.home, ".altimate-code/connections.json"), "[]")
  await Bun.write(
    join(files.project, ".altimate-code/connections.json"),
    JSON.stringify({
      good: { type: "duckdb", path: ":memory:" },
    }),
  )
  const result = await readLegacyWarehouses({
    directory: files.project,
    home: files.home,
    env: {
      ALTIMATE_CODE_CONN_BAD: "{invalid",
    },
  })
  expect(result.warehouses).toEqual([{ name: "good", type: "duckdb", path: ":memory:" }])
  expect(result.issues.map((issue) => issue.reason)).toEqual(["invalid-json-object", "invalid-entry"])
})

test("H4 preserves memory, URI, Windows and absolute paths", async () => {
  await using files = await fixture()
  const paths = [
    ":memory:",
    "md:database",
    "s3://bucket/store.duckdb",
    "file:/tmp/store.duckdb",
    "C:\\data\\store.duckdb",
    "/tmp/store.duckdb",
  ]
  await Bun.write(
    join(files.home, ".altimate-code/connections.json"),
    JSON.stringify(Object.fromEntries(paths.map((path, index) => [`c${index}`, { type: "duckdb", path }]))),
  )
  const result = await readLegacyWarehouses({ directory: files.project, home: files.home, env: {} })
  expect(result.warehouses.map((warehouse) => warehouse.path)).toEqual(paths)
})

test("H4 unreadable files report an issue without blocking valid project definitions", async () => {
  await using files = await fixture()
  await mkdir(join(files.home, ".altimate-code/connections.json"), { recursive: true })
  await Bun.write(
    join(files.project, ".altimate-code/connections.json"),
    JSON.stringify({
      good: { type: "duckdb", path: ":memory:" },
    }),
  )
  const result = await readLegacyWarehouses({ directory: files.project, home: files.home, env: {} })
  expect(result.warehouses).toEqual([{ name: "good", type: "duckdb", path: ":memory:" }])
  expect(result.issues.map((issue) => issue.reason)).toEqual(["unreadable-file"])
})

test(
  "H4 imported file-backed DuckDB runs select 42 through the plugin and imports only once",
  () =>
    isolatedEnv(async () => {
      await using files = await fixture()
      await mkdir(files.project, { recursive: true })
      const database = join(files.project, "probe.duckdb")
      const connector = await connect({ type: "duckdb", path: database, create: true })
      await connector.connect()
      await connector.close()
      const legacyPath = join(files.project, ".altimate-code/connections.json")
      await Bun.write(legacyPath, JSON.stringify({ migrated: { type: "duckdb", path: "probe.duckdb" } }))
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "probe", input: { warehouse: "migrated", sql: "select 42 AS answer" } },
        ])
        const result = events.find((event) => event.type === "session.tool.success" && event.data.id === "probe")
        expect(result?.type === "session.tool.success" && result.data.metadata).toMatchObject({ rows: [[42]] })
      }
      await Bun.write(legacyPath, JSON.stringify({ migrated: { type: "duckdb", path: "missing.duckdb" } }))
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "again", input: { warehouse: "migrated", sql: "select 42 AS answer" } },
        ])
        const result = events.find((event) => event.type === "session.tool.success" && event.data.id === "again")
        expect(result?.type === "session.tool.success" && result.data.metadata).toMatchObject({ rows: [[42]] })
      }
    }),
  30_000,
)

test(
  "H4 environment overrides refresh after restart and never persist with warehouse additions",
  () =>
    isolatedEnv(async () => {
      await using files = await fixture()
      await Bun.write(
        join(files.project, ".altimate-code/connections.json"),
        JSON.stringify({
          migrated: { type: "duckdb", path: ":memory:" },
        }),
      )
      process.env.ALTIMATE_CODE_CONN_MIGRATED = JSON.stringify({ type: "duckdb", path: "absent.duckdb" })
      process.env.ALTIMATE_CODE_CONN_EPHEMERAL = JSON.stringify({ type: "duckdb", path: ":memory:" })
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "override", input: { warehouse: "migrated", sql: "select 42" } },
          { tool: "sql_execute", id: "ephemeral", input: { warehouse: "ephemeral", sql: "select 42" } },
          { tool: "warehouse_add", id: "save", input: { name: "saved", path: ":memory:" } },
        ])
        expect(events.some((event) => event.type === "session.tool.failed" && event.data.id === "override")).toBe(true)
        expect(events.some((event) => event.type === "session.tool.success" && event.data.id === "ephemeral")).toBe(
          true,
        )
      }
      process.env.ALTIMATE_CODE_CONN_MIGRATED = JSON.stringify({ type: "duckdb", path: ":memory:" })
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "refreshed", input: { warehouse: "migrated", sql: "select 42" } },
        ])
        expect(events.some((event) => event.type === "session.tool.success" && event.data.id === "refreshed")).toBe(
          true,
        )
      }
      delete process.env.ALTIMATE_CODE_CONN_MIGRATED
      delete process.env.ALTIMATE_CODE_CONN_EPHEMERAL
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "original", input: { warehouse: "migrated", sql: "select 42" } },
          { tool: "sql_execute", id: "gone", input: { warehouse: "ephemeral", sql: "select 42" } },
          { tool: "sql_execute", id: "saved", input: { warehouse: "saved", sql: "select 42" } },
        ])
        expect(events.some((event) => event.type === "session.tool.success" && event.data.id === "original")).toBe(true)
        expect(events.some((event) => event.type === "session.tool.failed" && event.data.id === "gone")).toBe(true)
        expect(events.some((event) => event.type === "session.tool.success" && event.data.id === "saved")).toBe(true)
      }
    }),
  30_000,
)

async function isolatedEnv(run: () => Promise<void>) {
  const saved = Object.entries(process.env).filter(([name]) => name.startsWith("ALTIMATE_CODE_CONN_"))
  saved.forEach(([name]) => delete process.env[name])
  try {
    await run()
  } finally {
    Object.keys(process.env)
      .filter((name) => name.startsWith("ALTIMATE_CODE_CONN_"))
      .forEach((name) => delete process.env[name])
    saved.forEach(([name, value]) => {
      process.env[name] = value
    })
  }
}

test(
  "H4 failed legacy input can be repaired and retried on the next host",
  () =>
    isolatedEnv(async () => {
      await using files = await fixture()
      const source = join(files.project, ".altimate-code/connections.json")
      await Bun.write(source, "{invalid")
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "missing", input: { warehouse: "repaired", sql: "select 42" } },
        ])
        expect(events.some((event) => event.type === "session.tool.failed" && event.data.id === "missing")).toBe(true)
      }
      await Bun.write(source, JSON.stringify({ repaired: { type: "duckdb", path: ":memory:" } }))
      {
        await using host = await createHost({ directory: files.project })
        const session = await host.createSession()
        const events = await host.run(session.id, [
          { tool: "sql_execute", id: "recovered", input: { warehouse: "repaired", sql: "select 42" } },
        ])
        expect(events.some((event) => event.type === "session.tool.success" && event.data.id === "recovered")).toBe(
          true,
        )
      }
    }),
  30_000,
)

import { afterEach, describe, expect, test } from "bun:test"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  SCRATCH_CONFIG,
  closeScratch,
  getScratch,
  scratchOpened,
  withScratchConnection,
} from "../../src/altimate/native/connections/scratch"
import { materialize } from "../../src/altimate/tools/sql-materialize"

afterEach(closeScratch)

describe("scratch catalog recovery", () => {
  test("reopening preserves existing tables and create/append semantics", async () => {
    const scratch = await getScratch()
    await scratch.execute("CREATE TABLE before_restart AS SELECT 42 AS id")
    await scratch.close()
    await scratch.connect()
    expect(await getScratch()).toBe(scratch)
    expect((await scratch.execute("SELECT id FROM scratch.before_restart")).rows).toEqual([[42]])

    const input = { source_warehouse: "scratch", sql: "SELECT 7 AS id", target_table: "recovered" }
    await materialize(input)
    expect((await scratch.execute("SELECT id FROM scratch.recovered")).rows).toEqual([[7n]])
    expect((await scratch.execute("SELECT current_database()")).rows).toEqual([["scratch"]])
    expect(
      (await scratch.execute("SELECT table_catalog FROM information_schema.tables WHERE table_name = 'recovered'"))
        .rows,
    ).toEqual([["scratch"]])

    await expect(materialize(input)).rejects.toThrow(/already exists/)
    const appended = await materialize({ ...input, sql: "SELECT 8 AS id", mode: "append" })
    expect(appended.total_rows).toBe(2)
    expect((await scratch.execute("SELECT id FROM scratch.recovered ORDER BY id")).rows).toEqual([[7n], [8n]])
  })

  test("reapplies the current catalog without replacing an existing attachment", async () => {
    const scratch = await getScratch()
    await scratch.execute("CREATE TABLE retained AS SELECT 42 AS id")
    await scratch.execute("ATTACH ':memory:' AS other")
    await scratch.execute("USE other")
    expect((await scratch.execute("SELECT id FROM retained")).rows).toEqual([[42]])
    expect((await scratch.execute("SELECT id FROM scratch.retained")).rows).toEqual([[42]])
  })

  test("materialized tables survive a query timeout and helper restart", async () => {
    await materialize({ source_warehouse: "scratch", sql: "SELECT 7 AS id", target_table: "before_timeout" })
    const scratch = await getScratch()
    const error = await scratch
      .execute(
        "SELECT sum(a.i * b.i) FROM range(1000000000) a(i), range(1000000000) b(i)",
        undefined,
        undefined,
        { queryTimeoutMs: 200 },
      )
      .catch((error) => error)
    expect(error).toBeInstanceOf(QueryTimeoutError)
    expect(error).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    expect(error.message).toContain("data already committed to the store is unaffected")
    expect((await scratch.execute("SELECT id FROM scratch.before_timeout")).rows).toEqual([[7n]])
    await scratch.execute("CREATE TABLE after_timeout AS SELECT 9 AS id")
    expect((await scratch.execute("SELECT id FROM scratch.after_timeout")).rows).toEqual([[9]])
  })

  test("uses a private temporary directory and removes it on close", async () => {
    expect(scratchOpened()).toBe(false)
    expect(SCRATCH_CONFIG).toEqual({ type: "duckdb" })
    const scratch = await getScratch()
    const store = (await scratch.execute("SELECT path FROM duckdb_databases() WHERE database_name = 'scratch'"))
      .rows[0]![0] as string
    const dir = path.dirname(store)
    expect(path.basename(store)).toBe("scratch.duckdb")
    expect(fs.existsSync(store)).toBe(true)
    if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    await closeScratch()
    expect(fs.existsSync(dir)).toBe(false)
    const fresh = await getScratch()
    const reopened = (await fresh.execute("SELECT path FROM duckdb_databases() WHERE database_name = 'scratch'"))
      .rows[0]![0]
    expect(reopened).not.toBe(store)
  })

  test("redacts private store paths from error messages and stacks", async () => {
    const scratch = await getScratch()
    const store = (await scratch.execute("SELECT path FROM duckdb_databases() WHERE database_name = 'scratch'"))
      .rows[0]![0] as string
    const dir = path.dirname(store)
    const error = await scratch
      .execute("SELECT * FROM read_parquet(?)", undefined, [path.join(dir, "missing")])
      .catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("scratch")
    expect(error.message).not.toContain(dir)
    expect(error.stack).not.toContain(dir)
  })

  test("removes the store on process exit without closeScratch", async () => {
    const source = new URL("../../src/altimate/native/connections/scratch.ts", import.meta.url).href
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", `
        const { getScratch } = await import(${JSON.stringify(source)})
        const scratch = await getScratch()
        const result = await scratch.execute("SELECT path FROM duckdb_databases() WHERE database_name = 'scratch'")
        console.log(JSON.stringify(result.rows[0][0]))
        process.exit(0)
      `],
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const store = JSON.parse(output)
    expect(path.basename(store)).toBe("scratch.duckdb")
    expect(fs.existsSync(path.dirname(store))).toBe(false)
  })

  test("failed initialization removes its directory and redacts the open error", async () => {
    const source = new URL("../../src/altimate/native/connections/scratch.ts", import.meta.url).href
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", `
        import { mock } from "bun:test"
        import { existsSync } from "node:fs"
        import { dirname } from "node:path"
        let store
        mock.module("@altimateai/drivers/duckdb", () => ({
          connect: async (config) => {
            store = config.path
            throw new Error("Could not open " + store)
          },
        }))
        const { getScratch, scratchOpened } = await import(${JSON.stringify(source)})
        const error = await getScratch().catch((error) => error)
        console.log(JSON.stringify({
          directoryExists: existsSync(dirname(store)),
          opened: scratchOpened(),
          message: error.message,
          stackLeaked: error.stack.includes(store),
        }))
      `],
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(output)).toEqual({
      directoryExists: false,
      opened: false,
      message: "Could not open scratch",
      stackLeaked: false,
    })
  })
})

describe("scratch exclusive operations", () => {
  test("external queries wait for the complete transaction", async () => {
    const scratch = await getScratch()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const operation = withScratchConnection(async (connection) => {
      await connection.execute("BEGIN TRANSACTION")
      await connection.execute("CREATE TABLE atomic_result AS SELECT 1 AS id")
      entered.resolve()
      await finish.promise
      await connection.execute("INSERT INTO atomic_result VALUES (2)")
      await connection.execute("COMMIT")
    })
    await entered.promise
    const read = scratch.execute("SELECT count(*) FROM scratch.atomic_result")
    finish.resolve()
    await operation
    expect((await read).rows).toEqual([[2n]])
  })

  test("a rejected transaction can roll back and releases the connection", async () => {
    await expect(
      withScratchConnection(async (connection) => {
        await connection.execute("BEGIN TRANSACTION")
        try {
          await connection.execute("CREATE TABLE rolled_back (id INTEGER)")
          await connection.execute("INSERT INTO rolled_back VALUES ('invalid')")
        } finally {
          await connection.execute("ROLLBACK")
        }
      }),
    ).rejects.toThrow()
    const scratch = await getScratch()
    await scratch.execute("CREATE TABLE rolled_back AS SELECT 3 AS id")
    expect((await scratch.execute("SELECT id FROM scratch.rolled_back")).rows).toEqual([[3]])
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { closeScratch, getScratch, withScratchConnection } from "../../src/altimate/native/connections/scratch"
import { materialize } from "../../src/altimate/tools/sql-materialize"

afterEach(closeScratch)

describe("scratch catalog recovery", () => {
  test("reopening restores the catalog and preserves create/append semantics for new tables", async () => {
    const scratch = await getScratch()
    await scratch.execute("CREATE TABLE before_restart (id INTEGER)")
    await scratch.close()
    await scratch.connect()
    expect(await getScratch()).toBe(scratch)

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
    await scratch.execute("USE memory")
    expect((await scratch.execute("SELECT id FROM retained")).rows).toEqual([[42]])
    expect((await scratch.execute("SELECT id FROM scratch.retained")).rows).toEqual([[42]])
  })

  test("a timed-out engine restores scratch before the next write", async () => {
    const scratch = await getScratch()
    await expect(
      scratch.execute(
        "SELECT sum(a.i * b.i) FROM range(1000000000) a(i), range(1000000000) b(i)",
        undefined,
        undefined,
        { queryTimeoutMs: 200 },
      ),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    await scratch.execute("CREATE TABLE after_timeout AS SELECT 9 AS id")
    expect((await scratch.execute("SELECT id FROM scratch.after_timeout")).rows).toEqual([[9]])
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

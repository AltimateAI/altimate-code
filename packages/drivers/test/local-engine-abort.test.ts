import { expect, test } from "bun:test"
import { connect as sqlite } from "../src/sqlite"
import { connect as duckdb } from "../src/duckdb"

for (const [name, connect, sql] of [
  ["SQLite", sqlite, "WITH RECURSIVE values_cte(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM values_cte WHERE n < 4000000000) SELECT count(*) FROM values_cte"],
  ["DuckDB", duckdb, "SELECT count(*) FROM range(100000000000) a, range(1000) b"],
] as const) {
  test(`${name} abort kills an active helper and rejects queued work`, async () => {
    const connector = await connect({ type: name.toLowerCase(), path: ":memory:" })
    await connector.connect()
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const reason = new Error("session stopped")
    const running = connector.execute(sql, 10, undefined, {
      signal: controller.signal,
      onDispatch: () => started.resolve(),
      queryTimeoutMs: 500,
    }).catch((error) => error)
    try {
      await started.promise
      const queued = connector.execute("CREATE TABLE later(value INTEGER)").catch((error) => error)
      const start = performance.now()
      controller.abort(reason)
      expect(await running).toBe(reason)
      expect(performance.now() - start).toBeLessThan(2000)
      expect(await queued).toMatchObject({ code: "SESSION_STATE_LOST" })
      expect((await connector.execute("SELECT 1 AS value")).rows).toEqual([[1]])
      await expect(connector.execute("SELECT * FROM later")).rejects.toThrow()
    } finally {
      await connector.close()
    }
  })

  test(`${name} abort reports lost session state on the next statement`, async () => {
    const connector = await connect({ type: name.toLowerCase(), path: ":memory:" })
    await connector.connect()
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const running = connector.execute(sql, 10, undefined, {
      signal: controller.signal,
      onDispatch: () => started.resolve(),
      queryTimeoutMs: 500,
    }).catch((error) => error)
    try {
      await started.promise
      controller.abort(new Error("session stopped"))
      await running
      await expect(connector.execute("SELECT 1 AS value")).rejects.toMatchObject({ code: "SESSION_STATE_LOST" })
      expect((await connector.execute("SELECT 1 AS value")).rows).toEqual([[1]])
    } finally {
      await connector.close()
    }
  })

  test(`${name} cancels queued work without interrupting its active peer`, async () => {
    const connector = await connect({ type: name.toLowerCase(), path: ":memory:" })
    await connector.connect()
    const controller = new AbortController()
    const reason = new Error("queued request stopped")
    const running = connector.execute(sql, 10, undefined, { queryTimeoutMs: 300 }).catch((error) => error)
    const queued = connector.execute("CREATE TABLE later(value INTEGER)", undefined, undefined, {
      signal: controller.signal,
    }).catch((error) => error)
    controller.abort(reason)
    try {
      expect(await Promise.race([queued, Bun.sleep(100).then(() => "still queued")])).toBe(reason)
      expect(await running).toMatchObject({ code: "QUERY_TIMEOUT" })
      await expect(connector.execute("SELECT * FROM later")).rejects.toThrow()
    } finally {
      await connector.close()
    }
  })
}

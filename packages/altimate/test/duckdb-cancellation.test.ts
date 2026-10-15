import { expect, test } from "bun:test"
import { connect } from "@altimateai/drivers/duckdb"

test("aborting a queued DuckDB write leaves the active query running and never executes the write", async () => {
  const connector = await connect({ type: "duckdb", path: ":memory:" })
  await connector.connect()
  try {
    const controller = new AbortController()
    const active = connector.execute(
      "CREATE TABLE active_result AS SELECT sum(sin(i::DOUBLE)) AS value FROM range(100000000) AS t(i)",
    )
    const queued = connector.execute("CREATE TABLE queued_abort AS SELECT 1 AS value", undefined, undefined, {
      signal: controller.signal,
    })
    // The first query is executing natively while the second awaits admission.
    await Bun.sleep(50)
    controller.abort()
    const results = await Promise.allSettled([active, queued])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } })
    expect(
      await connector.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('active_result', 'queued_abort') ORDER BY table_name",
      ),
    ).toMatchObject({ rows: [["active_result"]] })
  } finally {
    await connector.close()
  }
}, 10_000)

test("an already-aborted DuckDB signal rejects before executing SQL", async () => {
  const connector = await connect({ type: "duckdb", path: ":memory:" })
  await connector.connect()
  try {
    const controller = new AbortController()
    controller.abort()
    await expect(
      connector.execute("CREATE TABLE already_aborted AS SELECT 1 AS value", undefined, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(
      await connector.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'already_aborted'"),
    ).toMatchObject({ rows: [] })
    expect(await connector.execute("SELECT 42 AS still_usable")).toMatchObject({ rows: [[42]] })
  } finally {
    await connector.close()
  }
})

test("DuckDB preserves Date and byte binds, empty result columns, and noLimit", async () => {
  const connector = await connect({ type: "duckdb", path: ":memory:" })
  await connector.connect()
  try {
    const date = new Date("2024-01-02T03:04:05.678Z")
    const result = await connector.execute(
      "SELECT ?::TIMESTAMP AS stamp, ?::BLOB AS payload, ?::BLOB AS raw, i FROM range(3) AS t(i)",
      1,
      [date, Buffer.from([0, 127, 255]), new Uint8Array([5, 6])],
      { noLimit: true },
    )
    expect(result).toMatchObject({
      columns: ["stamp", "payload", "raw", "i"],
      row_count: 3,
      truncated: false,
    })
    expect(result.rows[0]).toEqual([date, new Uint8Array([0, 127, 255]), new Uint8Array([5, 6]), 0n])
    expect(await connector.execute("SELECT ?::TIMESTAMP AS stamp WHERE false", undefined, [date])).toEqual({
      columns: ["stamp"],
      rows: [],
      row_count: 0,
      truncated: false,
    })
  } finally {
    await connector.close()
  }
})

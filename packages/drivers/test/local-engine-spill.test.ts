import { afterEach, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { connect } from "../src/duckdb"
import type { Connector } from "../src/types"

const connections: Connector[] = []

afterEach(async () => {
  while (connections.length) await connections.pop()!.close()
})

async function spillingConnection() {
  const connector = await connect({ type: "duckdb", path: ":memory:" })
  connections.push(connector)
  await connector.connect()
  await connector.execute("SET memory_limit = '16MB'")
  const result = await connector.execute("SELECT current_setting('temp_directory')")
  const spillDirectory = result.rows[0]![0] as string
  await connector.execute(
    "CREATE TABLE spilled AS SELECT i, repeat(md5(i::VARCHAR), 32) AS payload FROM range(100000) t(i)",
  )
  expect(fs.readdirSync(spillDirectory).length).toBeGreaterThan(0)
  const pid = Number(path.basename(spillDirectory).slice("duckdb-".length))
  return { connector, spillDirectory, pid }
}

test("removes timed-out DuckDB spill files after exit and preserves a live helper's spill files", async () => {
  const timedOut = await spillingConnection()
  const live = await spillingConnection()

  await expect(
    timedOut.connector.execute("SELECT count(*) FROM range(100000000000) a, range(1000) b", 10, undefined, {
      queryTimeoutMs: 100,
    }),
  ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })

  expect(() => process.kill(timedOut.pid, 0)).toThrow()
  expect(fs.existsSync(timedOut.spillDirectory)).toBe(false)
  expect(fs.readdirSync(live.spillDirectory).length).toBeGreaterThan(0)
  expect((await live.connector.execute("SELECT count(*) FROM spilled")).rows).toEqual([[100000n]])

  const restarted = await timedOut.connector.execute("SELECT current_setting('temp_directory'), 42 AS answer")
  expect(restarted.rows[0]![0]).not.toBe(timedOut.spillDirectory)
  expect(restarted.rows[0]![1]).toBe(42)
  await live.connector.close()
  expect(fs.existsSync(live.spillDirectory)).toBe(false)
})

test("removes DuckDB spill files after an unexpected helper exit", async () => {
  const { connector, spillDirectory, pid } = await spillingConnection()
  process.kill(pid, "SIGKILL")
  for (let attempt = 0; attempt < 500 && fs.existsSync(spillDirectory); attempt++) await Bun.sleep(10)
  expect(fs.existsSync(spillDirectory)).toBe(false)
  expect((await connector.execute("SELECT 7 AS answer")).rows).toEqual([[7]])
})

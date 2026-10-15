import { connect } from "@altimateai/drivers/duckdb"

const connector = await connect({ type: "duckdb", path: process.argv[2] })
await connector.connect()
try {
  const absent = await connector.execute(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'after_abort'",
  )
  const before = await connector.execute("SELECT value FROM before_abort")
  await connector.execute("CREATE TABLE reopened AS SELECT 42 AS value")
  const written = await connector.execute("SELECT value FROM reopened")
  process.stdout.write(JSON.stringify({ absent: absent.rows, before: before.rows, written: written.rows }))
} finally {
  await connector.close()
}

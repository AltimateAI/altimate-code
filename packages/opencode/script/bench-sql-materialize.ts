import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// bun run script/bench-sql-materialize.ts [label] [rows] [materialize-module]
// The optional module lets the same workload measure a saved implementation.
const label = Bun.argv[2] ?? "current"
const rows = Number(Bun.argv[3] ?? 1_000_000)
assert(Number.isSafeInteger(rows) && rows > 0 && rows <= 20_000_000, "Invalid row count")
const isolated = await mkdtemp(join(tmpdir(), "sql-materialize-evaluation-run-"))
for (const [key, name] of Object.entries({
  XDG_DATA_HOME: "data",
  XDG_CONFIG_HOME: "config",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  OPENCODE_TEST_HOME: "home",
  OPENCODE_TEST_MANAGED_CONFIG_DIR: "managed",
})) {
  process.env[key] = join(isolated, name)
  await mkdir(process.env[key]!, { recursive: true })
}
process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
process.env.ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE = "1"
process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
process.env.OPENCODE_DISABLE_PROJECT_COPY_REFRESH = "1"
process.env.OPENCODE_MODELS_PATH = resolve(import.meta.dir, "../test/tool/fixtures/models-api.json")

const Registry = await import("../src/altimate/native/connections/registry")
const { closeScratch, getScratch } = await import("../src/altimate/native/connections/scratch")
const moduleURL = Bun.argv[4]
  ? pathToFileURL(resolve(Bun.argv[4])).href
  : new URL("../src/altimate/tools/sql-materialize.ts", import.meta.url).href
const { materialize } = (await import(moduleURL)) as typeof import("../src/altimate/tools/sql-materialize")

try {
  Registry.setConfigs({ evaluation_source: { type: "sqlite", path: ":memory:" } })
  const source = await Registry.get("evaluation_source")
  await source.execute(
    `CREATE TABLE source_rows AS
     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${rows})
     SELECT n AS id, n % 1000 AS group_id, n / 8.0 AS amount,
            CASE WHEN n % 10 = 0 THEN NULL ELSE printf('row %d ''quoted''%s雪', n, char(10)) END AS note
     FROM seq`,
    undefined,
    undefined,
    { noLimit: true, queryTimeoutMs: 0 },
  )
  const aggregate =
    "count(*), sum(id), sum(group_id), sum(amount), sum(length(note)), sum(CASE WHEN note IS NULL THEN 1 ELSE 0 END)"
  const expected = await source.execute(`SELECT ${aggregate} FROM source_rows`)
  console.log(JSON.stringify({ label, phase: "seeded", rows, source: "sqlite :memory:", bun: Bun.version }))

  const start = performance.now()
  const result = await materialize({
    source_warehouse: "evaluation_source",
    sql: "SELECT id, group_id, amount, note FROM source_rows",
    target_table: "evaluation_rows",
    max_rows: rows,
    query_timeout_ms: 0,
  })
  const elapsedMs = performance.now() - start

  const scratch = await getScratch()
  const actual = await scratch.execute(`SELECT ${aggregate} FROM evaluation_rows`)
  assert.equal(result.rows, rows)
  assert.equal(result.total_rows, rows)
  assert.equal(result.materialized, true)
  assert.deepEqual(
    actual.rows.map((r) => r.map(String)),
    expected.rows.map((r) => r.map(String)),
  )
  console.log(
    JSON.stringify({
      label,
      rows,
      elapsed_ms: Math.round(elapsedMs),
      elapsed_seconds: Number((elapsedMs / 1000).toFixed(3)),
      rows_per_second: Math.round(rows / (elapsedMs / 1000)),
      columns: result.columns,
      checksum: actual.rows[0].map(String),
      verified: true,
    }),
  )
} finally {
  await closeScratch()
  await Registry.closeAll()
  await rm(isolated, { recursive: true, force: true })
}
process.exit(0)

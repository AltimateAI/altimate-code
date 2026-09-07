/**
 * A warehouse failure must never reach the agent as an empty result.
 *
 * Field report against the real rig: a compiled binary returned "no tables"
 * with no error and no file created anywhere on disk. The cause was not the
 * silent-creation path — it is that a failure was shaped like success all the
 * way to the model:
 *
 *   1. `packages/drivers/src/duckdb.ts` read `(config.path as string) ?? ":memory:"`,
 *      so a config that arrived without a `path` became an in-memory database.
 *      Nothing is created, nothing is on disk, every query returns no rows.
 *   2. `sql.execute` never throws. It catches every connection and query error
 *      and returns `{ columns: [], rows: [], row_count: 0, error }`
 *      (native/connections/register.ts).
 *   3. `formatResult()` rendered that as the literal string `"(0 rows)"` and
 *      never read `error` — so the agent saw a healthy empty table.
 *
 * The layers are tested where each one breaks: the guard against the real
 * registry, and the rendering against a stubbed `sql.execute` that returns the
 * error-carrying shape the real handler produces. The stub is deliberate —
 * `Dispatcher.reset()` leaks between test files in Bun, and the true
 * end-to-end through the live dispatcher is covered by the compiled-binary
 * test in store-path-resolution.test.ts, which runs in its own process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"

/** Unguessable, so a pass cannot come from anything but the real store. */
const CANARY_TABLE = "zorbulax_ledger"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}

const tmpDirs: string[] = []
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-failure-"))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  Registry.reset()
})

afterEach(() => {
  Registry.reset()
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const LIST_TABLES = `SELECT name FROM sqlite_master WHERE type = 'table'`

describe("a file-backed connection that cannot be resolved fails loudly", () => {
  test("a config with no path is rejected instead of becoming an in-memory database", async () => {
    // The reported shape: nothing on disk, no error, every query empty. A
    // `?? ":memory:"` default turns any failure to carry a path into a
    // successful query against nothing.
    Registry.setConfigs({ wh: { type: "sqlite" } })

    await expect(Registry.get("wh")).rejects.toThrow(/path/)
  })

  test("a missing store file is rejected, and no store is conjured", async () => {
    const missing = path.join(tmp(), "definitely-absent.db")
    Registry.setConfigs({ wh: { type: "sqlite", path: missing } })

    await expect(Registry.get("wh")).rejects.toThrow(/not found/)
    expect(fs.existsSync(missing)).toBe(false)
  })

  test("an explicit :memory: is still honoured — it just has to be asked for", async () => {
    Registry.setConfigs({ wh: { type: "sqlite", path: ":memory:" } })

    const connector = await Registry.get("wh")
    const result = await connector.execute("SELECT 1 AS n")
    expect(result.rows[0][0]).toBe(1)
  })

  test("a populated store still opens and returns its real tables", async () => {
    const store = path.join(tmp(), "warehouse.db")
    const seed = new Database(store, { create: true })
    seed.exec(`CREATE TABLE ${CANARY_TABLE}(id INTEGER)`)
    seed.close()
    Registry.setConfigs({ wh: { type: "sqlite", path: store } })

    const connector = await Registry.get("wh")
    const result = await connector.execute(LIST_TABLES)
    expect(result.rows.map((r) => r[0])).toContain(CANARY_TABLE)
  })
})

describe("sql_execute renders a warehouse failure as a failure", () => {
  // Reset first, then register: `call()` runs the lazy registration hook
  // before dispatching, and that would re-import the real handler and clobber
  // the stub. This is the same order tool-response-normalization.test.ts uses.
  beforeEach(() => {
    Dispatcher.reset()
  })

  /** The exact shape sql.execute returns for any connection or query error. */
  function stubFailure(message: string) {
    Dispatcher.register("sql.execute" as any, async () => ({
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      error: message,
    }))
  }

  test("an error-carrying result is reported, not printed as (0 rows)", async () => {
    // This is the step that turned a broken connection into "no tables":
    // formatResult() returned "(0 rows)" for row_count === 0 and never looked
    // at `error`, so the model was told the warehouse was simply empty.
    stubFailure('SQLite database file not found: "/nowhere/absent.db".')

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute({ query: LIST_TABLES }, ctx as any)

    expect(result.output).not.toContain("(0 rows)")
    expect(result.title).toContain("ERROR")
    expect(result.output).toContain("not found")
    expect(result.metadata.error).toBeDefined()
  })

  test("a genuinely empty result set is still reported as empty, not as an error", async () => {
    // The distinction that matters: zero rows from a healthy warehouse is not
    // a failure, and must not start reporting as one.
    Dispatcher.register("sql.execute" as any, async () => ({
      columns: ["name"],
      rows: [],
      row_count: 0,
      truncated: false,
    }))

    const tool = await initTool(SqlExecuteTool)
    const result = await tool.execute({ query: LIST_TABLES }, ctx as any)

    expect(result.title).not.toContain("ERROR")
    expect(result.output).toContain("(0 rows)")
    expect(result.metadata.error).toBeUndefined()
  })
})

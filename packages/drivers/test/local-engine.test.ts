/**
 * Query execution deadlines for the file-backed engines, against the real
 * helper process and the real bun:sqlite / duckdb bindings.
 *
 * The expensive queries are deterministic: a recursive CTE / cross join that
 * would run for minutes if not stopped.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { connect as connectSqlite } from "../src/sqlite"
import { connect as connectDuckdb } from "../src/duckdb"
import { LocalEngine, buildHelperEnv } from "../src/local-engine"
import { pack, unpack } from "../src/local-engine-codec"
import { QUERY_TIMEOUT_ENV } from "../src/query-timeout"
import type { Connector } from "../src/types"

const FOREVER = {
  sqlite: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c",
  duckdb: "SELECT count(*) AS n FROM range(100000000000) a, range(1000) b",
}
/** Takes a measurable fraction of a second, finishes on its own. */
const MEDIUM = {
  sqlite: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT count(*) AS n FROM c",
  duckdb: "SELECT count(*) AS n FROM range(2000000000)",
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-test-"))
const open: Connector[] = []
const savedEnv = process.env[QUERY_TIMEOUT_ENV]
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => {})
  if (savedEnv === undefined) delete process.env[QUERY_TIMEOUT_ENV]
  else process.env[QUERY_TIMEOUT_ENV] = savedEnv
})

function helperPids(): number[] {
  const out = spawnSync("pgrep", ["-f", "altimate-local-engine"]).stdout.toString().trim()
  return out ? out.split("\n").map(Number) : []
}

async function make(engine: "sqlite" | "duckdb", config: Record<string, unknown> = {}): Promise<Connector> {
  const c =
    engine === "sqlite"
      ? await connectSqlite({ type: "sqlite", path: ":memory:", ...config })
      : await connectDuckdb({ type: "duckdb", path: ":memory:", ...config })
  await c.connect()
  open.push(c)
  return c
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: any }> {
  const t = performance.now()
  try {
    const value = await fn()
    return { ms: performance.now() - t, value }
  } catch (error) {
    return { ms: performance.now() - t, error }
  }
}

describe.each(["sqlite", "duckdb"] as const)("%s query deadline", (engine) => {
  test("an expensive query stops within the deadline and reports QUERY_TIMEOUT", async () => {
    const c = await make(engine)
    const r = await timed(() => c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 700 }))
    expect(r.value).toBeUndefined()
    expect(r.error?.code).toBe("QUERY_TIMEOUT")
    expect(r.error?.message).toContain("QUERY_TIMEOUT")
    expect(r.error?.message).toContain(engine === "sqlite" ? "SQLite" : "DuckDB")
    expect(r.error?.message).toContain("700ms")
    expect(r.ms).toBeGreaterThanOrEqual(650)
    expect(r.ms).toBeLessThan(3000)
  })

  test("the next query on the same connection succeeds and nothing keeps running", async () => {
    const before = helperPids().length
    const c = await make(engine)
    await c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 500 }).catch(() => {})
    const after = await c.execute("SELECT 41 + 1 AS answer")
    expect(Number(after.rows[0]![0])).toBe(42)
    // exactly one live helper for this connection: the timed-out one is gone
    expect(helperPids().length).toBe(before + 1)
    await c.close()
    await Bun.sleep(100)
    expect(helperPids().length).toBe(before)
  })

  test("a timeout rejects the caller's stale queued statement with state loss and accepts fresh work", async () => {
    const c = await make(engine)
    const slow = c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 600 })
    const queued = c.execute("SELECT 7 AS seven", 10, undefined, { queryTimeoutMs: 5000 })
    const results = await Promise.allSettled([slow, queued])
    expect(results[0].status).toBe("rejected")
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    expect(results[1].status).toBe("rejected")
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect(Number((await c.execute("SELECT 7 AS seven")).rows[0]![0])).toBe(7)
  })

  test("a timeout rejects every queued write even without an open transaction", async () => {
    const c = await make(engine, { path: path.join(tmp, `${engine}-queue-${crypto.randomUUID()}.db`), create: true })
    await c.execute("CREATE TABLE sentinel(value INTEGER)")
    await c.execute("CREATE TEMP TABLE session_values(value INTEGER)")
    const slow = c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 100 }).catch((error) => error)
    const writes = [1, 2].map((value) => c.execute(`INSERT INTO sentinel VALUES (${value})`).catch((error) => error))
    expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    for (const write of writes) expect(await write).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect((await c.execute("SELECT value FROM sentinel")).rows).toEqual([])
    await expect(c.execute("SELECT * FROM session_values")).rejects.toThrow()
    await c.execute("INSERT INTO sentinel VALUES (3)")
    expect((await c.execute("SELECT value FROM sentinel")).rows).toEqual([[3]])
  })

  test("queue wait does not count against the deadline", async () => {
    const c = await make(engine)
    const first = c.execute(MEDIUM[engine], 10, undefined, { queryTimeoutMs: 0 })
    // deadline shorter than the first query's runtime: only execution time counts
    const second = c.execute("SELECT 1 AS one", 10, undefined, { queryTimeoutMs: 150 })
    const [a, b] = await Promise.all([first, second])
    expect(Number(a.rows[0]![0])).toBeGreaterThan(0)
    expect(Number(b.rows[0]![0])).toBe(1)
  })

  test("connection query_timeout_ms applies, and the call option overrides it", async () => {
    const c = await make(engine, { query_timeout_ms: 400 })
    const hit = await timed(() => c.execute(FOREVER[engine]))
    expect(hit.error?.code).toBe("QUERY_TIMEOUT")
    expect(hit.error?.message).toContain("400ms")
    expect(hit.ms).toBeLessThan(3000)
    // per-call 0 disables the connection's deadline
    const ok = await c.execute(MEDIUM[engine], 10, undefined, { queryTimeoutMs: 0 })
    expect(Number(ok.rows[0]![0])).toBeGreaterThan(0)
  })

  test("ALTIMATE_SQL_QUERY_TIMEOUT_MS applies; connection value 0 / null disables it", async () => {
    process.env[QUERY_TIMEOUT_ENV] = "100"
    const viaEnv = await make(engine)
    const hit = await timed(() => viaEnv.execute(MEDIUM[engine]))
    expect(hit.error?.code).toBe("QUERY_TIMEOUT")
    for (const disabled of [0, null]) {
      const c = await make(engine, { query_timeout_ms: disabled })
      const ok = await c.execute(MEDIUM[engine])
      expect(Number(ok.rows[0]![0])).toBeGreaterThan(0)
    }
  })

  test("a timed-out in-memory connection says its state was lost and starts empty", async () => {
    const c = await make(engine)
    await c.execute("CREATE TABLE keep(x INTEGER)")
    const r = await timed(() => c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 400 }))
    expect(r.error?.stateLost).toBe(true)
    expect(r.error?.message).toContain("in-memory database was emptied")
    await expect(c.execute("SELECT * FROM keep")).rejects.toThrow()
  })

  test("table state survives within the session and file data survives a timeout", async () => {
    const file = path.join(tmp, `${engine}-persist-${process.pid}.db`)
    const c = await make(engine, { path: file, create: true })
    await c.execute("CREATE TABLE kept(x INTEGER)")
    await c.execute("INSERT INTO kept VALUES (1), (2)")
    expect((await c.execute("SELECT count(*) AS n FROM kept")).rows[0]![0]).toEqual(engine === "duckdb" ? 2n : 2)
    const r = await timed(() => c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 500 }))
    expect(r.error?.code).toBe("QUERY_TIMEOUT")
    expect(r.error?.message).not.toContain("in-memory")
    expect(Number((await c.execute("SELECT count(*) AS n FROM kept")).rows[0]![0])).toBe(2)
  })

  test("a read-only store times out, recovers, and still rejects writes", async () => {
    const file = path.join(tmp, `${engine}-ro-${process.pid}.db`)
    const writer = await make(engine, { path: file, create: true })
    await writer.execute("CREATE TABLE t(x INTEGER)")
    await writer.execute("INSERT INTO t VALUES (1)")
    await writer.close()
    open.pop()

    const ro = await make(engine, { path: file, readonly: true })
    const r = await timed(() => ro.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 500 }))
    expect(r.error?.code).toBe("QUERY_TIMEOUT")
    expect(Number((await ro.execute("SELECT count(*) AS n FROM t")).rows[0]![0])).toBe(1)
    await expect(ro.execute("INSERT INTO t VALUES (2)")).rejects.toThrow()
  })

  test("killing the helper on timeout releases the store for another connection", async () => {
    const file = path.join(tmp, `${engine}-lock-${process.pid}.db`)
    const c = await make(engine, { path: file, create: true })
    await c.execute("CREATE TABLE t(x INTEGER)")
    const r = await timed(() => c.execute(FOREVER[engine], 10, undefined, { queryTimeoutMs: 500 }))
    expect(r.error?.code).toBe("QUERY_TIMEOUT")
    // c has not yet reopened (lazy), so a second read-write connection can open the file
    const other = await make(engine, { path: file })
    expect(Number((await other.execute("SELECT count(*) AS n FROM t")).rows[0]![0])).toBe(0)
  })

  test("the deadline timer is cleared when a query finishes", async () => {
    const c = await make(engine)
    for (let i = 0; i < 3; i++) await c.execute("SELECT 1", 10, undefined, { queryTimeoutMs: 300 })
    await Bun.sleep(450) // would have killed the session if a timer leaked
    expect(Number((await c.execute("SELECT 5 AS five")).rows[0]![0])).toBe(5)
  })
})

describe("sqlite session restart disclosure", () => {
  test.each(["BEGIN", "/* transaction */ SAVEPOINT pending_write"])(
    "rejects every queued write when the timed-out caller loses an open transaction (%s)",
    async (begin) => {
      const c = await make("sqlite", { path: path.join(tmp, `sqlite-transaction-${crypto.randomUUID()}.db`), create: true })
      await c.execute("CREATE TABLE sentinel(value INTEGER)")
      await c.execute(begin)
      await c.execute("INSERT INTO sentinel VALUES (1)")
      const slow = c.execute(FOREVER.sqlite, 10, undefined, { queryTimeoutMs: 100 }).catch((error) => error)
      const writes = [2, 3].map((value) => c.execute(`INSERT INTO sentinel VALUES (${value})`).catch((error) => error))
      expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
      for (const write of writes) {
        expect(await write).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
      }
      // Neither the rolled-back write nor either queued write may survive in autocommit.
      expect((await c.execute("SELECT value FROM sentinel")).rows).toEqual([])
      await c.execute("INSERT INTO sentinel VALUES (4)")
      expect((await c.execute("SELECT value FROM sentinel")).rows).toEqual([[4]])
    },
  )

  test.each(["COMMIT", "ROLLBACK"])("rejects the timeout caller's stale queued statements even after %s", async (end) => {
    const c = await make("sqlite")
    await c.execute("BEGIN")
    await c.execute(end)
    const slow = c.execute(FOREVER.sqlite, 10, undefined, { queryTimeoutMs: 100 }).catch((error) => error)
    const queued = c.execute("SELECT 7 AS seven").catch((error) => error)
    expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    expect(await queued).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect((await c.execute("SELECT 7 AS seven")).rows).toEqual([[7]])
  })

  test("rejects stale queued statements after SQLite implicitly rolls back a failed statement", async () => {
    const c = await make("sqlite")
    await c.execute("CREATE TABLE unique_values(value INTEGER UNIQUE)")
    await c.execute("INSERT INTO unique_values VALUES (1)")
    await c.execute("BEGIN")
    await expect(c.execute("INSERT OR ROLLBACK INTO unique_values VALUES (1)")).rejects.toThrow()
    const slow = c.execute(FOREVER.sqlite, 10, undefined, { queryTimeoutMs: 100 }).catch((error) => error)
    const queued = c.execute("SELECT 7 AS seven").catch((error) => error)
    expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    expect(await queued).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect((await c.execute("SELECT 7 AS seven")).rows).toEqual([[7]])
  })

  test.each([
    { name: "next call", queued: false },
    { name: "already queued", queued: true },
  ])("reports a SQLite engine peer's lost session once after a timeout ($name)", async ({ queued }) => {
    const file = path.join(tmp, `sqlite-peer-${crypto.randomUUID()}.db`)
    const engine = new LocalEngine({ engine: "sqlite", label: "SQLite", storePath: file })
    try {
      await engine.open({ path: file, readwrite: true, create: true })
      await engine.call("run", { sql: "CREATE TABLE sentinel(value INTEGER)", connectionId: 2 })
      const slow = engine.call("all", { sql: FOREVER.sqlite, connectionId: 1 }, 100).catch((error) => error)
      const write = () => engine.call("run", { sql: "INSERT INTO sentinel VALUES (1)", connectionId: 2 }).catch((error) => error)
      const peer = queued ? write() : undefined
      expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
      expect(await (peer ?? write())).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
      expect(await engine.call("all", { sql: "SELECT value FROM sentinel", connectionId: 2 })).toEqual([])
      expect(await engine.call("all", { sql: "SELECT 42 AS answer", connectionId: 1 })).toEqual([{ answer: 42 }])
    } finally {
      await engine.close()
    }
  })

  test("rejects every statement a SQLite engine peer queued before the session restart", async () => {
    const file = path.join(tmp, `sqlite-peer-queue-${crypto.randomUUID()}.db`)
    const engine = new LocalEngine({ engine: "sqlite", label: "SQLite", storePath: file })
    try {
      await engine.open({ path: file, readwrite: true, create: true })
      await engine.call("run", { sql: "CREATE TABLE sentinel(value INTEGER)", connectionId: 2 })
      const slow = engine.call("all", { sql: FOREVER.sqlite, connectionId: 1 }, 100).catch((error) => error)
      const begin = engine.call("run", { sql: "BEGIN", connectionId: 2 }).catch((error) => error)
      const write = engine.call("run", { sql: "INSERT INTO sentinel VALUES (1)", connectionId: 2 }).catch((error) => error)
      expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
      expect(await begin).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
      expect(await write).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
      expect(await engine.call("all", { sql: "SELECT value FROM sentinel", connectionId: 2 })).toEqual([])
    } finally {
      await engine.close()
    }
  })
})

describe("duckdb concurrent stores", () => {
  test.each([
    { name: "separate statement", batch: false },
    { name: "within batch", batch: true },
  ])("rejects queued writes after its own timeout loses a DuckDB transaction ($name)", async ({ batch }) => {
    const c = await make("duckdb", { path: path.join(tmp, `duckdb-transaction-${crypto.randomUUID()}.db`), create: true })
    await c.execute("CREATE TABLE sentinel(value INTEGER)")
    // Transaction batches with quoted text and comments follow the same restart rule.
    const begin = "SELECT 'λ; BEGIN'; /* outer /* nested */ comment */ START TRANSACTION"
    if (!batch) await c.execute(begin, undefined, undefined, { noLimit: true })
    const slow = c.execute(batch ? `${begin}; ${FOREVER.duckdb}` : FOREVER.duckdb, 10, undefined, { queryTimeoutMs: 100 })
      .catch((error) => error)
    const writes = [1, 2].map((value) => c.execute(`INSERT INTO sentinel VALUES (${value})`).catch((error) => error))
    expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    for (const write of writes) expect(await write).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect((await c.execute("SELECT value FROM sentinel")).rows).toEqual([])
  })

  test.each(["COMMIT", "ROLLBACK"])("rejects DuckDB's timeout caller stale queue even after %s", async (end) => {
    const c = await make("duckdb")
    await c.execute("BEGIN")
    await c.execute(end)
    const slow = c.execute(`SELECT 'λ; BEGIN', $$START TRANSACTION;$$; ${FOREVER.duckdb}`, 10, undefined, { queryTimeoutMs: 100 })
      .catch((error) => error)
    const queued = c.execute("SELECT 7 AS seven").catch((error) => error)
    expect(await slow).toMatchObject({ code: "QUERY_TIMEOUT", stateLost: true })
    expect(await queued).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
    expect((await c.execute("SELECT 7 AS seven")).rows).toEqual([[7]])
  })

  test("two read-only connections share one store, each with its own deadline", async () => {
    const file = path.join(tmp, `shared-${process.pid}.duckdb`)
    const w = await make("duckdb", { path: file, create: true })
    await w.execute("CREATE TABLE t AS SELECT 1 AS x")
    await w.close()
    open.pop()
    const a = await make("duckdb", { path: file, readonly: true })
    const b = await make("duckdb", { path: file, readonly: true })
    // Both native sessions share a helper. Killing it must disclose the peer's
    // lost session before allowing another statement against the reopened store.
    const killed = await timed(() => a.execute(FOREVER.duckdb, 10, undefined, { queryTimeoutMs: 400 }))
    expect(killed.error?.code).toBe("QUERY_TIMEOUT")
    await expect(b.execute("SELECT count(*) AS n FROM t")).rejects.toMatchObject({ stateLost: true })
    expect(Number((await b.execute("SELECT count(*) AS n FROM t")).rows[0]![0])).toBe(1)
  })
})

describe("helper process", () => {
  test("values DuckDB returns cross the process boundary intact", async () => {
    const c = await make("duckdb")
    const r = await c.execute(
      "SELECT 12345678901234567890::HUGEINT AS big, TIMESTAMP '2024-05-06 07:08:09' AS ts, DATE '2024-01-02' AS d, " +
        "[1,2,3] AS arr, {'k': 'v'} AS st, 1.25::DOUBLE AS f, NULL AS nul, 'héllo' AS s, 'ab'::BLOB AS bl",
    )
    const row = Object.fromEntries(r.columns.map((col, i) => [col, r.rows[0]![i]]))
    expect(row.big).toBe(12345678901234567890n)
    expect(row.ts).toBeInstanceOf(Date)
    expect((row.ts as Date).toISOString()).toBe("2024-05-06T07:08:09.000Z")
    expect(row.d).toBeInstanceOf(Date)
    expect((row.arr as any[]).map(Number)).toEqual([1, 2, 3])
    expect(row.st).toEqual({ k: "v" })
    expect(row.f).toBe(1.25)
    expect(row.nul).toBeNull()
    expect(row.s).toBe("héllo")
    expect(row.bl).toBeInstanceOf(Uint8Array)
  })

  test("codec round-trips the types it tags", () => {
    const value = {
      b: 10n ** 20n,
      d: new Date("2024-01-01T00:00:00Z"),
      bytes: new Uint8Array([1, 2, 255]),
      nan: NaN,
      inf: Infinity,
      nested: [{ $t: "user-key", x: 1 }],
    }
    const back = unpack(JSON.parse(JSON.stringify(pack(value))))
    expect(back.b).toBe(10n ** 20n)
    expect(back.d.toISOString()).toBe("2024-01-01T00:00:00.000Z")
    expect(Array.from(back.bytes)).toEqual([1, 2, 255])
    expect(Number.isNaN(back.nan)).toBe(true)
    expect(back.inf).toBe(Infinity)
    expect(back.nested).toEqual([{ $t: "user-key", x: 1 }])
  })

  test("an open callback that fires synchronously still settles", async () => {
    const engine = new LocalEngine({ engine: "duckdb", label: "DuckDB", storePath: "/tmp/x.duckdb" })
    const modulePath = path.join(import.meta.dir, "fixtures", "fake-duckdb-sync.mjs")
    await engine.open({ path: "/tmp/x.duckdb", modulePath }, 5000)
    const rows = await engine.call("all", { sql: "SELECT 1" }, 5000)
    expect(rows[0].ok).toBe(1)
    await engine.close()
  })

  test("a synchronous open error is reported, not swallowed", async () => {
    const engine = new LocalEngine({ engine: "duckdb", label: "DuckDB", storePath: "/tmp/corrupt.duckdb" })
    const modulePath = path.join(import.meta.dir, "fixtures", "fake-duckdb-sync.mjs")
    await expect(engine.open({ path: "/tmp/corrupt.duckdb", modulePath }, 5000)).rejects.toThrow("catalog is corrupt")
    await engine.close()
  })

  test("a helper that dies mid-session is replaced on the next call", async () => {
    const c = await make("sqlite")
    await c.execute("SELECT 1")
    for (const pid of helperPids()) {
      // only helpers whose parent is this test process
      const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]).stdout.toString().trim()
      if (Number(ppid) === process.pid) process.kill(pid, "SIGKILL")
    }
    await Bun.sleep(100)
    // the crash may surface once or the call may transparently reopen; the connection must work again after
    await c.execute("SELECT 1").catch(() => {})
    expect(Number((await c.execute("SELECT 2 AS two")).rows[0]![0])).toBe(2)
  })

  test("a helper crash rejects every queued peer call before accepting fresh work", async () => {
    const engine = new LocalEngine({
      engine: "sqlite", label: "SQLite", storePath: ":memory:",
      childSource: `let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.payload.sql === "crash") process.exit(1);
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: [{ value: 1 }] }) + "\\n");
  }
}`,
    })
    try {
      await engine.open({ path: ":memory:" })
      // An idle connector also needs one disclosure even without prior SQL.
      engine.registerSession(3)
      await engine.call("all", { sql: "ready", connectionId: 2 })
      const crash = engine.call("all", { sql: "crash", connectionId: 1 }).catch((error) => error)
      const queued = ["first", "second"].map((sql) => engine.call("all", { sql, connectionId: 2 }).catch((error) => error))
      expect((await crash).message).toContain("exited unexpectedly")
      for (const call of queued) expect(await call).toMatchObject({ code: "SESSION_STATE_LOST", stateLost: true })
      expect(await engine.call("all", { sql: "fresh", connectionId: 2 })).toEqual([{ value: 1 }])
      await expect(engine.call("all", { sql: "first", connectionId: 3 })).rejects.toMatchObject({
        code: "SESSION_STATE_LOST", stateLost: true,
      })
      expect(await engine.call("all", { sql: "fresh", connectionId: 3 })).toEqual([{ value: 1 }])
    } finally {
      await engine.close()
    }
  })

  test("a helper orphaned by a killed parent ends itself", async () => {
    const script = path.join(tmp, "orphan-parent.ts")
    fs.writeFileSync(
      script,
      `import { connect } from ${JSON.stringify(path.join(import.meta.dir, "../src/sqlite"))}
const c = await connect({ type: "sqlite", path: ":memory:" })
await c.connect()
console.log("READY")
c.execute(${JSON.stringify(FOREVER.sqlite)}, 1, undefined, { queryTimeoutMs: 0 }).catch(() => {})
setInterval(() => {}, 1000)
`,
    )
    const parent = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "ignore" })
    try {
      const reader = parent.stdout.getReader()
      await reader.read() // READY
      await Bun.sleep(600)
      const childPid = Number(
        spawnSync("pgrep", ["-P", String(parent.pid)]).stdout.toString().trim().split("\n")[0],
      )
      expect(childPid).toBeGreaterThan(0)
      parent.kill("SIGKILL")
      await parent.exited
      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        await Bun.sleep(100)
        alive = spawnSync("ps", ["-p", String(childPid)]).status === 0
      }
      expect(alive).toBe(false)
    } finally {
      // An unavailable pgrep/ps must not leave the probe's expensive query running.
      parent.kill("SIGKILL")
      await parent.exited
    }
  })
})

describe("helper isolation", () => {
  test("a project bunfig.toml preload never runs in the helper, and relative store paths still resolve", async () => {
    const project = fs.mkdtempSync(path.join(tmp, "project-"))
    const sentinel = path.join(project, "PRELOAD_RAN")
    fs.writeFileSync(path.join(project, "pre.ts"), `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")\n`)
    fs.writeFileSync(path.join(project, "bunfig.toml"), `preload = ["./pre.ts"]\n`)
    // Control: the same executable started in that directory does run the preload.
    spawnSync(process.execPath, ["-e", "1"], { cwd: project })
    expect(fs.existsSync(sentinel)).toBe(true)
    fs.rmSync(sentinel)

    const seed = new (await import("bun:sqlite")).Database(path.join(project, "rel.db"))
    seed.exec("CREATE TABLE t(x); INSERT INTO t VALUES (7)")
    seed.close()

    const cwd = process.cwd()
    process.chdir(project)
    try {
      const c = await connectSqlite({ type: "sqlite", path: "rel.db", readonly: true })
      await c.connect()
      open.push(c)
      const r = await c.execute("SELECT x FROM t")
      expect(r.rows).toEqual([[7]])
    } finally {
      process.chdir(cwd)
    }
    expect(fs.existsSync(sentinel)).toBe(false)
  })

  test("the helper environment filters provider credentials and preserves the caller's HOME", () => {
    const env = buildHelperEnv("/private/dir", {
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      AWS_SECRET_ACCESS_KEY: "s",
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      BUN_CONFIG_VERBOSE_FETCH: "1",
    })
    expect(Object.keys(env).sort()).toEqual(
      [
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_SECRET_ACCESS_KEY",
        "AZURE_CONFIG_DIR",
        "BUN_BE_BUN",
        "CLOUDSDK_CONFIG",
        "HOME",
        "LANG",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
      ].sort(),
    )
    expect(env.HOME).toBe("/home/me")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.BUN_BE_BUN).toBe("1")
  })

  test("ordinary helpers find the caller's default Azure CLI directory and preserve the caller's home", () => {
    for (const parent of [{ HOME: "/home/me" }, { USERPROFILE: "/home/me" }]) {
      const env = buildHelperEnv("/private/dir", parent)
      expect(env.AZURE_CONFIG_DIR).toBe(path.join("/home/me", ".azure"))
      expect(env.HOME).toBe(parent.HOME)
      expect(env.USERPROFILE).toBe(parent.USERPROFILE)
    }
  })

  test("ordinary helpers preserve the caller's explicit Azure CLI directory and home", () => {
    const env = buildHelperEnv("/private/dir", { HOME: "/home/me", AZURE_CONFIG_DIR: "/custom/azure" })
    expect(env.AZURE_CONFIG_DIR).toBe("/custom/azure")
    expect(env.HOME).toBe("/home/me")
    expect(env.USERPROFILE).toBeUndefined()
  })

  test("ordinary helpers find the caller's default gcloud directory and preserve the caller's home", () => {
    for (const parent of [{ HOME: "/home/me" }, { USERPROFILE: "/home/me" }]) {
      const env = buildHelperEnv("/private/dir", parent)
      expect(env.CLOUDSDK_CONFIG).toBe(path.join("/home/me", ".config", "gcloud"))
      expect(env.HOME).toBe(parent.HOME)
      expect(env.USERPROFILE).toBe(parent.USERPROFILE)
      for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
        expect(env[name]).toBeUndefined()
      }
    }
  })

  for (const scenario of [
    {
      name: "ordinary Windows helpers find the default gcloud directory under APPDATA",
      platform: "win32",
      appData: "C:\\Users\\me\\AppData\\Roaming",
      expected: "C:\\Users\\me\\AppData\\Roaming\\gcloud",
    },
    {
      name: "ordinary Windows helpers fall back to the home gcloud directory when APPDATA is undefined",
      platform: "win32",
      appData: undefined,
      expected: path.join("/home/me", ".config", "gcloud"),
    },
    {
      name: "ordinary Unix helpers keep the home gcloud directory when APPDATA is present",
      platform: "linux",
      appData: "C:\\Users\\me\\AppData\\Roaming",
      expected: path.join("/home/me", ".config", "gcloud"),
    },
  ]) {
    test(scenario.name, () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
      Object.defineProperty(process, "platform", { value: scenario.platform })
      try {
        const env = buildHelperEnv("/private/dir", { HOME: "/home/me", APPDATA: scenario.appData })
        expect(env.CLOUDSDK_CONFIG).toBe(scenario.expected)
        expect(env.HOME).toBe("/home/me")
      } finally {
        Object.defineProperty(process, "platform", originalPlatform)
      }
    })
  }

  test("ordinary helpers preserve explicit gcloud, Google ADC, home and XDG locations", () => {
    const parent = {
      HOME: "/home/me",
      USERPROFILE: "/profile/me",
      XDG_CONFIG_HOME: "/custom/config",
      XDG_DATA_HOME: "/custom/data",
      XDG_CACHE_HOME: "/custom/cache",
      XDG_STATE_HOME: "/custom/state",
      CLOUDSDK_CONFIG: "/custom/gcloud",
      GOOGLE_APPLICATION_CREDENTIALS: "/custom/adc.json",
    }
    const env = buildHelperEnv("/private/dir", parent)
    expect(env).toMatchObject(parent)
    expect(env.AWS_CONFIG_FILE).toBe(path.join(parent.HOME, ".aws", "config"))
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe(path.join(parent.HOME, ".aws", "credentials"))
  })

  test("scratch helpers omit default and explicit Azure and gcloud directories and keep private home and XDG", () => {
    for (const config of [undefined, "/custom/config"]) {
      const env = buildHelperEnv("/private/dir", {
        HOME: "/home/me",
        USERPROFILE: "/profile/me",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_CACHE_HOME: "/custom/cache",
        XDG_STATE_HOME: "/custom/state",
        AZURE_CONFIG_DIR: config,
        CLOUDSDK_CONFIG: config,
      }, true)
      expect(env.AZURE_CONFIG_DIR).toBeUndefined()
      expect(env.CLOUDSDK_CONFIG).toBeUndefined()
      expect(env.HOME).toBe("/private/dir")
      expect(env.USERPROFILE).toBe("/private/dir")
      for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
        expect(env[name]).toBe("/private/dir")
      }
      expect(env.BUN_BE_BUN).toBe("1")
    }
  })

  for (const scratch of [false, true]) {
    test.each([undefined, "/custom/gcloud"])(`cloud credential directories survive helper startup and respawn (scratch=${scratch}, gcloud=%s)`, async (gcloudConfig) => {
      const childSource = String.raw`
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (req.payload.sql === "hang") continue;
    const result = req.op === "all" ? {
      azureConfig: process.env.AZURE_CONFIG_DIR,
      gcloudConfig: process.env.CLOUDSDK_CONFIG,
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      tmpdir: process.env.TMPDIR,
      bunBeBun: process.env.BUN_BE_BUN,
    } : null;
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
  }
}
`
      const parent = {
        HOME: "/home/me",
        USERPROFILE: "/profile/me",
        XDG_CONFIG_HOME: "/custom/config",
        AZURE_CONFIG_DIR: "/custom/azure",
        CLOUDSDK_CONFIG: gcloudConfig,
      }
      const saved = Object.fromEntries(Object.keys(parent).map((name) => [name, process.env[name]]))
      for (const [name, value] of Object.entries(parent)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      const engine = new LocalEngine({ engine: "duckdb", label: "Fake", storePath: ":memory:", childSource })
      try {
        await engine.open({ path: ":memory:", sandboxDirectory: scratch ? tmp : undefined }, 5000)
        for (const respawn of [false, true]) {
          if (respawn) await expect(engine.call("all", { sql: "hang" }, 100)).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })
          const env = await engine.call("all", { sql: "env" }, 5000)
          expect(env.azureConfig).toBe(scratch ? undefined : "/custom/azure")
          expect(env.gcloudConfig).toBe(scratch ? undefined : gcloudConfig ?? path.join(parent.HOME, ".config", "gcloud"))
          expect(path.basename(env.tmpdir)).toStartWith("altimate-local-engine-")
          expect(env.home).toBe(scratch ? env.tmpdir : parent.HOME)
          expect(env.userProfile).toBe(scratch ? env.tmpdir : parent.USERPROFILE)
          expect(env.xdgConfig).toBe(scratch ? env.tmpdir : parent.XDG_CONFIG_HOME)
          expect(env.bunBeBun).toBe("1")
        }
      } finally {
        await engine.close()
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    })
  }

  test("the helper directory is private, owned by us, and removed on exit", async () => {
    const script = path.join(tmp, "dir-probe.ts")
    fs.writeFileSync(
      script,
      `import { connect } from ${JSON.stringify(path.join(import.meta.dir, "../src/sqlite"))}
import * as fs from "fs"
const c = await connect({ type: "sqlite", path: ":memory:" })
await c.connect()
const dirs = fs.readdirSync(require("os").tmpdir()).filter((n) => n.startsWith("altimate-local-engine-")).map((n) => require("path").join(require("os").tmpdir(), n))
const mine = dirs.filter((d) => fs.existsSync(d + "/bunfig.toml"))
console.log(JSON.stringify(mine.map((d) => ({ d, mode: fs.statSync(d).mode & 0o777, uid: fs.statSync(d).uid, me: process.getuid() }))))
await c.close()
`,
    )
    const out = spawnSync(process.execPath, [script]).stdout.toString().trim().split("\n").pop()!
    const dirs = JSON.parse(out) as Array<{ d: string; mode: number; uid: number; me: number }>
    expect(dirs.length).toBeGreaterThan(0)
    for (const e of dirs.filter((x) => x.uid === x.me && x.mode === 0o700)) expect(e.d).toMatch(/altimate-local-engine-/)
    expect(dirs.some((x) => x.mode === 0o700 && x.uid === x.me)).toBe(true)
  })
})

describe("codec", () => {
  test("a column named __proto__ survives pack/unpack and a real round trip", async () => {
    expect(Object.keys(unpack(JSON.parse(JSON.stringify(pack(JSON.parse('{"__proto__":42,"normal":7}'))))))).toEqual(["__proto__", "normal"])
    // SQLite only: the duckdb node binding itself drops a `__proto__` column
    // before our code sees the row (verified with the binding alone).
    const c = await make("sqlite")
    const r = await c.execute('SELECT 42 AS "__proto__", 7 AS normal')
    expect(r.columns).toEqual(["__proto__", "normal"])
    expect(r.rows).toEqual([[42, 7]])
  })
})

describe("reopen keeps the open deadline", () => {
  // A helper that opens fine the first time and stalls on every later open.
  const STALLING_CHILD = String.raw`
const fs = require("fs");
let buf = "";
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n");
(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      const marker = req.payload && req.payload.path;
      if (req.op === "open") {
        if (fs.existsSync(marker)) continue; // stall: never answer
        fs.writeFileSync(marker, "1");
        reply({ id: req.id, ok: true, result: null });
      } else if (req.op === "all") {
        if (req.payload.sql === "hang") continue;
        reply({ id: req.id, ok: true, result: [{ ok: 1 }] });
      } else { reply({ id: req.id, ok: true, result: null }); }
    }
  }
})();
`
  test("a hung reopen after a kill fails within the open budget instead of blocking the queue", async () => {
    const marker = path.join(tmp, `stall-${Date.now()}`)
    const engine = new LocalEngine({ engine: "sqlite", label: "Fake", storePath: marker, childSource: STALLING_CHILD })
    await engine.open({ path: marker }, 800, () => new Error("OPEN_BUDGET_EXCEEDED"))
    const killed = await timed(() => engine.call("all", { sql: "hang" }, 300))
    expect(killed.error?.code).toBe("QUERY_TIMEOUT")
    const reopened = await timed(() => engine.call("all", { sql: "SELECT 1" }, 5000))
    expect(reopened.error?.message).toBe("OPEN_BUDGET_EXCEEDED")
    expect(reopened.ms).toBeGreaterThanOrEqual(700)
    expect(reopened.ms).toBeLessThan(2500)
    await engine.close()
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { connect } from "../../../drivers/src/duckdb"
import { holdWriteLock } from "./duckdb-lock-helper"

// These tests open a real DuckDB store on disk. They are pointless against a
// mock: every bug they cover lives in the native open callback or in the
// driver's own deadline, neither of which a fake exposes.
//
// They need their own `bun test` process. Four files in this directory install
// a top-level `mock.module("@altimateai/drivers/duckdb", …)`, and Bun evaluates
// every test file's top level before running any test, so in a whole-directory
// run the driver is already replaced by a fake no matter how the files sort and
// regardless of which specifier this file imports. `mock.restore()` does not
// undo a module mock. Hence the gate below, and the dedicated CI step.
//
// The gate is opt-IN so the shared suite stays green, but when it is on a
// missing or faked driver is a hard failure, never a skip. A whole e2e file
// that quietly reports success while skipping is the same class of defect this
// PR exists to fix.
const RUN = process.env["ALTIMATE_DUCKDB_E2E"] === "1"
const ddbTest = RUN ? test : test.skip

let dir = ""
let storePath = ""
  // The lock tests use their own store, which THIS process never opens
  // successfully. That is not tidiness: DuckDB's lock is per-process, and this
  // process holds a write lock on `storePath` for as long as its own handle
  // lives — the driver's close() has to fall back to a timer in Bun because the
  // native close callback does not always fire, so "closed" is not instantaneous.
  // Sharing one store would make these tests race that fallback. The lock holder
  // creates `lockedPath` itself, so the only writer is the foreign process.
  let lockedPath = ""

// A liveness probe whose correct answer cannot be produced without a working
// engine actually computing it.
//
// Every other assertion in this file can be satisfied by a connection that is
// not really there. A row count can legitimately be zero, and an absent error
// string can mean the error was swallowed rather than that none occurred — which
// is live on `main` today: `register.ts`'s `sql.execute` catches everything and
// returns `{ row_count: 0, error }` instead of throwing, and `formatResult`
// renders "(0 rows)" without ever reading `error`. So "(0 rows)" and "the driver
// is dead" are indistinguishable to anything downstream.
//
// `md5()` is not. A dead connection cannot return one row, and a live one cannot
// return the right digest without hashing the input. This is not a hypothetical
// safeguard: during the driver A/B for this PR, two binaries looked clean across
// transcripts, traces and 563 lines of debug output — zero ENOENT, zero fault
// lines — while failing to load the driver at all. This probe is what caught it.
//
// The digest is computed independently (`hashlib.md5`, cross-checked against
// `md5(1)`), never by asking DuckDB — deriving it from the system under test
// would make the assertion circular and prove nothing.
const LIVENESS_NONCE = "altimate-duckdb-open-e2e-liveness-2026-08-30"
const LIVENESS_MD5 = "517f58256b5ba4642643b3e884d91d15"

/** Run `fn` and return the error message it threw, or "" if it succeeded. */
async function messageFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ""
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

describe("DuckDB driver: opening a real store", () => {
  beforeAll(async () => {
    if (!RUN) return
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-open-"))
    storePath = path.join(dir, "warehouse.duckdb")
    lockedPath = path.join(dir, "locked.duckdb")
    const c = await connect({ type: "duckdb", path: storePath })
    await c.connect()
    await c.execute("CREATE TABLE t AS SELECT 1 AS a, 'x' AS b")
    const probe = await c.execute("SELECT count(*) AS n FROM t")
    const liveness = await c.execute(`SELECT md5('${LIVENESS_NONCE}') AS h`)
    await c.close()
    // Refuse to run against anything but the real thing. A fake driver would
    // pass most assertions below while proving nothing. The digest is the half
    // of this gate that a stub cannot satisfy by returning a plausible shape.
    if (Number(probe.rows?.[0]?.[0]) !== 1 || String(liveness.rows?.[0]?.[0]) !== LIVENESS_MD5) {
      throw new Error(
        "ALTIMATE_DUCKDB_E2E=1 but the DuckDB driver is not the real one — " +
          "either the native binding is missing, or another test file has replaced " +
          "the module with a mock. Run this file in its own `bun test` process.",
      )
    }
  })

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  ddbTest("opens the same store repeatedly without flaking", async () => {
    // The failure this replaces was reported as 7 of 7 calls failing, so a
    // single green open proves nothing. Repeat enough to catch an
    // intermittent regression.
    for (let i = 0; i < 20; i++) {
      const c = await connect({ type: "duckdb", path: storePath })
      await c.connect()
      const r = await c.execute("SELECT count(*) AS n FROM t")
      expect(Number(r.rows[0][0])).toBe(1)
      await c.close()
    }
  })

  ddbTest("the opened store is a live engine, not a connection that merely looks open", async () => {
    // The assertion above this one passes on a dead connection: `(0 rows)` and
    // "the driver never loaded" are the same observation. This one cannot.
    const c = await connect({ type: "duckdb", path: storePath })
    // close() in a finally, not after the assertions: this opens `storePath`
    // read-write, and DuckDB's lock is per-process, so a handle leaked by a
    // failing assertion would make every later test in this file fail with a
    // lock conflict instead of the real cause.
    let rows: unknown[][]
    try {
      await c.connect()
      rows = (await c.execute(`SELECT md5('${LIVENESS_NONCE}') AS h`)).rows
    } finally {
      await c.close()
    }
    // Exactly one row: a swallowed failure surfaces as zero rows, and zero rows
    // is the shape that reads as success everywhere downstream.
    expect(rows.length).toBe(1)
    // And the right answer, which requires actually computing it.
    expect(String(rows[0][0])).toBe(LIVENESS_MD5)
  })

  ddbTest("opens the same store from many connectors at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const c = await connect({ type: "duckdb", path: storePath })
        await c.connect()
        const r = await c.execute("SELECT count(*) AS n FROM t")
        await c.close()
        return Number(r.rows[0][0])
      }),
    )
    expect(results).toEqual(Array(8).fill(1))
  })

  ddbTest("honours config.readonly by actually opening READ_ONLY", async () => {
    const c = await connect({ type: "duckdb", path: storePath, readonly: true })
    await c.connect()
    // Reads work.
    const r = await c.execute("SELECT count(*) AS n FROM t")
    expect(Number(r.rows[0][0])).toBe(1)
    // Writes do not — which is what proves READ_ONLY reached DuckDB rather
    // than `readonly` being silently dropped, as it was before.
    expect(await messageFrom(() => c.execute("CREATE TABLE writeme (x INTEGER)"))).not.toBe("")
    await c.close()
  })

  ddbTest("a store that opens fine is not failed by the open deadline", async () => {
    // Same file, same process, two budgets. An unreachably small budget must
    // fail; the default must succeed. That is the whole mechanism behind the
    // field failure: the deadline fired, not the store.
    const tooShort = await connect({ type: "duckdb", path: storePath, open_timeout_ms: 1 })
    expect(await messageFrom(() => tooShort.connect())).toContain("did not finish opening within 1ms")

    const normal = await connect({ type: "duckdb", path: storePath })
    await normal.connect()
    const r = await normal.execute("SELECT count(*) AS n FROM t")
    expect(Number(r.rows[0][0])).toBe(1)
    await normal.close()
  })

  ddbTest("the open deadline names itself as a client-side deadline", async () => {
    const c = await connect({ type: "duckdb", path: storePath, open_timeout_ms: 1 })
    const message = await messageFrom(() => c.connect())
    // The old message was `Timed out opening DuckDB database "<path>"`, which
    // reads as "the store is broken" and sent investigators after the file.
    expect(message).toContain("not a fault in the store")
  })

  ddbTest("a deadline the connection set says so, so it is not read as a broken client", async () => {
    // The remedy differs by source, so the message has to name it. A budget the
    // connection chose is fixed by changing that connection; the default firing
    // says something about the machine instead.
    const c = await connect({ type: "duckdb", path: storePath, open_timeout_ms: 1 })
    const message = await messageFrom(() => c.connect())
    expect(message).toContain("deadline was set on this connection as open_timeout_ms=1")
    // It must NOT point at the env var, which does not override a per-connection
    // setting and so would not fix anything here.
    expect(message).not.toContain("ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS")
  })

  ddbTest("the open deadline is tunable by environment variable", async () => {
    const prev = process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
    process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = "1"
    try {
      const c = await connect({ type: "duckdb", path: storePath })
      const message = await messageFrom(() => c.connect())
      expect(message).toContain("did not finish opening within 1ms")
      // Sourced from the environment, not the connection, so the message points
      // at the knobs that would actually change it.
      expect(message).toContain("ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS")
      expect(message).not.toContain("deadline was set on this connection")
    } finally {
      if (prev === undefined) delete process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
      else process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = prev
    }
  })

  ddbTest("an unusable timeout value falls back to the default budget", async () => {
    for (const bad of [0, -1, Number.NaN, "abc"]) {
      const c = await connect({ type: "duckdb", path: storePath, open_timeout_ms: bad })
      await c.connect()
      await c.close()
    }
  })

  ddbTest("a budget larger than the timer's range is not silently turned into 1ms", async () => {
    // setTimeout clamps a delay past 2^31-1 down to about 1ms, which would turn
    // "wait essentially forever" into "fail immediately" — the exact inversion
    // this driver exists to prevent. The budget must be clamped before it
    // reaches the timer.
    const c = await connect({ type: "duckdb", path: storePath, open_timeout_ms: 1e12 })
    await c.connect()
    const r = await c.execute("SELECT count(*) AS n FROM t")
    expect(Number(r.rows[0][0])).toBe(1)
    await c.close()
  })

  ddbTest("an explicitly read-only open that hits a foreign lock reports it as a lock", async () => {
    // READ_ONLY does not rescue an existing cross-process write lock — measured,
    // and the reason this path exists at all. What matters is that the failure
    // stays *recognisable* as a lock: an explicit readonly open takes the
    // `wantReadOnly` branch, which correctly skips the read-only retry, and
    // before this fix that branch rethrew DuckDB's raw error, so every consumer
    // classified a plain lock collision as an unknown failure.
    const lock = await holdWriteLock(lockedPath, dir)
    try {
      const c = await connect({ type: "duckdb", path: lockedPath, readonly: true })
      const message = await messageFrom(() => c.connect())
      expect(message).toContain("is locked by another process")
      // DuckDB's own text survives: it names the PID holding the lock, which is
      // the only way to find the other process.
      expect(message.toLowerCase()).toContain("conflicting lock")
    } finally {
      await lock.release()
    }
  })

  ddbTest("a read-write open that hits a foreign lock also reports it as a lock", async () => {
    const lock = await holdWriteLock(lockedPath, dir)
    try {
      const c = await connect({ type: "duckdb", path: lockedPath })
      const message = await messageFrom(() => c.connect())
      expect(message).toContain("is locked by another process")
      expect(message.toLowerCase()).toContain("conflicting lock")
    } finally {
      await lock.release()
    }
  })

  ddbTest("the store is usable again once the foreign lock is released", async () => {
    // Guards the helper itself. If release() did not actually free the lock,
    // the two tests above would pass for the wrong reason and would poison
    // every test that runs after them.
    const lock = await holdWriteLock(lockedPath, dir)
    await lock.release()
    const c = await connect({ type: "duckdb", path: lockedPath })
    await c.connect()
    // `lock_probe` is the table the holder creates when it takes the lock, so
    // reading it proves both that the lock is gone and that the holder really
    // wrote through it rather than merely touching the file.
    const r = await c.execute("SELECT count(*) AS n FROM lock_probe")
    expect(Number(r.rows[0][0])).toBe(0)
    await c.close()
  })

  ddbTest("reports a lock conflict as a lock conflict, keeping DuckDB's detail", async () => {
    // The verbatim message DuckDB emits when another process holds the file.
    // It contains "lock" but never "locked", which is why the driver's old
    // `.includes("locked")` check never matched a real collision.
    const real =
      'IO Error: Could not set lock on file "/tmp/warehouse.duckdb": Conflicting lock is held in ' +
      "/usr/bin/node (PID 65001) by user someone. See also https://duckdb.org/docs/stable/connect/concurrency"
    expect(real.toLowerCase().includes("locked")).toBe(false)

    // Drive it through the driver by pointing at a directory, which fails the
    // open for an unrelated reason, to confirm non-lock errors pass through
    // untouched rather than being mislabelled as a lock.
    const c = await connect({ type: "duckdb", path: dir })
    const message = await messageFrom(() => c.connect())
    expect(message).not.toBe("")
    expect(message).not.toContain("is locked by another process")
    expect(message).not.toContain("did not finish opening")
  })
})

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
    const c = await connect({ type: "duckdb", path: storePath })
    await c.connect()
    await c.execute("CREATE TABLE t AS SELECT 1 AS a, 'x' AS b")
    const probe = await c.execute("SELECT count(*) AS n FROM t")
    await c.close()
    // Refuse to run against anything but the real thing. A fake driver would
    // pass most assertions below while proving nothing.
    if (Number(probe.rows?.[0]?.[0]) !== 1) {
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
    expect(message).toContain("ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS")
  })

  ddbTest("the open deadline is tunable by environment variable", async () => {
    const prev = process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
    process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = "1"
    try {
      const c = await connect({ type: "duckdb", path: storePath })
      expect(await messageFrom(() => c.connect())).toContain("did not finish opening within 1ms")
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
    const lock = await holdWriteLock(storePath, dir)
    try {
      const c = await connect({ type: "duckdb", path: storePath, readonly: true })
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
    const lock = await holdWriteLock(storePath, dir)
    try {
      const c = await connect({ type: "duckdb", path: storePath })
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
    const lock = await holdWriteLock(storePath, dir)
    await lock.release()
    const c = await connect({ type: "duckdb", path: storePath })
    await c.connect()
    const r = await c.execute("SELECT count(*) AS n FROM t")
    expect(Number(r.rows[0][0])).toBe(1)
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

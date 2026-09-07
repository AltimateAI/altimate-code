import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"
import { WarehouseTestTool } from "../../src/altimate/tools/warehouse-test"
import { holdWriteLock } from "./duckdb-lock-helper"
import { initTool } from "./tool-fixture"

// End-to-end coverage for the `warehouse_test` tool against a real DuckDB file
// on disk, through the same `Dispatcher.call("warehouse.test", …)` the tool
// itself makes. A mock connector would not have caught the bug this replaces —
// it lived in the native open path — so nothing here is faked.
//
// Needs its own `bun test` process, and refuses to run against a fake. See the
// long note in `duckdb-open-e2e.test.ts` for why.
const RUN = process.env["ALTIMATE_DUCKDB_E2E"] === "1"
const ddbTest = RUN ? test : test.skip

let dir = ""
let storePath = ""
// A store this process never opens — see the note in duckdb-open-e2e.test.ts.
// DuckDB's lock is per-process, so a store this process has open cannot be
// locked against it by anyone else.
let lockedPath = ""
// Captured so afterAll can put the environment back exactly as it found it.
// Unconditionally deleting would clear a value the surrounding process had set.
let prevTelemetryDisabled: string | undefined

async function warehouseTest(name: string) {
  return Dispatcher.call("warehouse.test", { name })
}

describe("warehouse.test against a real DuckDB store", () => {
  beforeAll(async () => {
    prevTelemetryDisabled = process.env["ALTIMATE_TELEMETRY_DISABLED"]
    process.env["ALTIMATE_TELEMETRY_DISABLED"] = "true"
    if (!RUN) return
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-test-"))
    storePath = path.join(dir, "warehouse.duckdb")
    lockedPath = path.join(dir, "locked.duckdb")
    Registry.reset()
    // `create: true`: this deliberately materializes a fresh scratch store for
    // the suite, which is exactly the case the store-existence guard exempts.
    Registry.setConfigs({ seed: { type: "duckdb", path: storePath, create: true } })
    const c = await Registry.get("seed")
    await c.execute("CREATE TABLE t AS SELECT 1 AS a")
    const probe = await c.execute("SELECT count(*) AS n FROM t")
    await Registry.closeAll()
    Registry.reset()
    // Refuse to run against anything but the real driver — see above.
    if (Number(probe.rows?.[0]?.[0]) !== 1) {
      throw new Error(
        "ALTIMATE_DUCKDB_E2E=1 but the DuckDB driver is not the real one — " +
          "either the native binding is missing, or another test file has replaced " +
          "the module with a mock. Run this file in its own `bun test` process.",
      )
    }
  })

  // Registry.reset() only clears the connector map — it is synchronous and
  // close() is not — so on its own it leaks the native DuckDB handle behind
  // every connector these tests create. closeAll() is what actually releases
  // them; without it the handles accumulate and the rmSync below cannot delete
  // the store on Windows.
  afterEach(async () => {
    await Registry.closeAll()
    Registry.reset()
  })

  afterAll(async () => {
    if (prevTelemetryDisabled === undefined) delete process.env["ALTIMATE_TELEMETRY_DISABLED"]
    else process.env["ALTIMATE_TELEMETRY_DISABLED"] = prevTelemetryDisabled
    await Registry.closeAll()
    Registry.reset()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  ddbTest("connects on every one of 10 consecutive fresh registries", async () => {
    // The failure this replaces was 7 of 7 calls failing, and a fix that is
    // merely usually right would recreate exactly that contamination. Each
    // iteration resets the registry so nothing is served from cache.
    for (let i = 0; i < 10; i++) {
      await Registry.closeAll()
      Registry.reset()
      Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
      const result = await warehouseTest("local")
      expect(result.connected).toBe(true)
      expect(result.error).toBeUndefined()
    }
  })

  ddbTest("reports a broken client as an infrastructure failure, not a failed connection", async () => {
    Registry.reset()
    // An unreachably small open budget stands in for any local fault that
    // stops the store opening. It is set through the environment, NOT on the
    // connection: a deadline the connection itself chose is that connection's
    // own doing and is covered by the next test. The point of the assertion is
    // the *shape* of the report — a caller must be able to tell this apart from
    // a bad password without parsing prose.
    const prev = process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
    process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = "1"
    try {
      Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
      const result = await warehouseTest("local")
      expect(result.connected).toBe(false)
      expect(result.infrastructure).toBe(true)
      expect(result.error_category).toBe("driver_open_timeout")
    } finally {
      if (prev === undefined) delete process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
      else process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = prev
    }
  })

  ddbTest("a deadline the connection itself set is a configuration fault, not infrastructure", async () => {
    // The mirror of the bug this PR fixes. Telling a caller "your client is
    // broken, stop and report it" when they set `open_timeout_ms: 1` themselves
    // is the same category error as reporting a broken install as a bad
    // password — it just points the wrong way.
    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath, open_timeout_ms: 1 } })
    const result = await warehouseTest("local")
    expect(result.connected).toBe(false)
    expect(result.error_category).toBe("config_error")
    expect(result.infrastructure).toBe(false)
  })

  ddbTest("does not mark a genuine configuration mistake as infrastructure", async () => {
    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
    const result = await warehouseTest("nonexistent")
    expect(result.connected).toBe(false)
    expect(result.infrastructure).toBe(false)
  })

  ddbTest("a healthy store is unaffected by the deadline that failed the previous case", async () => {
    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
    const result = await warehouseTest("local")
    expect(result.connected).toBe(true)
  })

  ddbTest("a store locked by another process is reported as a recoverable lock", async () => {
    const lock = await holdWriteLock(lockedPath, dir)
    try {
      await Registry.closeAll()
      Registry.reset()
      Registry.setConfigs({ local: { type: "duckdb", path: lockedPath } })
      const result = await warehouseTest("local")
      expect(result.connected).toBe(false)
      // Not "other": before this, an unwrapped lock error fell through every
      // rule in categorizeConnectionError and was reported as an unclassified
      // failure, which reads exactly like a bad password.
      expect(result.error_category).toBe("store_locked")
      // Still infrastructure — nothing about this connection's config is wrong
      // — but recoverable, which is what separates it from a broken install.
      expect(result.infrastructure).toBe(true)
      expect(result.recoverable).toBe(true)
    } finally {
      await lock.release()
    }
  })

  ddbTest("the tool tells a caller to clear a lock, not to stop and report it", async () => {
    const tool = await initTool(WarehouseTestTool)
    const ctx = { sessionID: "s", messageID: "m", agent: "build", abort: new AbortController().signal, messages: [] }
    const lock = await holdWriteLock(lockedPath, dir)
    try {
      await Registry.closeAll()
      Registry.reset()
      Registry.setConfigs({ local: { type: "duckdb", path: lockedPath } })
      const locked = await tool.execute({ name: "local" }, ctx)
      expect(locked.title).toContain("STORE LOCKED")
      expect(locked.metadata.recoverable).toBe(true)
      // A lock clears itself once the other process lets go, so the
      // stop-and-report copy meant for a broken install is wrong advice here.
      expect(locked.output).not.toContain("Stop and report this")
      expect(locked.output).toContain("Close that connection and try again")
    } finally {
      await lock.release()
    }
  })

  ddbTest("the warehouse_test tool renders infrastructure faults unmistakably", async () => {
    const tool = await initTool(WarehouseTestTool)
    const ctx = { sessionID: "s", messageID: "m", agent: "build", abort: new AbortController().signal, messages: [] }

    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
    const ok = await tool.execute({ name: "local" }, ctx)
    expect(ok.title).toContain("OK")

    Registry.reset()
    const prev = process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
    process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = "1"
    let broken: Awaited<ReturnType<typeof tool.execute>>
    try {
      Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
      broken = await tool.execute({ name: "local" }, ctx)
    } finally {
      if (prev === undefined) delete process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]
      else process.env["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"] = prev
    }
    // The whole point: a reader of this transcript — human or model — must not
    // be able to mistake a broken client for the model getting something
    // wrong, or for a connection that needs its credentials fixed.
    expect(broken.title).toContain("INFRASTRUCTURE FAILURE")
    expect(broken.output).toContain("INFRASTRUCTURE FAILURE")
    expect(broken.output).toContain("NOT a problem with the connection's configuration")
    expect(broken.metadata.infrastructure).toBe(true)
    expect(broken.metadata.error_category).toBe("driver_open_timeout")
  })
})

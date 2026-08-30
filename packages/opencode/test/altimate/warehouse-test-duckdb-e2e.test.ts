import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"
import { WarehouseTestTool } from "../../src/altimate/tools/warehouse-test"
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

async function warehouseTest(name: string) {
  return Dispatcher.call("warehouse.test", { name })
}

describe("warehouse.test against a real DuckDB store", () => {
  beforeAll(async () => {
    process.env["ALTIMATE_TELEMETRY_DISABLED"] = "true"
    if (!RUN) return
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-test-"))
    storePath = path.join(dir, "warehouse.duckdb")
    Registry.reset()
    Registry.setConfigs({ seed: { type: "duckdb", path: storePath } })
    const c = await Registry.get("seed")
    await c.execute("CREATE TABLE t AS SELECT 1 AS a")
    const probe = await c.execute("SELECT count(*) AS n FROM t")
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

  afterEach(() => {
    Registry.reset()
  })

  afterAll(() => {
    delete process.env["ALTIMATE_TELEMETRY_DISABLED"]
    Registry.reset()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  ddbTest("connects on every one of 10 consecutive fresh registries", async () => {
    // The failure this replaces was 7 of 7 calls failing, and a fix that is
    // merely usually right would recreate exactly that contamination. Each
    // iteration resets the registry so nothing is served from cache.
    for (let i = 0; i < 10; i++) {
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
    // stops the store opening. The point of the assertion is the *shape* of
    // the report: a caller must be able to tell this apart from a bad
    // password without parsing prose.
    Registry.setConfigs({ local: { type: "duckdb", path: storePath, open_timeout_ms: 1 } })
    const result = await warehouseTest("local")
    expect(result.connected).toBe(false)
    expect(result.infrastructure).toBe(true)
    expect(result.error_category).toBe("driver_open_timeout")
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

  ddbTest("the warehouse_test tool renders infrastructure faults unmistakably", async () => {
    const tool = await initTool(WarehouseTestTool)
    const ctx = { sessionID: "s", messageID: "m", agent: "build", abort: new AbortController().signal, messages: [] }

    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath } })
    const ok = await tool.execute({ name: "local" }, ctx)
    expect(ok.title).toContain("OK")

    Registry.reset()
    Registry.setConfigs({ local: { type: "duckdb", path: storePath, open_timeout_ms: 1 } })
    const broken = await tool.execute({ name: "local" }, ctx)
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

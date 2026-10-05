/**
 * The DuckDB sandbox strategy against real DuckDB files. No engine and no dbt.
 *
 * What matters here is the property the whole driver rests on: after
 * `release()`, ANOTHER PROCESS can open the sandbox file read-write, because
 * that is what dbt does next. Closing a node-duckdb handle does not give that
 * guarantee (the lock survives until garbage collection), which is why the
 * strategy ATTACHes and DETACHes instead of opening the file.
 *
 * Opt-in like the other real-DuckDB suites: ALTIMATE_DUCKDB_E2E=1. A missing
 * driver is then a failure, not a skip.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "../../../drivers/src/duckdb"
import { DuckDbSandbox } from "../../src/altimate/native/connections/fault-injection"

const RUN = process.env["ALTIMATE_DUCKDB_E2E"] === "1"
const ddbTest = RUN ? test : test.skip

const DRIVER_PATH = fileURLToPath(new URL("../../../drivers/src/duckdb.ts", import.meta.url))

/** Open `file` read-write from a separate OS process, create a table, and exit. */
function writeFromAnotherProcess(file: string, scratch: string): { ok: boolean; stderr: string } {
  const script = path.join(scratch, "other-process.ts")
  fs.writeFileSync(
    script,
    [
      `const { connect } = await import(${JSON.stringify(DRIVER_PATH)})`,
      `const c = await connect({ type: "duckdb", path: process.argv[2] })`,
      `await c.connect()`,
      `await c.execute("CREATE OR REPLACE TABLE main.written_elsewhere AS SELECT 42 AS answer")`,
      `process.exit(0)`,
    ].join("\n"),
  )
  const child = Bun.spawnSync([process.execPath, script, file], { stdout: "pipe", stderr: "pipe" })
  return { ok: child.exitCode === 0, stderr: child.stderr.toString() }
}

describe("DuckDbSandbox on real DuckDB files", () => {
  let root: string
  let project: string
  let work: string
  let original: string
  let sandbox: DuckDbSandbox

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-duckdb-"))
    project = path.join(root, "project")
    work = path.join(root, "work")
    fs.mkdirSync(project)
    fs.mkdirSync(work)
    original = path.join(project, "shop.duckdb")
    if (!RUN) return
    // Create the "user's" database without this process ever holding its lock afterwards.
    const boot = await connect({ type: "duckdb", path: ":memory:" })
    await boot.connect()
    await boot.execute(`ATTACH '${original}' AS shop`)
    await boot.execute("CREATE TABLE shop.main.raw_orders AS SELECT * FROM (VALUES (1, 10), (2, 20), (3, 30)) t(id, amount)")
    await boot.execute("CREATE VIEW shop.main.stg_orders AS SELECT id AS order_id, amount FROM shop.main.raw_orders")
    await boot.execute("DETACH shop")
    await boot.close()
    const output = { type: "duckdb", path: "shop.duckdb", schema: "main", threads: 8, settings: { memory_limit: "1GB" } }
    sandbox = new DuckDbSandbox({ projectDir: project, workDir: work, profileName: "shop", targetName: "dev", output, rawOutput: output })
    await sandbox.setup()
  })

  afterEach(async () => {
    await sandbox?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  ddbTest("setup copies the database under its own name and points both profiles at the copies", async () => {
    const YAML = (await import("yaml")).default
    for (const [target, dir] of [["Baseline", "baseline"], ["Sandbox", "sandbox"]] as const) {
      const profile = YAML.parse(fs.readFileSync(path.join(sandbox.profilesDir(target), "profiles.yml"), "utf-8"))
      expect(profile.shop.target).toBe("dev")
      expect(profile.shop.outputs.dev).toEqual({
        type: "duckdb",
        path: path.join(work, dir, "shop.duckdb"),
        schema: "main",
        threads: 1,
        settings: { memory_limit: "1GB", threads: 1 },
      })
    }
    expect(fs.existsSync(path.join(work, "baseline", "shop.duckdb"))).toBe(true)
    expect(sandbox.original).toBe(original)
    expect(await sandbox.verifyOriginalUntouched()).toEqual({ status: "unchanged" })
  })

  ddbTest("temp_directory in settings and config_options is redirected into the work directory", async () => {
    const YAML = (await import("yaml")).default
    const elsewhere = path.join(root, "user-temp")
    const output = {
      type: "duckdb",
      path: "shop.duckdb",
      schema: "main",
      settings: { memory_limit: "1GB", temp_directory: elsewhere },
      config_options: { temp_directory: elsewhere, preserve_insertion_order: false },
    }
    const other = new DuckDbSandbox({ projectDir: project, workDir: path.join(root, "work2"), profileName: "shop", targetName: "dev", output, rawOutput: output })
    try {
      fs.mkdirSync(path.join(root, "work2"))
      await other.setup()
      for (const target of ["Baseline", "Sandbox"] as const) {
        const profile = YAML.parse(fs.readFileSync(path.join(other.profilesDir(target), "profiles.yml"), "utf-8"))
        const out = profile.shop.outputs.dev
        const expected = path.join(root, "work2", "duckdb-temp", target.toLowerCase())
        expect(out.settings.temp_directory).toBe(expected)
        expect(out.config_options.temp_directory).toBe(expected)
        expect(out.settings.memory_limit).toBe("1GB")
        expect(out.config_options.preserve_insertion_order).toBe(false)
      }
      expect(fs.existsSync(elsewhere)).toBe(false)
    } finally {
      await other.close()
    }
  })

  ddbTest("the baseline is read-only and reports relations with their kinds", async () => {
    expect(await sandbox.execute("Baseline", 'SELECT COUNT(*), SUM(amount) FROM "main"."stg_orders"')).toEqual([[3n, 60n]])
    await expect(sandbox.execute("Baseline", 'CREATE TABLE "main"."x" AS SELECT 1')).rejects.toThrow("read-only")
    expect(await sandbox.listRelations()).toEqual([
      {
        database: "shop",
        schema: "main",
        name: "raw_orders",
        relation_type: "table",
        columns: [
          { name: "id", data_type: "INTEGER" },
          { name: "amount", data_type: "INTEGER" },
        ],
      },
      {
        database: "shop",
        schema: "main",
        name: "stg_orders",
        relation_type: "view",
        columns: [
          { name: "order_id", data_type: "INTEGER" },
          { name: "amount", data_type: "INTEGER" },
        ],
      },
    ])
  })

  ddbTest("only a catalog error counts as a missing relation", async () => {
    const missing = await sandbox.execute("Baseline", 'SELECT * FROM "main"."nope"').catch((e) => e)
    expect(sandbox.isRelationMissing(missing)).toBe(true)
    const binder = await sandbox.execute("Baseline", 'SELECT nope FROM "main"."raw_orders"').catch((e) => e)
    expect(binder).toBeInstanceOf(Error)
    expect(sandbox.isRelationMissing(binder)).toBe(false)
  })

  ddbTest("after release another process can write the sandbox, and its writes are seen on re-attach", async () => {
    await sandbox.prepareSandbox()
    const file = path.join(work, "sandbox", "shop.duckdb")
    await sandbox.execute("Sandbox", 'CREATE TABLE "main"."mutated" AS SELECT * FROM "main"."raw_orders" WHERE id <> 2')

    // While attached, this process holds the lock: the other process must fail. This is
    // the situation dbt would be in without release(), and it makes the next assertion mean something.
    const blocked = writeFromAnotherProcess(file, root)
    expect(blocked.ok).toBe(false)
    expect(blocked.stderr).toContain("lock")

    await sandbox.release("Sandbox")
    expect(fs.existsSync(`${file}.wal`)).toBe(false)
    const free = writeFromAnotherProcess(file, root)
    expect(free.stderr).toBe("")
    expect(free.ok).toBe(true)

    expect(await sandbox.execute("Sandbox", 'SELECT answer FROM "main"."written_elsewhere"')).toEqual([[42]])
    expect(await sandbox.execute("Sandbox", 'SELECT COUNT(*) FROM "main"."mutated"')).toEqual([[2n]])
    // Nothing reached the baseline or the original.
    await expect(sandbox.execute("Baseline", 'SELECT * FROM "main"."mutated"')).rejects.toThrow("Catalog Error")
    expect(await sandbox.verifyOriginalUntouched()).toEqual({ status: "unchanged" })
  })

  ddbTest("prepareSandbox discards the previous sandbox, including while it is attached", async () => {
    await sandbox.prepareSandbox()
    await sandbox.execute("Sandbox", 'DROP VIEW "main"."stg_orders"')
    await sandbox.prepareSandbox()
    expect(await sandbox.execute("Sandbox", 'SELECT COUNT(*) FROM "main"."stg_orders"')).toEqual([[3n]])
  })

  ddbTest("refuses to attach a sandbox path that resolves to the original database", async () => {
    await sandbox.prepareSandbox()
    const file = path.join(work, "sandbox", "shop.duckdb")
    fs.rmSync(file)
    fs.symlinkSync(original, file)
    await expect(sandbox.execute("Sandbox", 'DROP TABLE "main"."raw_orders"')).rejects.toThrow(
      "Refusing to run: cannot establish that",
    )
    fs.rmSync(file)
    fs.linkSync(original, file)
    // A hard link: caught by inode, or already by path where realpath follows the link (macOS).
    await expect(sandbox.execute("Sandbox", 'DROP TABLE "main"."raw_orders"')).rejects.toThrow(
      "Refusing to run: cannot establish that",
    )
    expect(await sandbox.execute("Baseline", 'SELECT COUNT(*) FROM "main"."raw_orders"')).toEqual([[3n]])
    expect(await sandbox.verifyOriginalUntouched()).toEqual({ status: "unchanged" })
  })

  ddbTest("a failed attach leaves no half-attached connection behind", async () => {
    // No sandbox has been prepared yet: the file does not exist.
    await expect(sandbox.execute("Sandbox", "SELECT 1")).rejects.toThrow()
    await sandbox.prepareSandbox()
    expect(await sandbox.execute("Sandbox", 'SELECT COUNT(*) FROM "main"."raw_orders"')).toEqual([[3n]])
  })

  ddbTest("a change to the original database is noticed", async () => {
    fs.appendFileSync(original, "x")
    const check = await sandbox.verifyOriginalUntouched()
    expect(check.status).toBe("changed")
  })

  ddbTest("a database with a pending write-ahead log is refused", async () => {
    fs.writeFileSync(`${original}.wal`, "")
    const output = { type: "duckdb", path: "shop.duckdb" }
    const other = new DuckDbSandbox({
      projectDir: project,
      workDir: fs.mkdtempSync(path.join(root, "work2-")),
      profileName: "shop",
      targetName: "dev",
      output,
      rawOutput: output,
    })
    await expect(other.setup()).rejects.toThrow("shop.duckdb.wal exists")
  })
})

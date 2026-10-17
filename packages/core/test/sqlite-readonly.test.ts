import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Effect } from "effect"
import { layer } from "../src/database/sqlite.bun"
import { Sqlite } from "../src/database/sqlite"
import { tmpdir } from "./fixture/tmpdir"

describe("sqlite.bun read-only open", () => {
  test("rejects writes and leaves the journal mode alone", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "ro.sqlite")
    const seed = new BunDatabase(filename, { create: true })
    seed.run("CREATE TABLE t (x INTEGER)")
    seed.close()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const native = (yield* Sqlite.Native) as BunDatabase
        const mode = native.query("PRAGMA journal_mode").get() as { journal_mode: string }
        const write = (() => {
          try {
            native.run("INSERT INTO t VALUES (1)")
            return "written"
          } catch (error) {
            return (error as Error).message
          }
        })()
        return { mode: mode.journal_mode, write }
      }).pipe(Effect.provide(layer({ filename, readonly: true })), Effect.scoped),
    )

    expect(result.mode).toBe("delete")
    expect(result.write).toContain("readonly")
  })

  test("does not create a missing file", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "missing.sqlite")
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Sqlite.Native
      }).pipe(Effect.provide(layer({ filename, readonly: true })), Effect.scoped),
    )
    expect(exit._tag).toBe("Failure")
    expect(await Bun.file(filename).exists()).toBe(false)
  })
})

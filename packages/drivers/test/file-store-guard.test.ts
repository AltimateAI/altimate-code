/**
 * Unit tests for the file-backed store guards (src/file-store.ts).
 *
 * Both DuckDB and SQLite create an empty database when opened on a path that
 * does not exist. For a warehouse connection that turns a wrong path into a
 * silent empty result set rather than an error, so opening is read-or-fail
 * unless the caller passes `create: true`.
 *
 * The end-to-end proof — a populated store reached through `--dir` from an
 * unrelated cwd, run against a compiled binary — lives in
 * packages/opencode/test/altimate/store-path-resolution.test.ts.
 */
import { describe, test, expect, mock, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { allowsCreate, assertStoreExists, isLocalFilePath } from "../src/file-store"

const CANARY_TABLE = "zorbulax_ledger"

const tmpDirs: string[] = []
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-store-guard-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe("isLocalFilePath", () => {
  test("treats in-memory and remote targets as non-files", () => {
    expect(isLocalFilePath(":memory:")).toBe(false)
    expect(isLocalFilePath("")).toBe(false)
    expect(isLocalFilePath("md:my_database")).toBe(false)
    expect(isLocalFilePath("motherduck:my_database")).toBe(false)
    expect(isLocalFilePath("s3://bucket/warehouse.duckdb")).toBe(false)
    expect(isLocalFilePath("https://example.com/warehouse.duckdb")).toBe(false)
    // A scheme from a DuckDB extension we have never heard of is still not a
    // local file; the driver reports an unknown scheme rather than creating one.
    expect(isLocalFilePath("ducklake:my_catalog")).toBe(false)
  })

  test("treats real paths — including Windows drive letters — as files", () => {
    expect(isLocalFilePath("warehouse.duckdb")).toBe(true)
    expect(isLocalFilePath("./data/warehouse.duckdb")).toBe(true)
    expect(isLocalFilePath("/var/data/warehouse.duckdb")).toBe(true)
    expect(isLocalFilePath("C:\\data\\warehouse.duckdb")).toBe(true)
  })

  test("only the exact `:memory:` is in-memory — `:memory:name` is a real file", () => {
    // DuckDB writes a file literally named ":memory:named" for this path, and
    // a colon-prefixed name is an ordinary file to both engines. Classifying
    // them as non-files would let the guard be bypassed by a typo.
    expect(isLocalFilePath(":memory:named")).toBe(true)
    expect(isLocalFilePath(":memory")).toBe(true)
    expect(isLocalFilePath(":foo")).toBe(true)
  })
})

describe("assertStoreExists", () => {
  test("throws for a missing local file, naming the path it looked for", () => {
    const missing = path.join(tmp(), "absent.duckdb")
    expect(() => assertStoreExists({ type: "duckdb" }, missing, "DuckDB")).toThrow(missing)
    expect(() => assertStoreExists({ type: "duckdb" }, missing, "DuckDB")).toThrow("not found")
    expect(fs.existsSync(missing)).toBe(false)
  })

  test("throws for a missing `:memory:`-lookalike rather than letting it be created", () => {
    const dir = tmp()
    const lookalike = path.join(dir, ":memory:named")
    expect(() => assertStoreExists({ type: "duckdb" }, lookalike, "DuckDB")).toThrow("not found")
    expect(fs.existsSync(lookalike)).toBe(false)
  })

  test("passes for an existing file, an in-memory target, or an explicit create", () => {
    const dir = tmp()
    const present = path.join(dir, "present.duckdb")
    fs.writeFileSync(present, "")
    expect(() => assertStoreExists({ type: "duckdb" }, present, "DuckDB")).not.toThrow()
    expect(() => assertStoreExists({ type: "duckdb" }, ":memory:", "DuckDB")).not.toThrow()
    expect(() =>
      assertStoreExists({ type: "duckdb", create: true }, path.join(dir, "new.duckdb"), "DuckDB"),
    ).not.toThrow()
  })

  test("allowsCreate only accepts a literal true", () => {
    expect(allowsCreate({ type: "duckdb", create: true })).toBe(true)
    expect(allowsCreate({ type: "duckdb", create: "true" })).toBe(false)
    expect(allowsCreate({ type: "duckdb" })).toBe(false)
  })
})

describe("DuckDB driver create-on-open", () => {
  test("refuses to open a missing store and creates nothing", async () => {
    // The real duckdb addon is an optional dependency; the guard runs before
    // any Database is constructed, so a stub is enough to prove it fires first.
    let constructed = false
    mock.module("duckdb", () => ({
      default: {
        Database: class {
          constructor(_p: string, optsOrCb: any, cb?: (err: Error | null) => void) {
            constructed = true
            const done = typeof optsOrCb === "function" ? optsOrCb : cb!
            setTimeout(() => done(null), 0)
          }
          connect() {
            return {}
          }
          close(cb: any) {
            if (cb) cb(null)
          }
        },
      },
    }))

    const missing = path.join(tmp(), "absent.duckdb")
    const { connect } = await import("../src/duckdb")
    const connector = await connect({ type: "duckdb", path: missing })

    await expect(connector.connect()).rejects.toThrow("not found")
    expect(constructed).toBe(false)
    expect(fs.existsSync(missing)).toBe(false)
  })
})

describe("SQLite driver create-on-open", () => {
  test("reads an existing store", async () => {
    const store = path.join(tmp(), "warehouse.db")
    const seed = new Database(store, { create: true })
    seed.exec(`CREATE TABLE ${CANARY_TABLE}(id INTEGER)`)
    seed.close()

    const { connect } = await import("../src/sqlite")
    const connector = await connect({ type: "sqlite", path: store })
    await connector.connect()
    const tables = await connector.listTables("main")
    await connector.close()

    expect(tables.map((t) => t.name)).toContain(CANARY_TABLE)
  })

  test("refuses to open a missing store and creates nothing", async () => {
    const missing = path.join(tmp(), "absent.db")
    const { connect } = await import("../src/sqlite")
    const connector = await connect({ type: "sqlite", path: missing })

    await expect(connector.connect()).rejects.toThrow("not found")
    expect(fs.existsSync(missing)).toBe(false)
  })

  test("refuses a read-only connection to a missing store even with create: true", async () => {
    // A read-only open never creates, so `create` must not excuse the miss.
    const missing = path.join(tmp(), "absent-readonly.db")
    const { connect } = await import("../src/sqlite")
    const connector = await connect({ type: "sqlite", path: missing, readonly: true, create: true })

    await expect(connector.connect()).rejects.toThrow("not found")
    expect(fs.existsSync(missing)).toBe(false)
  })

  test("creates only when the caller opts in", async () => {
    const target = path.join(tmp(), "scratch.db")
    const { connect } = await import("../src/sqlite")
    const connector = await connect({ type: "sqlite", path: target, create: true })
    await connector.connect()
    await connector.close()

    expect(fs.existsSync(target)).toBe(true)
  })
})

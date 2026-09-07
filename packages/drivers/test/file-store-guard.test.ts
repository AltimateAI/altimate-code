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
import { allowsCreate, assertStoreExists, absoluteFileUriPath, isLocalFilePath } from "../src/file-store"

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

  // altimate_change start — regression: a doubled-slash Windows drive path is a
  // real local path, not a `scheme://` URI
  test("treats a doubled-slash Windows drive path as local, not a scheme:// URI", () => {
    // `C://data/warehouse.duckdb` is a valid (if unusual) absolute Windows path —
    // path.win32.normalize collapses it to `C:\data\warehouse.duckdb`. The
    // scheme://-form regex used to accept a single-character scheme, so "C"
    // matched it exactly like "s3" does in `s3://...`, misclassifying it as
    // remote and skipping both path resolution and the existence guard. No real
    // remote/extension scheme is a single letter, so requiring 2+ characters
    // before "://" fixes this without affecting genuine schemes.
    expect(isLocalFilePath("C://data/warehouse.duckdb")).toBe(true)
    expect(isLocalFilePath("D://warehouse.duckdb")).toBe(true)
    // Genuine two-or-more-character schemes are still excluded.
    expect(isLocalFilePath("s3://bucket/warehouse.duckdb")).toBe(false)
  })
  // altimate_change end

  test("only the exact `:memory:` is in-memory — `:memory:name` is a real file", () => {
    // DuckDB writes a file literally named ":memory:named" for this path, and
    // a colon-prefixed name is an ordinary file to both engines. Classifying
    // them as non-files would let the guard be bypassed by a typo.
    expect(isLocalFilePath(":memory:named")).toBe(true)
    expect(isLocalFilePath(":memory")).toBe(true)
    expect(isLocalFilePath(":foo")).toBe(true)
  })

  // altimate_change start — regression: an ordinary filename that merely
  // contains a colon must not be misread as a remote scheme
  test("a local filename shaped like `scheme:name` (no `//`) is still a local file", () => {
    // The exclusion used to match ANY "2+ letter prefix + colon", so a file
    // literally named "data:warehouse.duckdb" was misclassified as a remote
    // target and silently skipped both path resolution and the existence
    // guard. Only a real `scheme://` URI or one of the specific non-slash
    // DuckDB extension schemes (md:, motherduck:, ducklake:) should be excluded.
    expect(isLocalFilePath("data:warehouse.duckdb")).toBe(true)
    expect(isLocalFilePath("foo:warehouse.db")).toBe(true)
  })
  // altimate_change end
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

  // altimate_change start — an absolute `file:` URI is not a "local file" by
  // isLocalFilePath (see its own comment), but it still names one unambiguous
  // on-disk location and must be existence-checked, or a missing absolute
  // file: store opens silently empty — the exact bug class this guard exists
  // to catch.
  test("throws for a missing absolute `file:` URI", () => {
    const missing = path.join(tmp(), "absent.duckdb")
    const uri = `file://${missing}`
    expect(() => assertStoreExists({ type: "duckdb" }, uri, "DuckDB")).toThrow("not found")
    expect(fs.existsSync(missing)).toBe(false)
  })

  test("passes for an existing absolute `file:` URI", () => {
    const dir = tmp()
    const present = path.join(dir, "present.duckdb")
    fs.writeFileSync(present, "")
    const uri = `file://${present}`
    expect(() => assertStoreExists({ type: "duckdb" }, uri, "DuckDB")).not.toThrow()
  })

  // altimate_change: regression — a `file:////...` URI (4+ leading slashes)
  // used to be misread as relative by the bounded {1,3}-slash check, so
  // isLocalFilePath's own file: exclusion made assertStoreExists skip it
  // entirely and a missing store there opened silently empty.
  test("throws for a missing `file:////` (4-slash) absolute URI", () => {
    const missing = path.join(tmp(), "absent.duckdb")
    const uri = `file:///${missing}` // absoluteFileUriPath sees 4 total slashes after "file:"
    expect(() => assertStoreExists({ type: "duckdb" }, uri, "DuckDB")).toThrow("not found")
  })

  test("does not existence-check a relative `file:` URI (tracked separately as #1209)", () => {
    // resolveStorePaths leaves relative file: URIs untouched, so guarding
    // existence here would check against whatever the process cwd happens to
    // be — the exact cwd-following bug this PR removes for plain paths. That
    // stays out of scope; absoluteFileUriPath returns undefined for it and
    // the guard falls through isLocalFilePath's own file: exclusion.
    expect(() => assertStoreExists({ type: "duckdb" }, "file:relative/warehouse.duckdb", "DuckDB")).not.toThrow()
  })
  // altimate_change end

  // altimate_change start — a directory at dbPath is not a valid store
  test("throws when dbPath names a directory, not a file", () => {
    const dir = tmp()
    // altimate_change: the message now specifically says "directory" (a more
    // accurate diagnosis than "not found" — the path DOES exist), since
    // rejectIfDirectory reports it before the exists/missing check ever runs.
    expect(() => assertStoreExists({ type: "duckdb" }, dir, "DuckDB")).toThrow("directory")
  })

  // altimate_change: regression — `create: true` used to bypass the directory
  // check entirely (the `if (allowCreate) return` ran before it), so a
  // directory path reached the driver with `create: true` and failed there
  // with a confusing engine-level error instead of this guard's clear one.
  // Neither engine can create a database AT a path that is already a
  // directory, so the directory rejection must fire regardless of `create`.
  test("throws when dbPath names a directory even with create: true", () => {
    const dir = tmp()
    expect(() => assertStoreExists({ type: "duckdb", create: true }, dir, "DuckDB")).toThrow("directory")
    // A plain "not found" would be misleading here — the path DOES exist, it's
    // just not a valid store — so the message must say "directory", not "not found".
    expect(() => assertStoreExists({ type: "duckdb", create: true }, dir, "DuckDB")).not.toThrow("not found")
  })

  test("still allows creation of a missing FILE with create: true (directory check doesn't over-reject)", () => {
    const dir = tmp()
    expect(() =>
      assertStoreExists({ type: "duckdb", create: true }, path.join(dir, "new.duckdb"), "DuckDB"),
    ).not.toThrow()
  })

  test("throws when an absolute `file:` URI names a directory even with create: true", () => {
    const dir = tmp()
    const uri = `file://${dir}`
    expect(() => assertStoreExists({ type: "duckdb", create: true }, uri, "DuckDB")).toThrow("directory")
  })
  // altimate_change end
})

describe("absoluteFileUriPath", () => {
  test("resolves an absolute `file://` URI to its filesystem path", () => {
    expect(absoluteFileUriPath("file:///var/data/warehouse.duckdb")).toBe("/var/data/warehouse.duckdb")
  })

  test("returns undefined for a relative `file:` URI", () => {
    expect(absoluteFileUriPath("file:relative/warehouse.duckdb")).toBeUndefined()
  })

  // altimate_change start — regression: 4+ leading slashes (UNC-style shares)
  // used to be rejected as "not absolute" by a bounded {1,3} slash count; any
  // number of leading slashes is a valid absolute file: URI form, and
  // fileURLToPath folds the extra slashes into the resulting path.
  test("resolves an absolute `file:` URI with four or more leading slashes", () => {
    expect(absoluteFileUriPath("file:////mnt/share/warehouse.duckdb")).toBe("//mnt/share/warehouse.duckdb")
    expect(absoluteFileUriPath("file://///mnt/share/warehouse.duckdb")).toBe("///mnt/share/warehouse.duckdb")
  })
  // altimate_change end

  test("returns undefined for the in-memory/temporary forms", () => {
    expect(absoluteFileUriPath("file:")).toBeUndefined()
    expect(absoluteFileUriPath("file::memory:")).toBeUndefined()
    expect(absoluteFileUriPath("file:test.db?mode=memory")).toBeUndefined()
  })

  test("returns undefined for a non-`file:` path", () => {
    expect(absoluteFileUriPath("/var/data/warehouse.duckdb")).toBeUndefined()
    expect(absoluteFileUriPath(":memory:")).toBeUndefined()
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

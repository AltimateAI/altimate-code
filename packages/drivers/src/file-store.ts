/**
 * Shared guards for file-backed drivers (DuckDB, SQLite).
 *
 * Both engines create an empty database when asked to open a file that does
 * not exist. For a warehouse connection that is never what the caller wants:
 * a mistyped or mis-resolved path then yields a working connector over an
 * empty database, so every query succeeds and returns nothing. An agent handed
 * that result reports "no tables" instead of an error.
 *
 * Opening a store is therefore read-or-fail by default. Creation is opt-in via
 * `create: true`, which the tools that deliberately materialize a local store
 * (local test scratch databases, schema sync targets) pass explicitly.
 */

import * as fs from "fs"
import type { ConnectionConfig } from "./types"

/**
 * Whether `dbPath` names a file on the local filesystem, and so can be
 * existence-checked before the driver opens it.
 *
 * Only the exact string `:memory:` is an in-memory database. Both engines
 * treat `:memory:named` — and any other colon-prefixed name — as an ordinary
 * (if oddly named) file: DuckDB really does write a file called
 * `:memory:named`, so those must stay inside the guard. An empty path is
 * DuckDB's in-memory database and SQLite's anonymous temporary one; neither
 * touches disk.
 *
 * A scheme-qualified target is not a local file: MotherDuck (`md:`), object
 * storage (`s3://`), DuckLake, and any other scheme a DuckDB extension
 * provides. Those are left to the driver, which reports an unknown scheme as a
 * missing-extension error rather than silently creating anything. The pattern
 * requires two or more characters before the colon so a Windows drive letter
 * (`C:\data\wh.duckdb`) stays a path.
 */
export function isLocalFilePath(dbPath: string): boolean {
  if (dbPath === "" || dbPath === ":memory:") return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(dbPath)) return false
  return true
}

/** Whether the caller explicitly opted in to creating the store. */
export function allowsCreate(config: ConnectionConfig): boolean {
  return config.create === true
}

/**
 * Throw unless the store is safe to open: it already exists, the caller opted
 * in to creating it, or the path is not a local file at all.
 *
 * @param engine Human-readable engine name used in the error message.
 * @param allowCreate Whether this open will actually create the store. Defaults
 *   to the config's `create` flag; a driver passes it explicitly when its own
 *   options can veto creation — SQLite never creates a read-only connection.
 */
export function assertStoreExists(
  config: ConnectionConfig,
  dbPath: string,
  engine: string,
  allowCreate: boolean = allowsCreate(config),
): void {
  if (allowCreate) return
  if (!isLocalFilePath(dbPath)) return
  if (fs.existsSync(dbPath)) return
  throw new Error(
    `${engine} database file not found: "${dbPath}". ` +
      `Opening a warehouse connection never creates the database — an empty store would answer every query with no rows. ` +
      `Check the "path" in your connection config (relative paths resolve against the config file's directory, not the current directory), ` +
      `or pass "create": true if this store is meant to be created.`,
  )
}

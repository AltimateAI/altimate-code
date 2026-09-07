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
import { fileURLToPath } from "url"
import type { ConnectionConfig } from "./types"

// altimate_change start — narrow the scheme exclusion to genuine remote/extension targets
/**
 * DuckDB extension schemes that take a bare `scheme:rest` form with no `//`
 * — MotherDuck (`md:`) and DuckLake (`ducklake:`) — and so cannot be told
 * apart from a local filename by the `://` check below.
 *
 * Fundamental ambiguity: a bare `word:target` is syntactically identical
 * whether `word` is a filename prefix (`data:warehouse.duckdb`, a real local
 * file) or a remote extension scheme (`md:my_database`). Nothing in the
 * string alone can distinguish them.
 *
 * Deliberate choice: a closed list, not a broad heuristic. Local filenames
 * that happen to contain a colon are the common case here; bare-scheme
 * DuckDB extensions are a small, enumerable set. Listing the known ones and
 * treating everything else as local is safer than the reverse (treating
 * every `word:target` as remote, which misclassified real local files — see
 * `isLocalFilePath`'s own comment).
 *
 * Escape hatch: a custom/future extension whose target uses a bare scheme
 * not in this list is NOT forwarded — it's treated as a local path and will
 * fail the existence guard. Two ways out: (1) use the extension's `scheme://`
 * form if it has one (always forwarded, see the `://` check below), or (2)
 * add the new bare scheme to this list once it's an extension the driver
 * actually needs to support.
 */
const NON_SLASH_REMOTE_SCHEMES = ["md:", "motherduck:", "ducklake:"]
// altimate_change end

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
 * missing-extension error rather than silently creating anything.
 *
 * altimate_change: the exclusion used to fire on ANY two-or-more-letter
 * prefix followed by a colon, which misclassified an ordinary local filename
 * that happens to contain one — `data:warehouse.duckdb`, `foo:warehouse.db`
 * — as a remote target, silently skipping both path resolution and the
 * existence guard below. Only a `scheme://` URI or one of the specific
 * non-slash extension schemes DuckDB actually recognizes is excluded now; a
 * `C:\...` Windows drive letter still passes through unaffected, since
 * neither pattern matches it. `file:` is deliberately still excluded here —
 * it is a real local path, but resolving/existence-checking it is handled
 * separately (see `absoluteFileUriPath` below) because it is not safe to
 * treat as an ordinary path string (see registry.ts's `resolveStorePaths`,
 * which would otherwise mangle it with `path.resolve`).
 */
export function isLocalFilePath(dbPath: string): boolean {
  if (dbPath === "" || dbPath === ":memory:") return false
  if (/^file:/i.test(dbPath)) return false
  // altimate_change start — a single-letter "scheme" is a Windows drive letter, not a URI
  // A doubled-slash Windows path like `C://data/warehouse.duckdb` is a valid absolute
  // path (path.win32.normalize collapses it to `C:\data\warehouse.duckdb`), but the
  // scheme://-form regex below used to accept a one-character scheme, so `C:` matched
  // it exactly like `s3:` does. No real remote/extension scheme is a single letter —
  // require at least two characters before "://" so a drive letter is never mistaken
  // for one.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(dbPath)) return false
  // altimate_change end
  if (NON_SLASH_REMOTE_SCHEMES.some((scheme) => dbPath.toLowerCase().startsWith(scheme))) return false
  return true
}

// altimate_change start — existence-check absolute `file:` URIs too
/**
 * The on-disk path an ABSOLUTE `file:` URI names, or `undefined` if `dbPath`
 * is not a `file:` URI, is a relative one, or is one of SQLite/DuckDB's
 * in-memory or temporary URI forms (`file:`, `file::memory:`,
 * `file:name?mode=memory`) that never touch disk.
 *
 * Scoped deliberately narrow to the absolute case. This PR does not resolve a
 * relative `file:` URI against a base directory (registry.ts's
 * `resolveStorePaths` leaves `file:` paths untouched — see `isLocalFilePath`
 * above), so guarding a relative one's existence here would check whatever
 * the process's current directory happens to be, which is exactly the
 * cwd-following bug this PR exists to remove. An absolute `file:` URI names
 * one unambiguous location regardless of cwd, so it is safe to check.
 */
export function absoluteFileUriPath(dbPath: string): string | undefined {
  if (!/^file:/i.test(dbPath)) return undefined
  const rest = dbPath.slice("file:".length)
  if (rest === "" || rest.startsWith(":")) return undefined // file:, file::memory:
  if (/[?&]mode=memory\b/i.test(dbPath)) return undefined
  // altimate_change start — accept any number of leading slashes, not just 1-3.
  // `file:////mnt/share/warehouse.duckdb` (four or more slashes — seen with UNC-style
  // shares) is a valid absolute file: URI; fileURLToPath handles the extra slashes by
  // folding them into the resulting path (verified: `file:////x` -> `//x`), so there is
  // no reason to reject it here before even trying to parse it.
  const isSlashForm = /^\/+/.test(rest)
  // altimate_change end
  const isBareWindowsDrive = /^[a-zA-Z]:[\\/]/.test(rest)
  if (!isSlashForm && !isBareWindowsDrive) return undefined // relative — not this guard's job
  try {
    // fileURLToPath requires an authority (even an empty one); `file:C:/x`
    // needs a slash inserted before the drive letter to parse as one.
    const href = isBareWindowsDrive ? dbPath.replace(/^file:/i, "file:/") : dbPath
    return fileURLToPath(href)
  } catch {
    return undefined
  }
}
// altimate_change end

/**
 * The store path a file-backed connection names, or a loud failure.
 *
 * Both drivers used to read `(config.path as string) ?? ":memory:"`. That turns
 * ANY failure to carry a path — a config the registry never loaded, a field
 * under the wrong name, a lookup that fell through — into a successful
 * connection over an empty in-memory database. Every query then returns no rows
 * and no error, which reads as a healthy warehouse that happens to be empty.
 *
 * It is a worse failure than creating a store on disk: a stray file can at
 * least be found afterwards, whereas an in-memory database leaves nothing
 * behind to explain the empty answer. `:memory:` remains available, but only
 * when a caller asks for it by name.
 */
export function requireStorePath(config: ConnectionConfig, engine: string): string {
  const value = config.path
  if (typeof value === "string" && value !== "") return value
  throw new Error(
    `${engine} connection is missing its "path". A file-backed warehouse must name its database explicitly — ` +
      `falling back to an in-memory database would answer every query with no rows and no error, ` +
      `which is indistinguishable from a healthy but empty warehouse. ` +
      `Set "path" to the database file, or to ":memory:" if a throwaway empty database is genuinely what you want.`,
  )
}

/** Whether the caller explicitly opted in to creating the store. */
export function allowsCreate(config: ConnectionConfig): boolean {
  return config.create === true
}

// altimate_change start — a directory at dbPath is never a valid store, with or
// without `create`
/**
 * Throw if `path` names an existing directory. A directory can never be
 * opened as a database by either engine, whether or not the caller passed
 * `create: true` — creation only ever means "create a missing FILE", not
 * "replace a directory". This must run before the `allowCreate` bypass in
 * `assertStoreExists`: `create: true` is meant to skip the "does this file
 * exist yet" check, not the "is this actually a directory" check, or a
 * misconfigured directory path reaches the driver and fails there with a
 * confusing engine-level error instead of this guard's clear one.
 */
function rejectIfDirectory(path: string, displayPath: string, engine: string): void {
  let isDir: boolean
  try {
    isDir = fs.existsSync(path) && fs.statSync(path).isDirectory()
  } catch {
    // A stat failure here (e.g. a race with a delete, or a permissions error)
    // is not this guard's to diagnose — let the driver's own open surface it.
    isDir = false
  }
  if (!isDir) return
  throw new Error(
    `${engine} database path is a directory, not a file: "${displayPath}". ` +
      `A directory can never be opened as a database — this applies even when "create" is set, ` +
      `since creation only ever means creating a missing file.`,
  )
}
// altimate_change end

/**
 * Throw unless the store is safe to open: it is not a directory, and it
 * either already exists, the caller opted in to creating it, or the path is
 * not a local file at all.
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
  // altimate_change start — existence-check an absolute `file:` URI too;
  // `isLocalFilePath` deliberately excludes `file:` (see its own comment), so
  // without this branch every `file:` store — including absolute ones that
  // name one unambiguous on-disk location regardless of cwd — skipped the
  // guard entirely and a missing absolute file: store opened silently empty,
  // the exact bug class this guard exists to catch.
  const fileUriPath = absoluteFileUriPath(dbPath)
  if (fileUriPath !== undefined) {
    // altimate_change: the directory check MUST run before the `allowCreate`
    // bypass below — see rejectIfDirectory's own comment.
    rejectIfDirectory(fileUriPath, dbPath, engine)
    if (allowCreate) return
    if (fs.existsSync(fileUriPath)) return
    throw new Error(
      `${engine} database file not found: "${dbPath}" (resolved to "${fileUriPath}"). ` +
        `Opening a warehouse connection never creates the database — an empty store would answer every query with no rows. ` +
        `Check the "path" in your connection config, or pass "create": true if this store is meant to be created.`,
    )
  }
  // altimate_change end
  if (!isLocalFilePath(dbPath)) return
  // altimate_change: same ordering requirement as the file: URI branch above.
  rejectIfDirectory(dbPath, dbPath, engine)
  if (allowCreate) return
  if (fs.existsSync(dbPath)) return
  throw new Error(
    `${engine} database file not found: "${dbPath}". ` +
      `Opening a warehouse connection never creates the database — an empty store would answer every query with no rows. ` +
      `Check the "path" in your connection config (relative paths resolve against the config file's directory, not the current directory), ` +
      `or pass "create": true if this store is meant to be created.`,
  )
}

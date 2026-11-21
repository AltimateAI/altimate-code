import { Database as SQLite, constants as SQLiteConstants } from "bun:sqlite"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { pathToFileURL } from "url"
import * as Effect from "effect/Effect"
import { InstanceRef } from "@/effect/instance-ref"
import { attach } from "@/effect/run-service"
import { Flag, env as flagEnv } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Global } from "../../global"
import { ConfigPaths } from "@/config/paths"
import { ConfigManaged } from "@/config/managed"
import { Config, validateLoaded } from "@/config/config"

/**
 * Whether the user config turns telemetry off, read without an Instance.
 *
 * `Config.get()` needs an Instance, and the CLI's main thread initialises telemetry in middleware
 * before one exists, so there it throws. This reads the same files `Config`
 * merges, in the same order (a later source overrides an earlier one), straight from disk:
 * the global config files (the legacy TOML `config` file included), `OPENCODE_CONFIG`, the project
 * files and `.altimate-code`/`.opencode` directories found from `directory`, the inline
 * `OPENCODE_CONFIG_CONTENT`, the managed config directory and macOS managed preferences. Remote and
 * account configs are not fetched here. If either could still opt out, the answer is unknown.
 * The read runs before telemetry knows whether it may send.
 *
 * - `disabled`: the last source that sets `telemetry.disabled` sets it to `true`.
 * - `enabled`: no source turns it off.
 * - `unreadable`: some source could not be read, parsed or validated as `Config` does (a missing
 *   `{file:}` reference, a value its schema rejects). `Config` would fail to load at all, so the
 *   answer is unknown. A configured remote source that could still opt out is also unknown.
 *   Callers fail closed for anything an opt-out forbids.
 */
export type State = "disabled" | "enabled" | "unreadable"

const DIR_FILES = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]
const GLOBAL_FILES = ["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]

/** The git root above `directory`, which `Config` uses as the stop for its upward search. */
function worktreeOf(directory: string): string | undefined {
  let dir = path.resolve(directory)
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function disablingEnvironmentVariable(): string | undefined {
  return ["ALTIMATE_TELEMETRY_DISABLED", "ALTIMATE_CLI_DISABLE_TELEMETRY", "OPENCODE_DISABLE_TELEMETRY"].find((key) =>
    /^(true|1)$/i.test(process.env[key] ?? ""),
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function hasWellKnownAuth(): Promise<boolean> {
  // As Auth reads it: OPENCODE_AUTH_CONTENT when it parses, otherwise the auth file.
  const inline = process.env.OPENCODE_AUTH_CONTENT
  let parsed: unknown = inline ? parseJson(inline) : undefined
  if (parsed === undefined) {
    let contents: string
    try {
      contents = await fs.readFile(Auth.filepath(), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false
      throw error
    }
    // Unparseable: a well-known entry may be behind it. `Config` would load without its remote config.
    // An empty file (touched, or a crash between Auth.set's truncate and write) holds no entry, as Auth.all()
    // reads it; anything else that does not parse (whitespace included) is unreadable there too.
    parsed = contents === "" ? {} : JSON.parse(contents)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Unreadable auth store")
  // Any well-known-typed entry counts: Auth passes OPENCODE_AUTH_CONTENT through without decoding it, so
  // Config can fetch remote config even for an entry the file path would reject (fail closed).
  return Object.values(parsed).some(
    (entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "wellknown",
  )
}

export function instanceDirectory(): string | undefined {
  return Effect.runSync(attach(InstanceRef))?.directory
}

/** The opt-out from the full config; throws where `Config` cannot load (outside an Instance). */
export async function loadedState(): Promise<State> {
  const config = await Config.get()
  // An opt-out the readable sources already set stands, even if another source could not be read.
  if (config.telemetry?.disabled === true) return "disabled"
  // Config marks a load whose auth store could not be read (Auth.all() records it), so the store is
  // not read again here: the load that built this config is what counts.
  if (Config.telemetryConfigUnresolved(config)) return "unreadable"
  return "enabled"
}

/** The opt-out as the caller can best read it: the full config inside an Instance (a failed load can
 * hide remote settings, so it is `unreadable`), the files on disk for commands that have none yet. */
export async function resolve(directory?: string): Promise<State> {
  try {
    return await loadedState()
  } catch {
    return instanceDirectory() ? "unreadable" : disabledState(directory)
  }
}

async function remoteMayDisable(local: boolean | undefined): Promise<boolean> {
  const wellKnown = await hasWellKnownAuth()
  if (local === undefined && wellKnown) return true

  const dbPath = Database.path()
  // An in-memory database belongs to the connection that opened it: this probe cannot see whether an
  // organization was selected there, so the answer is unknown.
  if (dbPath === ":memory:") return true

  // Only read a WAL database. In rollback-journal mode even a short SELECT
  // takes a shared lock that can block a writer's commit.
  const header = await fs.open(dbPath, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!header) return false
  try {
    const versions = Buffer.alloc(2)
    const { bytesRead } = await header.read(versions, 0, 2, 18)
    // An empty file is new: it holds no account yet. A short non-empty one is corrupt: unknown.
    if (bytesRead !== 2) return (await header.stat()).size > 0
    // A non-WAL database is not read (see above), so an organization it may hold is unknown: fail closed.
    if (versions[0] !== 2 || versions[1] !== 2) return true
  } finally {
    await header.close()
  }

  // A read-only open of a WAL database needs its -wal/-shm files, which SQLite removes when the last
  // connection closes cleanly (Linux, Windows). Without a -wal file every change is in the main file and
  // no writer is attached, so read it as immutable (which reports its journal mode as "delete").
  const immutable = !existsSync(`${dbPath}-wal`)
  const db = immutable
    ? // escapes `#`, `?`, `%`; URI parsing must be asked for explicitly where SQLite is built without it (Linux)
      new SQLite(`${pathToFileURL(dbPath).href}?immutable=1`, SQLiteConstants.SQLITE_OPEN_READONLY | SQLiteConstants.SQLITE_OPEN_URI)
    : new SQLite(dbPath, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 0")
    // If the journal mode changed since the header read, defer to the full loader.
    if (!immutable && db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "wal") return true
    const tables = db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('account', 'account_state') AND type = 'table'",
    ).get()
    // An immutable read is a snapshot: a writer that attached since (a -wal file appeared) may have
    // selected an organization, so the answer is unknown.
    const writerAttached = () => immutable && existsSync(`${dbPath}-wal`)
    if (tables?.count !== 2) return writerAttached() // A pre-migration database cannot select an organization.
    const modern = db.query("SELECT 1 FROM pragma_table_info('account_state') WHERE name = 'active_org_id'").get()
    // The earlier schema stored the selected org on the account row. The migration
    // copies that value into account_state, so it can still enable remote config.
    const orgColumn = modern ? "account_state.active_org_id" : "account.selected_org_id"
    const selected = db.query(`SELECT 1 FROM account_state
      JOIN account ON account.id = account_state.active_account_id
      WHERE account_state.id = 1 AND ${orgColumn} IS NOT NULL`).get() !== null
    return selected || writerAttached()
  } finally {
    db.close()
  }
}

/** `filesOnly` skips the remote and organization sources, for a caller whose loaded config already covers them. */
export async function disabledState(directory: string = process.cwd(), opts?: { filesOnly?: boolean }): Promise<State> {
  try {
    let value: boolean | undefined
    // Any source that fails to read, parse or validate fails Config's whole load, so the answer
    // is unknown however the other sources set it.
    let unknown = false
    // Managed config is merged after the remote and organization configs, so a setting there wins.
    let readingManaged = false
    let managedSetting = false
    const take = (data: unknown) => {
      const disabled = (data as { telemetry?: { disabled?: unknown } } | undefined)?.telemetry?.disabled
      if (disabled === undefined) return
      if (readingManaged) managedSetting = true
      if (typeof disabled !== "boolean") unknown = true
      else value = disabled
    }
    // Parse as the loader does (a missing `{file:}` reference is an error) and validate with the
    // loader's own schema step, so a source Config would reject cannot set the answer.
    const parse = async (text: string, input: string | { source: string; dir: string }) => {
      if (!text) return // the loader skips only an empty file; whitespace still goes to its parser
      const source = typeof input === "string" ? input : input.source
      try {
        take(validateLoaded(await ConfigPaths.parseText(text, input, "error", { track: false }), source))
      } catch {
        unknown = true
      }
    }
    const readFile = async (file: string) => {
      let text: string
      try {
        text = await fs.readFile(file, "utf-8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unknown = true
        return
      }
      await parse(text, file)
    }
    const readText = (text: string, source: string, dir: string) => parse(text, { source, dir })

    for (const file of GLOBAL_FILES) await readFile(path.join(Global.Path.config, file))
    // The legacy TOML global config, which Config merges after the JSON files (and migrates).
    const legacy = path.join(Global.Path.config, "config")
    try {
      take(Bun.TOML.parse(await fs.readFile(legacy, "utf-8")))
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unknown = true
    }
    if (Flag.OPENCODE_CONFIG) await readFile(Flag.OPENCODE_CONFIG)

    const worktree = worktreeOf(directory)
    const located = await Effect.runPromise(
      Effect.all([
        Flag.OPENCODE_DISABLE_PROJECT_CONFIG
          ? Effect.succeed([] as string[])
          : ConfigPaths.files("opencode", directory, worktree),
        ConfigPaths.directories(directory, worktree),
      ]).pipe(Effect.provide(FSUtil.defaultLayer)),
    )
    const [projectFiles, directories] = located
    for (const file of projectFiles) await readFile(file)
    for (const dir of directories) {
      if (dir.endsWith(".altimate-code") || dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
        for (const file of DIR_FILES) await readFile(path.join(dir, file))
      }
    }

    const inline = flagEnv("OPENCODE_CONFIG_CONTENT")
    if (inline) await readText(inline, "OPENCODE_CONFIG_CONTENT", directory)

    readingManaged = true
    const managedDir = ConfigManaged.managedConfigDir()
    if (existsSync(managedDir)) for (const file of DIR_FILES) await readFile(path.join(managedDir, file))
    const managed = await ConfigManaged.readManagedPreferences().catch(() => {
      unknown = true
      return undefined
    })
    if (managed) await readText(managed.text, managed.source, path.dirname(managed.source))

    if (unknown) return "unreadable"
    // The files themselves opt out: that stands, even if a remote config might turn it back on (fail closed).
    if (value === true) return "disabled"
    if (!opts?.filesOnly && !managedSetting && (await remoteMayDisable(value))) return "unreadable"
    return "enabled"
  } catch {
    return "unreadable"
  }
}

export * as TelemetryConfig from "./config-state"

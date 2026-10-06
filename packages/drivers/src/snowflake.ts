/**
 * Snowflake driver using the `snowflake-sdk` package.
 */

import * as fs from "fs"
import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"
import { loadOptionalDriver } from "./resolve"
import { emitBrowserSignIn, openInBrowser } from "./sign-in"

/**
 * Run `fn` with stdout/stderr writes swallowed for the (synchronous) duration of
 * the call, then restore. Used to keep snowflake-sdk's own logging off the
 * console — the SDK runs in-process with the interactive TUI, so any line it
 * writes corrupts the render. Only wrap synchronous calls so no concurrent
 * (TUI) output is ever caught in the window.
 */
export function silenceConsole<T>(fn: () => T): T {
  // Save the exact original method references (no .bind — binding would create a
  // new wrapper and we'd never restore the true original). They retain correct
  // `this` when re-assigned as a property of process.stdout/stderr.
  const out = process.stdout.write
  const err = process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    return fn()
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

/**
 * Suppress snowflake-sdk's Winston console logging.
 *
 * The SDK logs via Winston with a Console transport (additionalLogToConsole
 * defaults to true) and emits a "Configuring logger with level: ..." line at INFO
 * whenever `configure()` runs while a console transport is live — that is how our
 * own OFF call leaked a JSON log line into the TUI. We therefore run `configure()`
 * with the console silenced so its self-confirmation can never reach the display.
 * Call this both before any SDK use and again after connect(), since Snowflake
 * "Easy Logging" can re-raise the level from a client-config file during connect.
 */
export function suppressSnowflakeLogging(snowflake: any): void {
  if (typeof snowflake?.configure !== "function") return
  silenceConsole(() => {
    try {
      snowflake.configure({ logLevel: "OFF", additionalLogToConsole: false })
    } catch {
      // Older SDK versions may not support these options; ignore.
    }
  })
}

/**
 * Errors meaning the session is gone: 407002 is raised client-side for any
 * request on a terminated connection; 390111 (session no longer exists),
 * 390112 (session expired) and 390114 (session token expired) come from the
 * server. They do NOT prove the statement never ran: 407002 is also what the
 * SDK returns when it polls for the result of a statement Snowflake already
 * accepted. Whether a statement may be sent again is `isRetrySafe`'s call.
 */
const CLOSED_SESSION_CODES = new Set(["407002", "390111", "390112", "390114"])

export function isClosedConnectionError(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "")
  if (CLOSED_SESSION_CODES.has(code)) return true
  return /unable to perform operation using terminated connection/i.test(String((err as Error)?.message ?? err))
}

/** Leading `--` / `//` line comments and block comments, which can precede a statement's first keyword. */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const next = s.replace(/^\s+/, "").replace(/^(--|\/\/)[^\n]*(\n|$)/, "").replace(/^\/\*[\s\S]*?\*\//, "")
    if (next === s) return s
    s = next
  }
}

/** Keywords that change data, objects or the session, anywhere in a statement. Sequence generators and SYSTEM$
 * functions are included: `SELECT seq.NEXTVAL` advances a sequence, and several SYSTEM$ functions act. */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|COPY|CALL|PUT|GET|REMOVE|GRANT|REVOKE|UNDROP|EXECUTE|BEGIN|COMMIT|ROLLBACK|SET|UNSET|USE|NEXTVAL|GETNEXTVAL)\b|SYSTEM\$/i

/**
 * True when sending `sql` a second time cannot change anything: a single
 * read-only statement. A closed-session error can arrive after Snowflake already
 * accepted the statement (the SDK's result poll fails with 407002 once the
 * session drops, and the first execution keeps running server-side), so a
 * write is never resent. Errs toward false: a read the rule cannot recognise is
 * reported to the caller rather than retried.
 */
export function isRetrySafe(sql: string): boolean {
  const s = stripLeadingComments(sql).replace(/;\s*$/, "")
  if (s.includes(";")) return false // more than one statement
  if (/^(SHOW|DESCRIBE|DESC|EXPLAIN|LIST|LS)\b/i.test(s)) return true
  if (/^(SELECT|WITH|VALUES)\b/i.test(s)) return !WRITE_KEYWORDS.test(s.replace(/'(?:[^']|'')*'/g, "''"))
  return false
}

/** The statement with string literals emptied, so a `;` or keyword inside a literal is not mistaken for SQL. */
function withoutLiterals(sql: string): string {
  return stripLeadingComments(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/;\s*$/, "")
}

/** Starts like a session-scoped change: current database/schema/role/warehouse, a parameter or a variable. */
function looksLikeSessionChange(sql: string): boolean {
  return /^(USE|SET|UNSET|ALTER\s+SESSION)\b/i.test(stripLeadingComments(sql))
}

/**
 * A session setting that can be applied again to a new session with the same effect: one statement, with no
 * subquery, sequence or SYSTEM$ call in it. `SET v = (SELECT seq.NEXTVAL)` is a setting, but replaying it would
 * consume another value, so it is not one of these.
 */
export function isSessionSetting(sql: string): boolean {
  if (!looksLikeSessionChange(sql)) return false
  const s = withoutLiterals(sql)
  return !s.includes(";") && !/\(\s*SELECT\b|\bNEXTVAL\b|\bGETNEXTVAL\b|SYSTEM\$/i.test(s)
}

/** Opens a transaction, which a new session does not have. */
function opensTransaction(sql: string): boolean {
  return /^(BEGIN|START\s+TRANSACTION)\b/i.test(stripLeadingComments(sql))
}

/** Ends the open transaction. */
function endsTransaction(sql: string): boolean {
  return /^(COMMIT|ROLLBACK)\b/i.test(stripLeadingComments(sql))
}

/**
 * Session state that cannot be re-created by replaying a statement: temporary objects, an open transaction, and
 * session changes that are not safe to replay (several statements in one, or a value computed with side effects).
 */
export function holdsSessionState(sql: string): boolean {
  const s = stripLeadingComments(sql)
  return opensTransaction(sql) ||
    /^CREATE\s+(OR\s+REPLACE\s+)?(LOCAL\s+|GLOBAL\s+)?(TEMP|TEMPORARY|VOLATILE)\b/i.test(s) ||
    (looksLikeSessionChange(sql) && !isSessionSetting(sql))
}

/** Either kind: a statement whose effect lives only in the session. */
export function changesSession(sql: string): boolean {
  return isSessionSetting(sql) || holdsSessionState(sql)
}

/** Cap on remembered session settings; past it the session is treated as not replayable. */
const MAX_SESSION_SETTINGS = 100

/** Replay passes before settings that keep arriving during a reconnect are given up on. */
const MAX_REPLAY_PASSES = 5

/** `client_session_keep_alive` / `clientSessionKeepAlive`; on unless explicitly false. */
export function keepAliveSetting(config: ConnectionConfig): boolean {
  const value = config.client_session_keep_alive ?? config.clientSessionKeepAlive
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return true
}

/** How long `externalbrowser` SSO waits for the browser sign-in; the SDK's own default, made explicit so the notice states it. */
export const SSO_WAIT_MS = 120_000
/**
 * Upper bound on opening a non-interactive connection. The SDK retries a failed
 * login for at least 300 s (its `retryTimeout` floor), so a blocked network or a
 * proxy that drops packets shows as minutes of silence; this turns it into an error.
 */
export const CONNECT_TIMEOUT_MS = 120_000

/** True for the SDK's "the browser sign-in never came back" failure. */
export function isBrowserSignInTimeout(err: unknown): boolean {
  return /browser action timed out/i.test(String((err as Error)?.message ?? err))
}

function describeAccount(account: unknown): string {
  return typeof account === "string" && account ? ` for account '${account}'` : ""
}

/** `sdk` replaces the installed snowflake-sdk in tests; `seams.connectTimeoutMs` shortens the connect limit there. */
export async function connect(
  config: ConnectionConfig,
  sdk?: unknown,
  seams?: { connectTimeoutMs?: number },
): Promise<Connector> {
  const connectTimeoutMs = seams?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  let snowflake: any
  snowflake = sdk ?? (await loadOptionalDriver("snowflake", "snowflake-sdk"))
  snowflake = snowflake.default || snowflake

  // Suppress snowflake-sdk's Winston console logging as early as possible — it
  // writes JSON log lines into the interactive TUI output and corrupts the
  // display. Re-applied after connect() below (Easy Logging can re-raise it).
  suppressSnowflakeLogging(snowflake)

  let connection: any
  /** Kept from connect() so a dead connection can be reopened the same way. */
  let connectOptions: Record<string, unknown> | undefined
  let connectViaBrowser = false
  let reconnecting: Promise<void> | undefined
  /** Set by close(): a reconnect that finishes afterwards must not install a session nobody will close. */
  let closed = false
  /** Session settings that succeeded, in order, replayed onto every reopened connection before it is used. */
  const sessionSettings: string[] = []
  /** Counts installed connections. A statement remembers the generation it started in. */
  let generation = 0
  /** Counts explicit `connect()` calls. A result from before the latest one belongs to a session the caller chose to
   * replace, and is never carried onto the fresh one. */
  let epoch = 0
  /** The generation whose session holds state that cannot be replayed: temporary objects or unreplayable settings
   * (`tempIn`), and an open transaction (`txnIn`, cleared by COMMIT/ROLLBACK). */
  let tempIn: number | undefined
  let txnIn: number | undefined
  /** The generation at which that state was lost: statements that started before it are not run, because they
   * may depend on it; statements issued after it run on the new session. Never cleared by a late error. */
  let stateLostAt: number | undefined

  function openConnection(): Promise<any> {
    const account = connectOptions?.account
    if (connectViaBrowser) {
      // Set by the sign-in callback, so "completed"/"failed" is only reported
      // for an attempt that actually asked the user to sign in.
      let prompted = false
      if (connectOptions && connectOptions.authenticator === "EXTERNALBROWSER") {
        connectOptions.browserActionTimeout = SSO_WAIT_MS
        connectOptions.openExternalBrowserCallback = (url: string) => {
          prompted = true
          emitBrowserSignIn({ warehouse: "snowflake", account: String(account ?? ""), phase: "waiting", url, timeoutMs: SSO_WAIT_MS })
          openInBrowser(url)
        }
      }
      return new Promise<any>((resolve, reject) => {
        const conn = snowflake.createConnection(connectOptions)
        if (typeof conn.connectAsync !== "function") {
          reject(new Error("Snowflake browser/SSO auth requires snowflake-sdk with connectAsync support. Upgrade snowflake-sdk."))
          return
        }
        conn.connectAsync((err: Error | null) => {
          if (prompted) emitBrowserSignIn({ warehouse: "snowflake", account: String(account ?? ""), phase: err ? "failed" : "completed" })
          if (!err) return resolve(conn)
          if (isBrowserSignInTimeout(err)) {
            return reject(
              new Error(
                `Snowflake browser sign-in${describeAccount(account)} was not completed within ${SSO_WAIT_MS / 60_000} minutes. ` +
                  `A sign-in page was opened in the default browser (it may be behind other windows). ` +
                  `Ask the user to complete the sign-in, or to confirm a browser tab opened, before trying again; ` +
                  `retrying without that opens another sign-in page and waits again.`,
              ),
            )
          }
          reject(err)
        }).catch(reject)
      })
    }
    return new Promise<any>((resolve, reject) => {
      const conn = snowflake.createConnection(connectOptions)
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(
          new Error(
            `Snowflake did not accept the connection${describeAccount(account)} within ${Math.round(connectTimeoutMs / 1000)} seconds. ` +
              `The network may be blocking or proxying the connection (check VPN and proxy settings), or Snowflake is unreachable.`,
          ),
        )
        // Stop the SDK's own login retries (they run for at least 300 s); the late
        // callback below also destroys the connection if it gets through anyway.
        try {
          conn.destroy?.(() => {})
        } catch {
          // not started far enough to release
        }
      }, connectTimeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      conn.connect((err: Error | null) => {
        clearTimeout(timer)
        if (settled) {
          try {
            conn.destroy?.(() => {})
          } catch {
            // nothing to release
          }
          return
        }
        settled = true
        if (err) reject(err)
        else resolve(conn)
      })
    })
  }

  /** Replace a connection Snowflake has closed. Concurrent callers share one reconnect. */
  function reconnect(): Promise<void> {
    if (!reconnecting) {
      const previous = connection
      reconnecting = openConnection()
        .then(async (conn) => {
          const discard = () => {
            try {
              conn.destroy?.(() => {})
            } catch {
              // nothing to release
            }
          }
          // The session's settings are restored before anyone can use the connection, so every caller waiting on
          // this reconnect runs with them. Each pass replays a snapshot (a late setting may reorder the live list
          // mid-pass); a setting that completed on the old connection during a pass changes the list, so the list is
          // replayed again until a pass ends with it unchanged. Settings are safe to apply twice. Nothing awaits
          // between the last check and installing the connection below, so none can slip in after it.
          for (let pass = 0; ; pass++) {
            const snapshot = [...sessionSettings]
            for (const setting of snapshot) {
              try {
                await runQuery(conn, setting)
              } catch (err) {
                discard()
                throw new Error(
                  `Snowflake closed the session and its settings could not be restored on a new one (${setting}): ${(err as Error)?.message ?? err}`,
                )
              }
            }
            const unchanged = snapshot.length === sessionSettings.length && snapshot.every((v, i) => v === sessionSettings[i])
            if (unchanged) break
            if (pass >= MAX_REPLAY_PASSES) {
              // Settings keep arriving; treat the session as not restorable rather than install it half-applied.
              tempIn = generation
              break
            }
          }
          if (closed) {
            discard()
            throw new Error("Snowflake connection was closed while reconnecting")
          }
          generation++
          if (tempIn !== undefined || txnIn !== undefined) {
            stateLostAt = generation
            tempIn = undefined
            txnIn = undefined
          }
          connection = conn
          suppressSnowflakeLogging(snowflake)
          try {
            previous?.destroy?.(() => {})
          } catch {
            // already terminated — nothing to release
          }
        })
        .finally(() => {
          reconnecting = undefined
        })
    }
    return reconnecting
  }

  /** For a statement that started before the session holding temporary objects or a transaction was replaced. */
  function sessionLostError(cause: string): Error {
    return new Error(
      `Snowflake closed the session (${cause}), and its temporary objects or open transaction went with it, ` +
        `so this statement was not run on the new session. The connection has been reopened (session settings were restored); ` +
        `re-create what the statement depends on, then run it again.`,
    )
  }

  /** Whether a statement that started in generation `started` may depend on state that has since been lost. */
  function lostFor(started: number): boolean {
    return stateLostAt !== undefined && started < stateLostAt
  }

  /** Reopen before use when the SDK already knows the connection is gone (idle timeout, network drop, sleep). */
  async function ensureLive(): Promise<void> {
    if (reconnecting) return reconnecting
    if (connection && connectOptions && typeof connection.isUp === "function" && !connection.isUp()) {
      await reconnect()
    }
  }

  /**
   * Remember what a successful statement did to the session. `ranIn` is the generation it ran in: when another
   * statement has replaced the connection meanwhile, its effect is on a session that is gone. A late setting is
   * applied to the current session too; late state that cannot be replayed is reported to its caller.
   */
  async function noteSession(sql: string, binds: any[] | undefined, ranIn: number, ranInEpoch: number): Promise<void> {
    const replayable = isSessionSetting(sql) && !(binds && binds.length)
    // From before an explicit connect(): that session was replaced on purpose; nothing of it carries over.
    if (ranInEpoch !== epoch) return
    if (ranIn !== generation) {
      if (replayable) {
        // Not remembered (the list is full): the setting cannot be restored by a later reconnect.
        if (!rememberSetting(sql)) tempIn = generation
        await runQuery(connection, sql)
      } else if (holdsSessionState(sql) || (looksLikeSessionChange(sql) && !replayable)) {
        throw sessionLostError("it was replaced while this statement ran")
      }
      return
    }
    if (endsTransaction(sql)) txnIn = undefined
    else if (opensTransaction(sql)) txnIn = ranIn
    else if (replayable) {
      if (!rememberSetting(sql)) tempIn = ranIn
    } else if (holdsSessionState(sql) || looksLikeSessionChange(sql)) tempIn = ranIn
  }

  /** Adds a setting to the replay list, once (a repeat moves it to the end); false when the list is full. */
  function rememberSetting(sql: string): boolean {
    const at = sessionSettings.indexOf(sql)
    if (at >= 0) sessionSettings.splice(at, 1)
    else if (sessionSettings.length >= MAX_SESSION_SETTINGS) return false
    sessionSettings.push(sql)
    return true
  }

  function escapeSqlIdentifier(value: string): string {
    return value.replace(/"/g, '""')
  }

  /**
   * Run a statement. When Snowflake has closed the session, the connection is
   * reopened and a read-only statement is retried once; a write is not, because
   * it may already have run (see `isRetrySafe`).
   */
  async function executeQuery(sql: string, binds?: any[]): Promise<{ columns: string[]; rows: any[][] }> {
    // Captured before any wait: a statement queued behind a reconnect started on the old session's assumptions.
    const started = generation
    const startedInEpoch = epoch
    await ensureLive()
    if (lostFor(started)) throw sessionLostError("it had expired")
    const used = connection
    const ranIn = generation
    try {
      const result = await runQuery(used, sql, binds)
      await noteSession(sql, binds, ranIn, startedInEpoch)
      return result
    } catch (err) {
      if (!connectOptions || !isClosedConnectionError(err)) throw err
      // Reopen only if the failed connection is still the current one: a late error from a connection
      // another statement already replaced must not tear down its replacement.
      if (connection === used) await reconnect()
      else if (reconnecting) await reconnecting
      const cause = String((err as Error)?.message ?? err)
      if (lostFor(started)) throw sessionLostError(cause)
      // A session setting is safe to apply twice, and must be applied for the statements that follow it.
      if (!isRetrySafe(sql) && !isSessionSetting(sql)) {
        throw new Error(
          `Snowflake closed the session while this statement was running, so it was not run again: it may change data ` +
            `and could already have run. The connection has been reopened; check the result before running it again. (${cause})`,
        )
      }
      const ranAgainIn = generation
      const result = await runQuery(connection, sql, binds)
      await noteSession(sql, binds, ranAgainIn, startedInEpoch)
      return result
    }
  }

  function runQuery(conn: any, sql: string, binds?: any[]): Promise<{ columns: string[]; rows: any[][] }> {
    return new Promise((resolve, reject) => {
      const options: Record<string, any> = {
        sqlText: sql,
        complete(err: Error | null, _stmt: any, rows: any[]) {
          if (err) return reject(err)
          if (!rows || rows.length === 0) {
            return resolve({ columns: [], rows: [] })
          }
          const rawColumns = Object.keys(rows[0])
          const columns = rawColumns.map((col) => col.toLowerCase())
          const mapped = rows.map((row) =>
            rawColumns.map((col) => row[col]),
          )
          resolve({ columns, rows: mapped })
        },
      }
      if (binds && binds.length > 0) options.binds = binds
      conn.execute(options)
    })
  }

  return {
    async connect() {
      closed = false
      // A fresh session: nothing recorded for an earlier one applies to it.
      sessionSettings.length = 0
      tempIn = undefined
      txnIn = undefined
      stateLostAt = undefined
      generation++
      epoch++
      const options: Record<string, unknown> = {
        account: config.account,
        username: config.user ?? config.username,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        role: config.role,
        // Without it Snowflake ends an idle session (the master token lasts
        // four hours), and every later statement fails with "terminated
        // connection" until the process restarts. The heartbeat does not
        // resume a suspended warehouse.
        clientSessionKeepAlive: keepAliveSetting(config),
      }

      // ---------------------------------------------------------------
      // Normalize field names: accept snake_case (dbt), camelCase (SDK),
      // and common LLM-generated variants so auth "just works".
      // Note: normalizeConfig() in normalize.ts handles most aliases
      // upstream, but these fallbacks provide defense-in-depth.
      // ---------------------------------------------------------------
      const keyPath = (config.private_key_path ?? config.privateKeyPath) as string | undefined
      const inlineKey = (config.private_key ?? config.privateKey) as string | undefined
      const keyPassphrase = (config.private_key_passphrase ?? config.privateKeyPassphrase ?? config.privateKeyPass) as string | undefined
      const oauthToken = (config.token ?? config.access_token) as string | undefined
      const oauthClientId = (config.oauth_client_id ?? config.oauthClientId) as string | undefined
      const oauthClientSecret = (config.oauth_client_secret ?? config.oauthClientSecret) as string | undefined
      const authenticator = (config.authenticator as string | undefined)?.trim()
      const authUpper = authenticator?.toUpperCase()
      const passcode = config.passcode as string | undefined

      // ---------------------------------------------------------------
      // 1. Key-pair auth (SNOWFLAKE_JWT)
      //    Accepts: private_key_path (file), private_key (inline PEM or
      //    file path auto-detected), privateKey, privateKeyPath.
      // ---------------------------------------------------------------
      // Resolve private_key: could be a file path or PEM content
      let resolvedKeyPath = keyPath
      let resolvedInlineKey = inlineKey
      if (!resolvedKeyPath && resolvedInlineKey && !resolvedInlineKey.includes("-----BEGIN")) {
        // Looks like a file path, not PEM content
        if (fs.existsSync(resolvedInlineKey)) {
          resolvedKeyPath = resolvedInlineKey
          resolvedInlineKey = undefined
        } else {
          throw new Error(
            `Snowflake private key: '${resolvedInlineKey}' is not a valid file path or PEM content. ` +
            `Use 'private_key_path' for file paths or provide PEM content starting with '-----BEGIN PRIVATE KEY-----'.`,
          )
        }
      }

      if (resolvedKeyPath || resolvedInlineKey) {
        let keyContent: string
        if (resolvedKeyPath) {
          if (!fs.existsSync(resolvedKeyPath)) {
            throw new Error(`Snowflake private key file not found: ${resolvedKeyPath}`)
          }
          keyContent = fs.readFileSync(resolvedKeyPath, "utf-8")
        } else {
          keyContent = resolvedInlineKey!
          // Normalize escaped newlines from env vars / JSON configs
          if (keyContent.includes("\\n")) {
            keyContent = keyContent.replace(/\\n/g, "\n")
          }
        }

        // If key is encrypted, decrypt using Node crypto —
        // snowflake-sdk expects unencrypted PKCS#8 PEM.
        let privateKey: string
        if (keyPassphrase || keyContent.includes("ENCRYPTED")) {
          const crypto = await import("crypto")
          try {
            const keyObject = crypto.createPrivateKey({
              key: keyContent,
              format: "pem",
              passphrase: keyPassphrase || undefined,
            })
            privateKey = keyObject
              .export({ type: "pkcs8", format: "pem" })
              .toString()
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            throw new Error(
              `Snowflake: Failed to decrypt private key. Verify the passphrase and key format (must be PEM/PKCS#8). ${msg}`,
            )
          }
        } else {
          privateKey = keyContent
        }

        options.authenticator = "SNOWFLAKE_JWT"
        options.privateKey = privateKey

      // ---------------------------------------------------------------
      // 2. External browser SSO
      //    Interactive — opens user's browser for IdP login. Requires
      //    connectAsync() instead of connect().
      // ---------------------------------------------------------------
      } else if (authUpper === "EXTERNALBROWSER") {
        options.authenticator = "EXTERNALBROWSER"

      // ---------------------------------------------------------------
      // 3. Okta native SSO (authenticator is an Okta URL)
      // ---------------------------------------------------------------
      } else if (authenticator && /^https?:\/\/.+\.okta\.com/i.test(authenticator)) {
        options.authenticator = authenticator
        if (config.password) options.password = config.password

      // ---------------------------------------------------------------
      // 4. OAuth token auth
      //    Triggered by: authenticator="oauth", OR token/access_token
      //    present without a password.
      // ---------------------------------------------------------------
      } else if (authUpper === "OAUTH" || (oauthToken && !config.password)) {
        if (!oauthToken) {
          throw new Error(
            "Snowflake OAuth authenticator specified but no token provided (expected 'token' or 'access_token')",
          )
        }
        options.authenticator = "OAUTH"
        options.token = oauthToken

      // ---------------------------------------------------------------
      // 5. JWT / Programmatic access token (pre-generated)
      //    The Node.js snowflake-sdk only accepts pre-generated tokens
      //    via the OAUTH authenticator. SNOWFLAKE_JWT expects a privateKey
      //    for self-signing, and PROGRAMMATIC_ACCESS_TOKEN is not recognized.
      //    Alias both to OAUTH so the token is passed correctly.
      // ---------------------------------------------------------------
      } else if (authUpper === "JWT" || authUpper === "PROGRAMMATIC_ACCESS_TOKEN") {
        if (!oauthToken) {
          throw new Error(`Snowflake ${authenticator} authenticator specified but no token provided (expected 'token' or 'access_token')`)
        }
        options.authenticator = "OAUTH"
        options.token = oauthToken

      // ---------------------------------------------------------------
      // 7. Username + password + MFA
      // ---------------------------------------------------------------
      } else if (authUpper === "USERNAME_PASSWORD_MFA") {
        if (!config.password) {
          throw new Error("Snowflake USERNAME_PASSWORD_MFA authenticator requires 'password'")
        }
        options.authenticator = "USERNAME_PASSWORD_MFA"
        options.password = config.password
        if (passcode) options.passcode = passcode

      // ---------------------------------------------------------------
      // 8. Plain password auth (default)
      // ---------------------------------------------------------------
      } else if (config.password) {
        options.password = config.password
      }

      // Use connectAsync for browser-based auth (SSO/Okta), connect for everything else
      const isOktaUrl = authenticator && /^https?:\/\/.+\.okta\.com/i.test(authenticator)
      connectViaBrowser = Boolean(authUpper === "EXTERNALBROWSER" || isOktaUrl)
      connectOptions = options

      connection = await openConnection()

      // Re-apply suppression: Snowflake "Easy Logging" reads a client-config file
      // during connect() and can re-raise the log level (and re-attach a console
      // transport), defeating the suppression set before connect.
      suppressSnowflakeLogging(snowflake)
    },

    async execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)
      let query = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES|SHOW)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const result = await executeQuery(query, binds)
      const truncated = effectiveLimit > 0 && result.rows.length > effectiveLimit
      const rows = truncated
        ? result.rows.slice(0, effectiveLimit)
        : result.rows

      return {
        columns: result.columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await executeQuery("SHOW SCHEMAS")
      // SHOW SCHEMAS returns rows with a "name" column
      const nameIdx = result.columns.indexOf("name")
      if (nameIdx < 0) return result.rows.map((r) => String(r[0]))
      return result.rows.map((r) => String(r[nameIdx]))
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await executeQuery(
        `SHOW TABLES IN SCHEMA "${escapeSqlIdentifier(schema)}"`,
      )
      const nameIdx = result.columns.indexOf("name")
      const kindIdx = result.columns.indexOf("kind")
      return result.rows.map((r) => ({
        name: String(r[nameIdx >= 0 ? nameIdx : 0]),
        type: kindIdx >= 0 && String(r[kindIdx]).toLowerCase() === "view"
          ? "view"
          : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await executeQuery(
        `SHOW COLUMNS IN TABLE "${escapeSqlIdentifier(schema)}"."${escapeSqlIdentifier(table)}"`,
      )
      const nameIdx = result.columns.indexOf("column_name")
      const typeIdx = result.columns.indexOf("data_type")
      const nullIdx = result.columns.indexOf("is_nullable")

      return result.rows.map((r) => {
        let dataType = String(r[typeIdx >= 0 ? typeIdx : 1])
        // Snowflake SHOW COLUMNS returns JSON in data_type, parse it
        try {
          const parsed = JSON.parse(dataType)
          dataType = parsed.type ?? dataType
        } catch {
          // not JSON, use as-is
        }
        return {
          name: String(r[nameIdx >= 0 ? nameIdx : 0]),
          data_type: dataType,
          nullable:
            nullIdx >= 0 ? String(r[nullIdx]).toUpperCase() === "YES" : true,
        }
      })
    },

    async close() {
      closed = true
      await reconnecting?.catch(() => {})
      if (connection) {
        await new Promise<void>((resolve) => {
          connection.destroy((err: Error | null) => {
            resolve()
          })
        })
        connection = null
      }
    },
  }
}

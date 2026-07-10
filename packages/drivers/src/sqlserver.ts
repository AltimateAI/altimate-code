/**
 * SQL Server driver using the `mssql` (tedious) package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

// ---------------------------------------------------------------------------
// Azure AD helpers — cache + resource URL resolution
// ---------------------------------------------------------------------------

// Module-scoped token cache, keyed by `${resource}|${clientId ?? ""}`.
// Tokens are reused across `connect()` calls in the same process and refreshed
// a few minutes before expiry. Fixes the issue where every new connection
// fetched a fresh token (wasteful, risks throttling) and long-lived diffs
// failed silently when the embedded token hit its ~1h TTL.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // refresh 5 minutes before expiry
const TOKEN_FALLBACK_TTL_MS = 50 * 60 * 1000 // used when JWT has no exp claim

/**
 * Parse the `exp` claim from a JWT access token (milliseconds since epoch).
 * Returns undefined if the token isn't a JWT or has no exp claim.
 */
function parseTokenExpiry(token: string): number | undefined {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    const payload = parts[1]
    // base64url → base64 + padding
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payload.length % 4)) % 4)
    const decoded = Buffer.from(padded, "base64").toString("utf-8")
    const claims = JSON.parse(decoded)
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the Azure resource URL for token acquisition.
 *
 * Preference order:
 *   1. Explicit `config.azure_resource_url`.
 *   2. Inferred from host suffix (Azure Gov / China).
 *   3. Default Azure commercial cloud.
 *
 * The returned URL is guaranteed to end with `/` — callers append `.default`
 * to build the OAuth scope (e.g. `https://database.windows.net/.default`).
 * Without the trailing slash, an explicit user value like
 * `"https://custom-host"` would produce an invalid scope
 * `"https://custom-host.default"` and `credential.getToken` would fail.
 */
function resolveAzureResourceUrl(config: ConnectionConfig): string {
  const explicit = config.azure_resource_url as string | undefined
  const raw = explicit ?? (() => {
    const host = (config.host as string | undefined) ?? ""
    if (host.includes(".usgovcloudapi.net") || host.includes(".datawarehouse.fabric.microsoft.us")) {
      return "https://database.usgovcloudapi.net/"
    }
    if (host.includes(".chinacloudapi.cn")) {
      return "https://database.chinacloudapi.cn/"
    }
    return "https://database.windows.net/"
  })()
  return raw.endsWith("/") ? raw : `${raw}/`
}

/** Visible for testing: reset the module-scoped token cache. */
export function _resetTokenCacheForTests(): void {
  tokenCache.clear()
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mssql: any
  let MssqlConnectionPool: any
  try {
    // @ts-expect-error — mssql has no type declarations; installed as optional peerDependency
    const mod = await import("mssql")
    mssql = mod.default || mod
    // ConnectionPool is a named export, not on .default
    MssqlConnectionPool = mod.ConnectionPool ?? mssql.ConnectionPool
  } catch {
    throw new Error(
      "SQL Server driver not installed. Run: npm install mssql",
    )
  }

  let pool: any

  return {
    async connect() {
      const mssqlConfig: Record<string, unknown> = {
        server: config.host ?? "127.0.0.1",
        port: config.port ?? 1433,
        database: config.database,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trust_server_certificate ?? true,
          connectTimeout: 10000,
          requestTimeout: 30000,
        },
        pool: {
          max: 5,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      }

      // Normalize shorthand auth values to tedious-compatible types
      const AUTH_SHORTHANDS: Record<string, string> = {
        cli: "azure-active-directory-default",
        default: "azure-active-directory-default",
        password: "azure-active-directory-password",
        "service-principal": "azure-active-directory-service-principal-secret",
        serviceprincipal: "azure-active-directory-service-principal-secret",
        "managed-identity": "azure-active-directory-msi-vm",
        msi: "azure-active-directory-msi-vm",
      }
      // `config.authentication` is typed as unknown upstream — accept only
      // strings here. A caller passing a non-string (object, null, pre-built
      // auth block) shouldn't crash with "toLowerCase is not a function";
      // treat as "no shorthand requested" and leave authType undefined.
      const rawAuth = config.authentication
      const authType =
        typeof rawAuth === "string"
          ? (AUTH_SHORTHANDS[rawAuth.toLowerCase()] ?? rawAuth)
          : undefined

      if (authType?.startsWith("azure-active-directory")) {
        ;(mssqlConfig.options as any).encrypt = true

        // Resolve a raw Azure AD access token.
        // Used by both `azure-active-directory-default` and by
        // `azure-active-directory-access-token` when no token was provided.
        //
        // We acquire the token ourselves rather than letting tedious do it because:
        //  1. Bun can resolve @azure/identity to the browser bundle (inside
        //     tedious or even our own import), where DefaultAzureCredential
        //     is a non-functional stub that throws.
        //  2. Passing a credential object via type:"token-credential" hits a
        //     CJS/ESM isTokenCredential boundary mismatch in Bun.
        //
        // Strategy: try @azure/identity first (works when module resolution
        // is correct), fall back to shelling out to `az account get-access-token`
        // (works everywhere Azure CLI is installed).
        //
        // Tokens are cached module-scope keyed by (resource, client_id) and
        // refreshed 5 minutes before expiry — reuses tokens across connections
        // and prevents silent failures when embedded tokens hit their TTL.
        const resourceUrl = resolveAzureResourceUrl(config)
        const clientId = (config.azure_client_id as string | undefined) ?? ""
        const cacheKey = `${resourceUrl}|${clientId}`

        const acquireAzureToken = async (): Promise<string> => {
          const cached = tokenCache.get(cacheKey)
          if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
            return cached.token
          }

          let token: string | undefined
          let expiresAt: number | undefined
          let azureIdentityError: unknown = null
          let azCliStderr = ""

          try {
            // @azure/identity is an optional peer dependency — dynamic import so users
            // who don't use Azure AD don't need to install it. Typed `any` (via a non-literal
            // specifier) so it compiles regardless of which @azure/identity version (if any) is
            // installed; the runtime API is resolved from the user's installed package.
            const azureIdentity: any = await import("@azure/identity" as string)
            const credential = new azureIdentity.DefaultAzureCredential(
              config.azure_client_id
                ? { managedIdentityClientId: config.azure_client_id as string }
                : undefined,
            )
            const tokenResponse = await credential.getToken(`${resourceUrl}.default`)
            if (tokenResponse?.token) {
              token = tokenResponse.token
              // @azure/identity provides expiresOnTimestamp (ms). Prefer it; fall
              // back to parsing the JWT exp claim so both paths share the cache.
              expiresAt = tokenResponse.expiresOnTimestamp ?? parseTokenExpiry(tokenResponse.token)
            }
          } catch (err) {
            azureIdentityError = err
            // @azure/identity unavailable or browser bundle — fall through to CLI
          }

          if (!token) {
            try {
              // Use async `execFile` (NOT `exec`/`execSync`):
              //   - `execFile` skips the shell entirely and passes args as an
              //     array, preventing shell interpolation when `resourceUrl`
              //     comes from user config (e.g. `"https://x/;other-cmd"`).
              //   - async keeps the connect path non-blocking during the
              //     multi-second `az` round trip.
              const childProcess = await import("node:child_process")
              const { promisify } = await import("node:util")
              const execFileAsync = promisify(childProcess.execFile)
              // Restrict the inherited environment so unrelated secrets in the caller's
              // env (e.g. DATABRICKS_TOKEN, cloud provider keys) are NOT passed to `az`
              // or any `az` extension. Pass through only the PATH/HOME essentials and
              // Azure-specific variables `az` actually needs.
              const restrictedEnv: NodeJS.ProcessEnv = {}
              for (const k of [
                "PATH", "HOME", "USER", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
                "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "AZURE_CORE_NO_COLOR",
                "SYSTEMROOT", "TEMP", "TMP", "LANG", "LC_ALL",
              ]) {
                const v = process.env[k]
                if (v !== undefined) restrictedEnv[k] = v
              }
              const { stdout } = await execFileAsync(
                "az",
                [
                  "account", "get-access-token",
                  "--resource", resourceUrl,
                  "--query", "accessToken",
                  "-o", "tsv",
                ],
                { encoding: "utf-8", timeout: 15000, env: restrictedEnv },
              )
              const out = String(stdout).trim()
              if (out) {
                token = out
                expiresAt = parseTokenExpiry(out)
              }
            } catch (err: any) {
              // Capture stderr so the final error message can hint at the root cause
              // (e.g. "Please run 'az login'", "subscription not found").
              azCliStderr = String(err?.stderr ?? err?.message ?? "").slice(0, 200).trim()
            }
          }

          if (!token) {
            const hints: string[] = []
            if (azureIdentityError) hints.push(`@azure/identity: ${String(azureIdentityError).slice(0, 120)}`)
            if (azCliStderr) hints.push(`az CLI: ${azCliStderr}`)
            const detail = hints.length > 0 ? ` (${hints.join("; ")})` : ""
            throw new Error(
              `Azure AD token acquisition failed${detail}. Either install @azure/identity (npm install @azure/identity) ` +
              "or log in with Azure CLI (az login).",
            )
          }

          tokenCache.set(cacheKey, {
            token,
            expiresAt: expiresAt ?? Date.now() + TOKEN_FALLBACK_TTL_MS,
          })
          return token
        }

        if (authType === "azure-active-directory-default") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token: await acquireAzureToken() },
          }
        } else if (authType === "azure-active-directory-password") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-password",
            options: {
              userName: config.user,
              password: config.password,
              clientId: config.azure_client_id,
              tenantId: config.azure_tenant_id,
            },
          }
        } else if (authType === "azure-active-directory-access-token") {
          // If the caller supplied a token, use it; otherwise acquire one
          // automatically (DefaultAzureCredential → az CLI).
          const suppliedToken = (config.token ?? config.access_token) as string | undefined
          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token: suppliedToken ?? (await acquireAzureToken()) },
          }
        } else if (
          authType === "azure-active-directory-msi-vm" ||
          authType === "azure-active-directory-msi-app-service"
        ) {
          mssqlConfig.authentication = {
            type: authType,
            options: {
              ...(config.azure_client_id ? { clientId: config.azure_client_id } : {}),
            },
          }
        } else if (authType === "azure-active-directory-service-principal-secret") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-service-principal-secret",
            options: {
              clientId: config.azure_client_id,
              clientSecret: config.azure_client_secret,
              tenantId: config.azure_tenant_id,
            },
          }
        } else {
          // Any other `azure-active-directory-*` subtype (typo or future
          // tedious addition). Fail fast — otherwise we'd silently connect
          // with no `authentication` block and tedious would surface an
          // opaque error far from the root cause.
          throw new Error(
            `Unsupported Azure AD authentication subtype: "${authType}". ` +
            "Supported subtypes: azure-active-directory-default, " +
            "azure-active-directory-password, azure-active-directory-access-token, " +
            "azure-active-directory-msi-vm, azure-active-directory-msi-app-service, " +
            "azure-active-directory-service-principal-secret.",
          )
        }
      } else {
        // Standard SQL Server user/password
        mssqlConfig.user = config.user
        mssqlConfig.password = config.password
      }

      // Use an explicit ConnectionPool (not the global mssql.connect()) so
      // multiple simultaneous connections to different servers are isolated.
      // `mssql@^12` guarantees ConnectionPool as a named export — if it's
      // missing, the installed driver version is too old. Fail fast rather
      // than silently use the global shared pool (which reintroduces the
      // cross-database interference bug this branch was added to fix).
      if (!MssqlConnectionPool) {
        throw new Error(
          "mssql.ConnectionPool is not available — the installed `mssql` package is too old. Upgrade to mssql@^12.",
        )
      }
      pool = new MssqlConnectionPool(mssqlConfig)
      await pool.connect()
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

      let query = sql
      const isSelectLike = /^\s*SELECT\b/i.test(sql)
      // SQL Server uses TOP, not LIMIT
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bTOP\b/i.test(sql) &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        // Insert TOP after SELECT
        query = sql.replace(
          /^(\s*SELECT\s)/i,
          `$1TOP ${effectiveLimit + 1} `,
        )
      }

      const result = await pool.request().query(query)
      const recordset = result.recordset ?? []
      const truncated = effectiveLimit > 0 && recordset.length > effectiveLimit
      const limitedRecordset = truncated ? recordset.slice(0, effectiveLimit) : recordset

      // mssql merges unnamed columns (e.g. SELECT COUNT(*), SUM(...)) into a
      // single array under the empty-string key: row[""] = [val1, val2, ...].
      // When a query mixes named and unnamed columns (e.g.
      // SELECT name, COUNT(*), SUM(x) → { name: "alice", "": [42, 100] }),
      // we must preserve the known header for `name` and synthesize col_N only
      // for the unnamed positions. Build columns and rows in a single pass so
      // they stay aligned regardless of how many unnamed values the row
      // contains.
      let columns: string[] = []
      let columnsBuilt = false
      const flatten = (row: any): any[] => {
        const vals: any[] = []
        let unnamedCounter = 0
        const entries = Object.entries(row)
        for (const [k, v] of entries) {
          if (k === "" && Array.isArray(v)) {
            for (const inner of v) {
              if (!columnsBuilt) columns.push(`col_${unnamedCounter}`)
              unnamedCounter++
              vals.push(inner)
            }
          } else if (k === "") {
            // Empty-string key with non-array value — rare edge case, give it
            // a synthetic name rather than producing a column named "".
            if (!columnsBuilt) columns.push(`col_${unnamedCounter}`)
            unnamedCounter++
            vals.push(v)
          } else {
            if (!columnsBuilt) columns.push(k)
            vals.push(v)
          }
        }
        columnsBuilt = true
        return vals
      }

      const rows = limitedRecordset.map(flatten)
      if (!columnsBuilt) {
        // No rows — fall back to driver-reported column metadata.
        columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : []
      }

      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await pool
        .request()
        .query(
          "SELECT name FROM sys.schemas WHERE name NOT IN ('guest','INFORMATION_SCHEMA','sys') ORDER BY name",
        )
      return result.recordset.map((r: any) => r.name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await pool
        .request()
        .input("schema", schema)
        .query(
          `SELECT t.name, t.type
           FROM sys.tables t
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = @schema
           UNION ALL
           SELECT v.name, 'V' as type
           FROM sys.views v
           INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
           WHERE s.name = @schema
           ORDER BY name`,
        )
      return result.recordset.map((r: any) => ({
        name: r.name as string,
        type: r.type?.trim() === "V" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await pool
        .request()
        .input("schema", schema)
        .input("table", table)
        .query(
          `SELECT c.name AS column_name,
                  tp.name AS data_type,
                  c.is_nullable
           FROM sys.columns c
           INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
           INNER JOIN sys.objects o ON c.object_id = o.object_id
           INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
           WHERE s.name = @schema AND o.name = @table
             AND o.type IN ('U', 'V')
           ORDER BY c.column_id`,
        )
      return result.recordset.map((r: any) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === 1,
      }))
    },

    async close() {
      if (pool) {
        await pool.close()
        pool = null
      }
    },
  }
}

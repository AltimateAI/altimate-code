/**
 * Snowflake driver using the `snowflake-sdk` package.
 */

import * as fs from "fs"
import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let snowflake: any
  try {
    snowflake = await import("snowflake-sdk")
    snowflake = snowflake.default || snowflake
  } catch {
    throw new Error(
      "Snowflake driver not installed. Run: bun add snowflake-sdk",
    )
  }

  let connection: any

  function executeQuery(sql: string): Promise<{ columns: string[]; rows: any[][] }> {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText: sql,
        complete(err: Error | null, _stmt: any, rows: any[]) {
          if (err) return reject(err)
          if (!rows || rows.length === 0) {
            return resolve({ columns: [], rows: [] })
          }
          const columns = Object.keys(rows[0])
          const mapped = rows.map((row) =>
            columns.map((col) => row[col]),
          )
          resolve({ columns, rows: mapped })
        },
      })
    })
  }

  return {
    async connect() {
      const options: Record<string, unknown> = {
        account: config.account,
        username: config.user ?? config.username,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        role: config.role,
      }

      // ---------------------------------------------------------------
      // Normalize field names: accept snake_case (dbt), camelCase (SDK),
      // and common LLM-generated variants so auth "just works".
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
      const useBrowserAuth = authUpper === "EXTERNALBROWSER" || isOktaUrl

      connection = await new Promise<any>((resolve, reject) => {
        const conn = snowflake.createConnection(options)
        if (useBrowserAuth) {
          if (typeof conn.connectAsync !== "function") {
            reject(new Error("Snowflake browser/SSO auth requires snowflake-sdk with connectAsync support. Upgrade snowflake-sdk."))
            return
          }
          conn.connectAsync((err: Error | null) => {
            if (err) reject(err)
            else resolve(conn)
          }).catch(reject)
        } else {
          conn.connect((err: Error | null) => {
            if (err) reject(err)
            else resolve(conn)
          })
        }
      })
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000
      let query = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES|SHOW)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const result = await executeQuery(query)
      const truncated = result.rows.length > effectiveLimit
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
        `SHOW TABLES IN SCHEMA "${schema.replace(/"/g, '""')}"`,
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
        `SHOW COLUMNS IN TABLE "${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`,
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

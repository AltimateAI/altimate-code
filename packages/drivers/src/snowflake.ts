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

      // Key-pair auth
      if (config.private_key_path) {
        const keyPath = config.private_key_path as string
        if (!fs.existsSync(keyPath)) {
          throw new Error(`Snowflake private key file not found: ${keyPath}`)
        }
        const keyContent = fs.readFileSync(keyPath, "utf-8")

        // If key is encrypted (has ENCRYPTED in header or passphrase provided),
        // decrypt it using Node crypto — snowflake-sdk expects unencrypted PEM.
        let privateKey: string
        if (config.private_key_passphrase || keyContent.includes("ENCRYPTED")) {
          const crypto = await import("crypto")
          const keyObject = crypto.createPrivateKey({
            key: keyContent,
            format: "pem",
            passphrase: (config.private_key_passphrase as string) || undefined,
          })
          privateKey = keyObject
            .export({ type: "pkcs8", format: "pem" })
            .toString()
        } else {
          privateKey = keyContent
        }

        options.authenticator = "SNOWFLAKE_JWT"
        options.privateKey = privateKey
      } else if (config.password) {
        options.password = config.password
      }

      connection = await new Promise<any>((resolve, reject) => {
        const conn = snowflake.createConnection(options)
        conn.connect((err: Error | null) => {
          if (err) reject(err)
          else resolve(conn)
        })
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

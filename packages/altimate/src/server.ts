import type { Connector } from "@altimateai/drivers/types"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import path from "node:path"
import { classifyAndCheck } from "./sql-classify"
import { ClaudeInstructions } from "./instructions"
import { Gateway } from "./gateway"

const Warehouse = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literal("duckdb"),
})

const QueryResult = Schema.Struct({
  warehouse: Schema.String,
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.Json)),
  row_count: Schema.Number,
  truncated: Schema.Boolean,
})

export const Altimate = Plugin.define({
  id: "altimate",
  async setup(ctx) {
    await ClaudeInstructions.setup(ctx)
    await Gateway.setup(ctx)
    const storageKey = `warehouses:${ctx.location.project.id}:${encodeURIComponent(ctx.location.directory)}:${ctx.location.workspaceID ?? "local"}`
    const warehouses = new Map(
      Schema.decodeUnknownSync(Schema.Array(Warehouse))((await ctx.storage.get(storageKey)) ?? []).map((warehouse) => [
        warehouse.name,
        warehouse,
      ]),
    )
    // Plugin setup is Location-scoped, so each map belongs to this Location.
    const connections = new Map<string, Promise<Connector>>()

    function connection(name: string) {
      const warehouse = warehouses.get(name)
      if (!warehouse) throw new Error(`Warehouse "${name}" is not registered.`)
      const cached = connections.get(name)
      if (cached) return cached
      const pending = (async () => {
        const { connect } = await import("@altimateai/drivers/duckdb")
        const connector = await connect(warehouse)
        await connector.connect()
        return connector
      })().catch((error: unknown) => {
        connections.delete(name)
        throw error
      })
      connections.set(name, pending)
      return pending
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "warehouse_add",
        description: "Register a DuckDB warehouse using an existing database path or :memory:.",
        input: Schema.Struct({ name: Schema.String, path: Schema.String }),
        output: Schema.Struct({ warehouses: Schema.Array(Warehouse) }),
        options: { codemode: false },
        async execute(input, context) {
          context.signal.throwIfAborted()
          if (!input.name.trim()) throw new Error("Warehouse name must not be empty.")
          if (!input.path.trim())
            throw new Error("DuckDB path must not be empty; use :memory: for a temporary warehouse.")
          const existing = connections.get(input.name)
          if (existing) await (await existing).close()
          connections.delete(input.name)
          warehouses.set(input.name, {
            name: input.name,
            path: input.path === ":memory:" ? input.path : path.resolve(ctx.location.directory, input.path),
            type: "duckdb",
          })
          const output = { warehouses: Array.from(warehouses.values()) }
          await ctx.storage.set(storageKey, output.warehouses)
          return { output, metadata: output, content: `Registered DuckDB warehouse "${input.name}".` }
        },
      })

      editor.add({
        name: "sql_execute",
        description: "Execute SQL against a registered warehouse, returning structured rows and a text table.",
        input: Schema.Struct({
          warehouse: Schema.String,
          sql: Schema.String,
          limit: Schema.optional(Schema.Number),
        }),
        output: QueryResult,
        options: { codemode: false },
        async execute(input, context) {
          context.signal.throwIfAborted()
          const classification = classifyAndCheck(input.sql)
          if (classification.blocked) {
            throw new Error(
              "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.",
            )
          }
          // Preserve the v1 action/resource naming and let rejection end the step.
          if (classification.queryType === "write") {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "sql_execute_write",
              resources: [input.sql.slice(0, 200)],
              save: ["*"],
              metadata: { queryType: classification.queryType, warehouse: input.warehouse },
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
          }
          if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
            throw new Error("Query limit must be a positive integer.")
          }
          const connector = await connection(input.warehouse)
          context.signal.throwIfAborted()
          await context.progress({ warehouse: input.warehouse, status: "executing" })
          const result = await connector.execute(input.sql, input.limit ?? 100, undefined, { signal: context.signal })
          context.signal.throwIfAborted()
          const output = {
            warehouse: input.warehouse,
            ...result,
            rows: result.rows.map((row) => row.map(jsonValue)),
          }
          return { output, metadata: output, content: formatResult(output) }
        },
      })

      editor.add({
        name: "schema_inspect",
        description: "List a registered warehouse's tables and columns.",
        input: Schema.Struct({ warehouse: Schema.String }),
        output: Schema.Struct({
          warehouse: Schema.String,
          tables: Schema.Array(
            Schema.Struct({
              schema: Schema.String,
              name: Schema.String,
              type: Schema.String,
              columns: Schema.Array(
                Schema.Struct({
                  name: Schema.String,
                  data_type: Schema.String,
                  nullable: Schema.Boolean,
                }),
              ),
            }),
          ),
        }),
        options: { codemode: false },
        async execute(input, context) {
          context.signal.throwIfAborted()
          const connector = await connection(input.warehouse)
          const schemas = await connector.listSchemas()
          const tables = await Promise.all(
            [...new Set(schemas)].map(async (schema) =>
              Promise.all(
                (await connector.listTables(schema)).map(async (table) => ({
                  schema,
                  ...table,
                  columns: await connector.describeTable(schema, table.name),
                })),
              ),
            ),
          )
          context.signal.throwIfAborted()
          const output = { warehouse: input.warehouse, tables: tables.flat() }
          return {
            output,
            metadata: output,
            content: output.tables.length
              ? output.tables
                  .map(
                    (table) =>
                      `${table.schema}.${table.name}: ${table.columns.map((column) => `${column.name} ${column.data_type}`).join(", ")}`,
                  )
                  .join("\n")
              : "(0 tables)",
          }
        },
      })
    })

    return async () => {
      await Promise.all(Array.from(connections.values()).map(async (pending) => (await pending).close()))
      connections.clear()
    }
  },
})

export default Altimate

function jsonValue(value: unknown): Schema.Json {
  if (value === undefined || value === null) return null
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  return String(value)
}

function formatResult(result: typeof QueryResult.Type) {
  if (result.row_count === 0) return "(0 rows)"
  const header = result.columns.join(" | ")
  const separator = result.columns.map((column) => "-".repeat(Math.max(column.length, 4))).join("-+-")
  const rows = result.rows
    .map((row) => row.map((value) => (value === null ? "NULL" : String(value))).join(" | "))
    .join("\n")
  return `${header}\n${separator}\n${rows}\n\n(${result.row_count} rows)${result.truncated ? " [truncated]" : ""}`
}

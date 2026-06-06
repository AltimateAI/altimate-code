/**
 * BigQuery driver using the `@google-cloud/bigquery` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, CostEstimate, ExecuteOptions, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let BigQueryModule: any
  try {
    BigQueryModule = await import("@google-cloud/bigquery")
  } catch {
    throw new Error(
      "BigQuery driver not installed. Run: npm install @google-cloud/bigquery",
    )
  }

  const BigQuery = BigQueryModule.BigQuery ?? BigQueryModule.default?.BigQuery
  let client: any

  return {
    async connect() {
      const options: Record<string, unknown> = {}
      if (config.project) options.projectId = config.project
      if (config.credentials_json) {
        try {
          options.credentials = typeof config.credentials_json === "string"
            ? JSON.parse(config.credentials_json as string)
            : config.credentials_json
        } catch (e) {
          throw new Error(`Failed to parse credentials_json: ${e}`)
        }
      } else if (config.credentials_path) {
        options.keyFilename = config.credentials_path
      }
      if (config.location) options.location = config.location

      client = new BigQuery(options)
    },

    async execute(sql: string, limit?: number, binds?: any[], execOptions?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = execOptions?.noLimit ? 0 : (limit ?? 1000)
      const query = sql.replace(/;\s*$/, "")
      const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)

      // BigQuery does not allow appending LIMIT to parameterized queries.
      // Use maxResults instead — it limits rows returned at the API level.
      const options: Record<string, unknown> = { query }
      if (isSelectLike && effectiveLimit && !/\bLIMIT\b/i.test(sql)) {
        options.maxResults = effectiveLimit + 1
      }
      if (binds?.length) options.params = binds
      if (config.dataset) {
        options.defaultDataset = {
          datasetId: config.dataset,
          projectId: config.project,
        }
      }

      const [rows] = await client.query(options)
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows

      return {
        columns,
        rows: limitedRows.map((row: any) =>
          columns.map((col) => row[col]),
        ),
        row_count: limitedRows.length,
        truncated,
      }
    },

    // Estimate scan cost via a BigQuery dry-run. The dry-run validates and
    // plans the query server-side and returns the exact bytes it would
    // process, without running it or incurring charges. This is the most
    // accurate pre-flight estimate available for any warehouse.
    async estimateCost(sql: string): Promise<CostEstimate> {
      const query = sql.replace(/;\s*$/, "")
      const options: Record<string, unknown> = { query, dryRun: true }
      if (config.dataset) {
        options.defaultDataset = {
          datasetId: config.dataset,
          projectId: config.project,
        }
      }
      const [job] = await client.createQueryJob(options)
      const stats = job.metadata?.statistics ?? {}
      // BigQuery reports total bytes processed at the statistics root and,
      // redundantly, under statistics.query — prefer whichever is present.
      const raw = stats.totalBytesProcessed ?? stats.query?.totalBytesProcessed
      const bytesScanned = raw != null ? Number(raw) : undefined
      return {
        bytesScanned: Number.isFinite(bytesScanned) ? bytesScanned : undefined,
        note: "BigQuery dry-run (exact bytes processed)",
      }
    },

    async listSchemas(): Promise<string[]> {
      const [datasets] = await client.getDatasets()
      return datasets.map((ds: any) => ds.id as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const dataset = client.dataset(schema)
      const [tables] = await dataset.getTables()
      return tables.map((t: any) => ({
        name: t.id as string,
        type: t.metadata?.type === "VIEW" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const [metadata] = await client
        .dataset(schema)
        .table(table)
        .getMetadata()
      const fields = metadata.schema?.fields ?? []
      return fields.map((f: any) => ({
        name: f.name as string,
        data_type: f.type as string,
        nullable: f.mode !== "REQUIRED",
      }))
    },

    async close() {
      // BigQuery client doesn't have a persistent connection to close
      client = null
    },
  }
}

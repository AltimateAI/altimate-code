import { AltimateApi } from "./client"

/** One parent relation handed to the backend: its warehouse location and its columns. */
export type SqlLineageModelNode = {
  database: string
  schema: string
  name: string
  alias: string
  uniqueId: string
  columns: Record<string, { name: string; description: string; data_type: string; meta: unknown }>
  path: string | undefined
}

export type SqlLineageRequest = {
  compiled_sql: string
  model_info: { model_node: SqlLineageModelNode }[]
  model_dialect: string
  session_id: string
}

/**
 * One node of the backend's graph, keyed in `details` by an id that edges use. A CTE or the final select carries `sql`; a relation, join, filter, group, sort or
 * subquery carries `expression`. A relation, subquery, CTE and the final select have a `name`; a join, filter, group or sort has none.
 */
export type SqlLineageNodeDetails = {
  name?: string
  type: string
  nodeType?: string
  nodeId?: string
  sql?: string
  expression?: string
  /** A relation's warehouse database (catalog) and schema. */
  db?: string
  schema?: string
  columns?: { name: string; datatype?: string; expression?: string }[]
}

export type SqlLineageResponse = {
  tableEdges: [string, string][]
  details: Record<string, SqlLineageNodeDetails>
  nodePositions?: Record<string, [number, number]>
}

export const SQL_LINEAGE_ENDPOINT = "/dbt/v3/sql_lineage"

/** The backend's graph of a compiled model's CTEs, joins and filters. */
export async function sqlLineage(req: SqlLineageRequest): Promise<SqlLineageResponse> {
  return (await AltimateApi.apiRequest("POST", SQL_LINEAGE_ENDPOINT, req)) as SqlLineageResponse
}

/**
 * PII detection — uses altimate-core's classifyPii() plus schema cache
 * for warehouse-specific PII detection on cached metadata.
 */

import * as core from "@altimateai/altimate-core"
import { getCache } from "./cache"
import * as Registry from "../connections/registry"
import type {
  PiiDetectParams,
  PiiDetectResult,
  PiiFinding,
} from "../types"

/**
 * Detect PII in cached schema metadata by running altimate-core's
 * classifyPii() on column names and types.
 */
export async function detectPii(params: PiiDetectParams): Promise<PiiDetectResult> {
  const cache = await getCache()
  const status = cache.cacheStatus()

  // Determine which warehouses to scan
  let targetWarehouses = status.warehouses
  if (params.warehouse) {
    targetWarehouses = targetWarehouses.filter((w) => w.name === params.warehouse)
  }

  if (targetWarehouses.length === 0) {
    // Fallback: if a warehouse is specified but not cached, try live introspection
    if (params.warehouse) {
      return detectPiiLive(params)
    }
    return {
      success: true,
      findings: [],
      finding_count: 0,
      columns_scanned: 0,
      by_category: {},
      tables_with_pii: 0,
    }
  }

  const findings: PiiFinding[] = []
  let columnsScanned = 0
  const tablesWithPii = new Set<string>()

  for (const wh of targetWarehouses) {
    // List all columns in this warehouse
    const columns = cache.listColumns(wh.name, 10000)

    for (const col of columns) {
      if (params.schema_name && col.schema_name !== params.schema_name) continue
      if (params.table && col.table !== params.table) continue

      columnsScanned++

      // Build a minimal schema context for this column and use classifyPii
      const schemaContext = {
        tables: {
          [col.table]: {
            columns: [
              { name: col.name, type: col.data_type || "VARCHAR" },
            ],
          },
        },
        version: "1",
      }

      try {
        const schema = core.Schema.fromJson(JSON.stringify(schemaContext))
        const result = core.classifyPii(schema)
        const piiData = JSON.parse(JSON.stringify(result))

        if (piiData && piiData.findings && piiData.findings.length > 0) {
          for (const finding of piiData.findings) {
            findings.push({
              warehouse: col.warehouse,
              schema: col.schema_name,
              table: col.table,
              column: col.name,
              data_type: col.data_type,
              pii_category: finding.category || finding.pii_type || "UNKNOWN",
              confidence: finding.confidence || "medium",
            })
            tablesWithPii.add(`${col.warehouse}.${col.schema_name}.${col.table}`)
          }
        }
      } catch {
        // classifyPii may not find PII — that is expected
      }
    }
  }

  // Summarize by category
  const byCategory: Record<string, number> = {}
  for (const f of findings) {
    byCategory[f.pii_category] = (byCategory[f.pii_category] || 0) + 1
  }

  return {
    success: true,
    findings,
    finding_count: findings.length,
    columns_scanned: columnsScanned,
    by_category: byCategory,
    tables_with_pii: tablesWithPii.size,
  }
}

/**
 * Fallback: detect PII via live introspection when the schema is not cached.
 */
async function detectPiiLive(params: PiiDetectParams): Promise<PiiDetectResult> {
  if (!params.warehouse) {
    return {
      success: true,
      findings: [],
      finding_count: 0,
      columns_scanned: 0,
      by_category: {},
      tables_with_pii: 0,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const config = Registry.getConfig(params.warehouse)
    const warehouseType = config?.type || "unknown"

    const schemas = params.schema_name
      ? [params.schema_name]
      : await connector.listSchemas()

    const findings: PiiFinding[] = []
    let columnsScanned = 0
    const tablesWithPii = new Set<string>()

    for (const schemaName of schemas) {
      if (schemaName.toUpperCase() === "INFORMATION_SCHEMA") continue

      const tables = params.table
        ? [{ name: params.table, type: "TABLE" }]
        : await connector.listTables(schemaName)

      for (const tableInfo of tables) {
        const columns = await connector.describeTable(schemaName, tableInfo.name)

        const schemaContext = {
          tables: {
            [tableInfo.name]: {
              columns: columns.map((c) => ({
                name: c.name,
                type: c.data_type,
              })),
            },
          },
          version: "1",
        }

        columnsScanned += columns.length

        try {
          const schema = core.Schema.fromJson(JSON.stringify(schemaContext))
          const result = core.classifyPii(schema)
          const piiData = JSON.parse(JSON.stringify(result))

          if (piiData?.findings) {
            for (const finding of piiData.findings) {
              findings.push({
                warehouse: params.warehouse!,
                schema: schemaName,
                table: tableInfo.name,
                column: finding.column || "",
                data_type: finding.data_type,
                pii_category: finding.category || finding.pii_type || "UNKNOWN",
                confidence: finding.confidence || "medium",
              })
              tablesWithPii.add(`${params.warehouse}.${schemaName}.${tableInfo.name}`)
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const byCategory: Record<string, number> = {}
    for (const f of findings) {
      byCategory[f.pii_category] = (byCategory[f.pii_category] || 0) + 1
    }

    return {
      success: true,
      findings,
      finding_count: findings.length,
      columns_scanned: columnsScanned,
      by_category: byCategory,
      tables_with_pii: tablesWithPii.size,
    }
  } catch (e) {
    return {
      success: false,
      findings: [],
      finding_count: 0,
      columns_scanned: 0,
      by_category: {},
      tables_with_pii: 0,
    }
  }
}

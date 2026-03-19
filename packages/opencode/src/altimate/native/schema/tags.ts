/**
 * Snowflake metadata tags — query TAG_REFERENCES for object-level tags.
 */

import * as Registry from "../connections/registry"
import type {
  TagsGetParams,
  TagsGetResult,
  TagsListParams,
  TagsListResult,
} from "../types"

// ---------------------------------------------------------------------------
// SQL templates (Snowflake-specific)
// ---------------------------------------------------------------------------

const SNOWFLAKE_TAG_REFERENCES_SQL = `
SELECT
    tag_database,
    tag_schema,
    tag_name,
    tag_value,
    object_database,
    object_schema,
    object_name,
    column_name,
    domain as object_type
FROM TABLE(INFORMATION_SCHEMA.TAG_REFERENCES_ALL_COLUMNS(?, 'TABLE'))
{tag_filter}
ORDER BY tag_name, object_name
LIMIT ?
`

const SNOWFLAKE_TAG_LIST_SQL = `
SELECT
    tag_database,
    tag_schema,
    tag_name,
    tag_owner,
    created
FROM SNOWFLAKE.ACCOUNT_USAGE.TAGS
WHERE deleted IS NULL
ORDER BY tag_name
LIMIT ?
`

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function getWhType(warehouse: string): string {
  const warehouses = Registry.list().warehouses
  const wh = warehouses.find((w) => w.name === warehouse)
  return wh?.type || "unknown"
}

/**
 * Get tags on a specific object (Snowflake TAG_REFERENCES).
 */
export async function getTags(params: TagsGetParams): Promise<TagsGetResult> {
  const whType = getWhType(params.warehouse)
  if (whType !== "snowflake") {
    return {
      success: false,
      tags: [],
      tag_count: 0,
      tag_summary: {},
      error: `Tag queries are only available for Snowflake warehouses (got: ${whType}).`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)

    const limit = params.limit || 100
    let sql: string
    let binds: any[] = []

    if (params.object_name) {
      binds = [params.object_name]
      const tagFilter = params.tag_name
        ? (binds.push(params.tag_name), "WHERE tag_name = ?")
        : ""
      binds.push(limit)
      sql = SNOWFLAKE_TAG_REFERENCES_SQL.replace("{tag_filter}", tagFilter)
    } else {
      // Fall back to listing all tags
      binds = [limit]
      sql = SNOWFLAKE_TAG_LIST_SQL
    }

    const result = await connector.execute(sql, limit, binds)
    const tags = result.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    })

    // Summarize by tag name
    const tagSummary: Record<string, number> = {}
    for (const tag of tags) {
      const name = String(tag.tag_name || tag.TAG_NAME || "unknown")
      tagSummary[name] = (tagSummary[name] || 0) + 1
    }

    return {
      success: true,
      tags,
      tag_count: tags.length,
      tag_summary: tagSummary,
    }
  } catch (e) {
    return {
      success: false,
      tags: [],
      tag_count: 0,
      tag_summary: {},
      error: String(e),
    }
  }
}

/**
 * List all available tags in a Snowflake account.
 */
export async function listTags(params: TagsListParams): Promise<TagsListResult> {
  const whType = getWhType(params.warehouse)
  if (whType !== "snowflake") {
    return {
      success: false,
      tags: [],
      tag_count: 0,
      error: `Tag queries are only available for Snowflake warehouses (got: ${whType}).`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const limit = params.limit || 100
    const sql = SNOWFLAKE_TAG_LIST_SQL

    const result = await connector.execute(sql, limit, [limit])
    const tags = result.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    })

    return {
      success: true,
      tags,
      tag_count: tags.length,
    }
  } catch (e) {
    return {
      success: false,
      tags: [],
      tag_count: 0,
      error: String(e),
    }
  }
}

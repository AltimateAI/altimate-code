/**
 * Unit tests for schema-resolver format normalization.
 *
 * These tests verify the flat-to-SchemaDefinition conversion logic
 * WITHOUT requiring the @altimateai/altimate-core napi binary.
 * The actual Schema.fromJson() call is tested in altimate-core-native.test.ts.
 */

import { describe, expect, test } from "bun:test"

// We can't import the functions directly because the module imports
// @altimateai/altimate-core at the top level. Instead, we test the
// pure conversion logic by extracting it into testable form.

/**
 * Detect whether a schema_context object is in SchemaDefinition format.
 */
function isSchemaDefinitionFormat(ctx: Record<string, any>): boolean {
  if (!("tables" in ctx) || typeof ctx.tables !== "object" || ctx.tables === null) {
    return false
  }
  const values = Object.values(ctx.tables)
  if (values.length === 0) return true
  return values.some((v: any) => Array.isArray(v?.columns))
}

/**
 * Convert flat schema format to SchemaDefinition format.
 */
function flatToSchemaDefinition(flat: Record<string, any>): Record<string, any> {
  const tables: Record<string, any> = {}
  for (const [tableName, colsOrDef] of Object.entries(flat)) {
    if (colsOrDef === null || colsOrDef === undefined) continue
    if (Array.isArray(colsOrDef)) {
      const columns = colsOrDef.map((c: any) => ({
        name: c.name,
        type: c.type ?? c.data_type ?? "VARCHAR",
      }))
      tables[tableName] = { columns }
    } else if (typeof colsOrDef === "object") {
      if (Array.isArray(colsOrDef.columns)) {
        tables[tableName] = colsOrDef
      } else {
        const columns = Object.entries(colsOrDef).map(([colName, colType]) => ({
          name: colName,
          type: String(colType),
        }))
        tables[tableName] = { columns }
      }
    }
  }
  return { tables }
}

function normalizeSchemaContext(ctx: Record<string, any>): string {
  if (isSchemaDefinitionFormat(ctx)) {
    return JSON.stringify(ctx)
  }
  return JSON.stringify(flatToSchemaDefinition(ctx))
}

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

describe("isSchemaDefinitionFormat", () => {
  test("detects SchemaDefinition format", () => {
    expect(isSchemaDefinitionFormat({
      tables: { users: { columns: [{ name: "id", type: "INT" }] } },
    })).toBe(true)
  })

  test("detects SchemaDefinition with version/dialect", () => {
    expect(isSchemaDefinitionFormat({
      version: "1",
      dialect: "generic",
      tables: { users: { columns: [{ name: "id", type: "INT" }] } },
    })).toBe(true)
  })

  test("detects SchemaDefinition with empty tables map", () => {
    expect(isSchemaDefinitionFormat({
      tables: {},
    })).toBe(true)
  })

  test("rejects flat format", () => {
    expect(isSchemaDefinitionFormat({
      users: { id: "INT", name: "VARCHAR" },
    })).toBe(false)
  })

  test("rejects array format", () => {
    expect(isSchemaDefinitionFormat({
      users: [{ name: "id", data_type: "INT" }],
    })).toBe(false)
  })

  test("rejects flat schema with table named 'tables'", () => {
    // A flat schema that happens to have a table called "tables"
    // should NOT be mistaken for SchemaDefinition format
    expect(isSchemaDefinitionFormat({
      tables: { id: "INT", name: "VARCHAR" },
      users: { id: "INT", email: "VARCHAR" },
    })).toBe(false)
  })

  test("rejects empty object", () => {
    expect(isSchemaDefinitionFormat({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Flat Format Conversion
// ---------------------------------------------------------------------------

describe("flatToSchemaDefinition", () => {
  test("converts flat map format", () => {
    const result = flatToSchemaDefinition({
      customers: { customer_id: "INTEGER", name: "VARCHAR", email: "VARCHAR" },
      orders: { order_id: "INTEGER", amount: "DECIMAL" },
    })

    expect(result.tables).toBeDefined()
    expect(result.tables.customers.columns).toHaveLength(3)
    expect(result.tables.customers.columns).toContainEqual({ name: "customer_id", type: "INTEGER" })
    expect(result.tables.customers.columns).toContainEqual({ name: "name", type: "VARCHAR" })
    expect(result.tables.orders.columns).toHaveLength(2)
  })

  test("converts array-of-columns format (lineage_check style)", () => {
    const result = flatToSchemaDefinition({
      users: [
        { name: "id", data_type: "INT" },
        { name: "email", data_type: "VARCHAR" },
      ],
    })

    expect(result.tables.users.columns).toHaveLength(2)
    expect(result.tables.users.columns).toContainEqual({ name: "id", type: "INT" })
    expect(result.tables.users.columns).toContainEqual({ name: "email", type: "VARCHAR" })
  })

  test("passes through partial SchemaDefinition format", () => {
    const result = flatToSchemaDefinition({
      users: { columns: [{ name: "id", type: "INT" }] },
    })

    expect(result.tables.users.columns).toEqual([{ name: "id", type: "INT" }])
  })

  test("handles mixed formats", () => {
    const result = flatToSchemaDefinition({
      flat_table: { id: "INT", name: "VARCHAR" },
      array_table: [{ name: "id", data_type: "BIGINT" }],
      sd_table: { columns: [{ name: "id", type: "INT" }] },
    })

    expect(result.tables.flat_table.columns).toHaveLength(2)
    expect(result.tables.array_table.columns).toHaveLength(1)
    expect(result.tables.sd_table.columns).toHaveLength(1)
  })

  test("skips null/undefined values", () => {
    const result = flatToSchemaDefinition({
      valid: { id: "INT" },
      invalid: null,
    })

    expect(Object.keys(result.tables)).toEqual(["valid"])
  })

  test("handles array-of-columns with type field", () => {
    const result = flatToSchemaDefinition({
      users: [
        { name: "id", type: "INT" },
        { name: "name", type: "VARCHAR" },
      ],
    })

    expect(result.tables.users.columns).toContainEqual({ name: "id", type: "INT" })
  })
})

// ---------------------------------------------------------------------------
// End-to-End Normalization
// ---------------------------------------------------------------------------

describe("normalizeSchemaContext", () => {
  test("passes through SchemaDefinition format unchanged", () => {
    const ctx = {
      version: "1",
      tables: {
        users: { columns: [{ name: "id", type: "INT" }] },
      },
    }
    const result = JSON.parse(normalizeSchemaContext(ctx))
    expect(result.version).toBe("1")
    expect(result.tables.users.columns[0].name).toBe("id")
  })

  test("converts flat format to SchemaDefinition", () => {
    const ctx = {
      customers: { customer_id: "INTEGER", name: "VARCHAR" },
    }
    const result = JSON.parse(normalizeSchemaContext(ctx))
    expect(result.tables).toBeDefined()
    expect(result.tables.customers.columns).toContainEqual({ name: "customer_id", type: "INTEGER" })
  })

  test("produces valid JSON for Rust SchemaDefinition deserialization", () => {
    const ctx = {
      customers: {
        customer_id: "INTEGER",
        first_name: "VARCHAR",
        last_name: "VARCHAR",
        email: "VARCHAR",
      },
    }
    const json = normalizeSchemaContext(ctx)
    const parsed = JSON.parse(json)

    // Must have `tables` key
    expect(parsed.tables).toBeDefined()
    // Each table must have `columns` array
    expect(Array.isArray(parsed.tables.customers.columns)).toBe(true)
    // Each column must have `name` and `type`
    for (const col of parsed.tables.customers.columns) {
      expect(typeof col.name).toBe("string")
      expect(typeof col.type).toBe("string")
    }
  })

  test("schema_diff scenario: two different schemas normalize correctly", () => {
    const schema1 = {
      customers: {
        customer_id: "INTEGER",
        first_name: "VARCHAR",
        last_name: "VARCHAR",
        email: "VARCHAR",
      },
    }
    const schema2 = {
      customers: {
        customer_id: "INTEGER",
        full_name: "VARCHAR",
        email: "VARCHAR",
        phone: "VARCHAR",
      },
    }

    const s1 = JSON.parse(normalizeSchemaContext(schema1))
    const s2 = JSON.parse(normalizeSchemaContext(schema2))

    // Schema 1 columns
    const s1Cols = s1.tables.customers.columns.map((c: any) => c.name).sort()
    expect(s1Cols).toEqual(["customer_id", "email", "first_name", "last_name"])

    // Schema 2 columns
    const s2Cols = s2.tables.customers.columns.map((c: any) => c.name).sort()
    expect(s2Cols).toEqual(["customer_id", "email", "full_name", "phone"])

    // These are clearly different — the diff engine should find changes
    expect(s1Cols).not.toEqual(s2Cols)
  })
})

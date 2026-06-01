/**
 * Unit tests for Trino driver logic:
 * - client configuration
 * - LIMIT injection and truncation
 * - Trino result iteration
 * - catalog-scoped introspection SQL
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

let mockCreateCalls: any[] = []
let mockQueryCalls: string[] = []
let mockResults: any[][] = []

function resetMocks() {
  mockCreateCalls = []
  mockQueryCalls = []
  mockResults = []
}

function iteratorFor(results: any[]) {
  let idx = 0
  let last: any
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (idx < results.length) {
        last = results[idx++]
        return { value: last, done: false }
      }
      return { value: last, done: true }
    },
  }
}

mock.module("trino-client", () => ({
  BasicAuth: class {
    username: string
    password: string
    constructor(username: string, password: string) {
      this.username = username
      this.password = password
    }
  },
  Trino: {
    create: (options: any) => {
      mockCreateCalls.push(options)
      return {
        query: async (sql: string) => {
          mockQueryCalls.push(sql)
          return iteratorFor(mockResults.shift() ?? [])
        },
      }
    },
  },
}))

const { connect } = await import("../src/trino")

describe("Trino driver unit tests", () => {
  beforeEach(() => {
    resetMocks()
  })

  test("configures server, catalog, schema, token headers, and source", async () => {
    const connector = await connect({
      type: "trino",
      host: "trino.example.com",
      port: 8443,
      protocol: "https",
      catalog: "iceberg",
      schema: "analytics",
      user: "analyst",
      access_token: "jwt-token",
      source: "unit-test",
    })
    await connector.connect()

    expect(mockCreateCalls[0].server).toBe("https://trino.example.com:8443")
    expect(mockCreateCalls[0].catalog).toBe("iceberg")
    expect(mockCreateCalls[0].schema).toBe("analytics")
    expect(mockCreateCalls[0].source).toBe("unit-test")
    expect(mockCreateCalls[0].extraHeaders.Authorization).toBe("Bearer jwt-token")
    expect(mockCreateCalls[0].extraHeaders["X-Trino-User"]).toBe("analyst")
  })

  test("uses BasicAuth when password is configured", async () => {
    const connector = await connect({ type: "trino", user: "analyst", password: "secret" })
    await connector.connect()
    expect(mockCreateCalls[0].auth.username).toBe("analyst")
    expect(mockCreateCalls[0].auth.password).toBe("secret")
  })

  test("appends LIMIT to SELECT and detects truncation", async () => {
    mockResults = [[{ columns: [{ name: "id", type: "integer" }], data: [[1], [2], [3]] }]]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    const result = await connector.execute("SELECT id FROM orders", 2)
    expect(mockQueryCalls[0]).toBe("SELECT id FROM orders\nLIMIT 3")
    expect(result.columns).toEqual(["id"])
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
  })

  test("does not double-limit or limit write statements", async () => {
    mockResults = [[{ columns: [{ name: "id", type: "integer" }], data: [[1]] }], [{ data: [] }]]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    await connector.execute("SELECT id FROM orders LIMIT 5", 2)
    expect(mockQueryCalls[0]).toBe("SELECT id FROM orders LIMIT 5")

    await connector.execute("INSERT INTO t VALUES (1)", 2)
    expect(mockQueryCalls[1]).toBe("INSERT INTO t VALUES (1)")
  })

  test("throws when both password and access_token are configured", async () => {
    const connector = await connect({ type: "trino", user: "analyst", password: "secret", access_token: "jwt" })
    await expect(connector.connect()).rejects.toThrow(/only one authentication method/i)
  })

  test("does not inject LIMIT for FETCH NEXT queries", async () => {
    mockResults = [[{ columns: [{ name: "id", type: "integer" }], data: [[1]] }]]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    await connector.execute("SELECT id FROM orders OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY", 2)
    expect(mockQueryCalls[0]).toBe("SELECT id FROM orders OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY")
  })

  test("does not inject LIMIT or truncate when noLimit is set", async () => {
    mockResults = [[{ columns: [{ name: "id", type: "integer" }], data: [[1], [2], [3]] }]]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    const result = await connector.execute("SELECT id FROM orders", 2, undefined, { noLimit: true })
    expect(mockQueryCalls[0]).toBe("SELECT id FROM orders")
    expect(result.rows).toEqual([[1], [2], [3]])
    expect(result.truncated).toBe(false)
  })

  test("never interpolates a non-numeric limit into the query", async () => {
    mockResults = [[{ columns: [{ name: "id", type: "integer" }], data: [[1]] }]]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    await connector.execute("SELECT id FROM orders", Number("not-a-number"))
    expect(mockQueryCalls[0]).toBe("SELECT id FROM orders")
    expect(mockQueryCalls[0]).not.toContain("NaN")
  })

  test("falls back to default port when port is non-numeric", async () => {
    const connector = await connect({ type: "trino", host: "trino.example.com", port: "oops" as unknown as number })
    await connector.connect()
    expect(mockCreateCalls[0].server).toBe("http://trino.example.com:8080")
  })

  test("listTables and describeTable use catalog-scoped information_schema", async () => {
    mockResults = [
      [
        {
          columns: [
            { name: "table_name", type: "varchar" },
            { name: "table_type", type: "varchar" },
          ],
          data: [["orders", "BASE TABLE"]],
        },
      ],
      [
        {
          columns: [
            { name: "column_name", type: "varchar" },
            { name: "data_type", type: "varchar" },
            { name: "is_nullable", type: "varchar" },
          ],
          data: [["id", "integer", "NO"]],
        },
      ],
    ]
    const connector = await connect({ type: "trino", catalog: "iceberg" })
    await connector.connect()

    await expect(connector.listTables("analytics")).resolves.toEqual([{ name: "orders", type: "table" }])
    expect(mockQueryCalls[0]).toContain('FROM "iceberg".information_schema.tables')
    expect(mockQueryCalls[0]).toContain("table_schema = 'analytics'")

    await expect(connector.describeTable("analytics", "orders")).resolves.toEqual([
      { name: "id", data_type: "integer", nullable: false },
    ])
    expect(mockQueryCalls[1]).toContain('FROM "iceberg".information_schema.columns')
    expect(mockQueryCalls[1]).toContain("table_name = 'orders'")
  })
})

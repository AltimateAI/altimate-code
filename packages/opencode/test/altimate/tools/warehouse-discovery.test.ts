import { describe, expect, mock, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import type { ExecuteOptions } from "@altimateai/drivers/types"
import { resolveQueryTimeout } from "@altimateai/drivers/query-timeout"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { Dispatcher } from "../../../src/altimate/native"
import { discoverCatalog, isLocalConnection } from "../../../src/altimate/tools/warehouse-discovery"

describe("isLocalConnection", () => {
  test("local SQLite/DuckDB stores are local; remote store schemes are not", () => {
    expect(isLocalConnection({ type: "sqlite", path: "/data/app.sqlite" })).toBe(true)
    expect(isLocalConnection({ type: "duckdb", path: ":memory:" })).toBe(true)
    expect(isLocalConnection({ type: "duckdb", path: "file:///data/w.duckdb" })).toBe(true)
    expect(isLocalConnection({ type: "duckdb", path: "md:my_db" })).toBe(false)
    expect(isLocalConnection({ type: "duckdb", path: "s3://bucket/w.duckdb" })).toBe(false)
    expect(isLocalConnection({ type: "sqlite" })).toBe(false)
  })

  test("servers count as local only on a loopback host or a socket", () => {
    expect(isLocalConnection({ type: "postgres", host: "localhost" })).toBe(true)
    expect(isLocalConnection({ type: "postgresql", host: "127.0.0.1" })).toBe(true)
    expect(isLocalConnection({ type: "postgres", host: "/var/run/postgresql" })).toBe(true)
    expect(isLocalConnection({ type: "mongodb", connection_string: "mongodb://localhost:27017" })).toBe(true)
    expect(isLocalConnection({ type: "postgres", host: "db.example.com" })).toBe(false)
    expect(isLocalConnection({ type: "mongodb", connection_string: "mongodb+srv://cluster.example.net" })).toBe(false)
    expect(isLocalConnection({ type: "postgres" })).toBe(false)
  })

  test("other engines are never local", () => {
    expect(isLocalConnection({ type: "snowflake", host: "localhost" })).toBe(false)
    expect(isLocalConnection({ type: "bigquery" })).toBe(false)
    expect(isLocalConnection(undefined)).toBe(false)
  })
})

for (const type of ["sqlite", "duckdb"]) {
  test(`${type}: bounded sample has no added timeout and retains caller cancellation`, async () => {
    Registry.setConfigs({ local: { type, path: ":memory:" } })
    const caller = new AbortController()
    let relayedCancellation = false
    const execute = mock(async (_sql: string, _limit?: number, _binds?: unknown[], options?: ExecuteOptions) => {
      caller.abort()
      relayedCancellation = options?.signal?.aborted === true
      return { rows: [[7]], columns: ["id"], row_count: 1, truncated: false }
    })
    const get = spyOn(Registry, "get").mockResolvedValue({ execute } as unknown as Connector)
    const call = spyOn(Dispatcher, "call").mockImplementation(async (method: string, params: any) => {
      if (method === "schema.inspect") return { columns: [{ name: "id", data_type: "INTEGER" }] } as any
      return params.schema_name
        ? { tables: [{ schema: "main", name: "items", type: "table" }] } as any
        : { schemas: [{ name: "main", table_count: 1 }] } as any
    })
    const timeout = spyOn(AbortSignal, "timeout")
    try {
      await discoverCatalog([{ name: "local", type }], { signal: caller.signal, sessionID: "sample-test" }).catch(() => {})
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0].slice(0, 3)).toEqual(['SELECT * FROM "main"."items" LIMIT 1', 1, undefined])
      expect(relayedCancellation).toBe(true)
      expect(execute.mock.calls[0][3]?.queryTimeoutMs).toBe(resolveQueryTimeout(Registry.getConfig("local")).ms)
      expect(execute.mock.calls[0][3]?.signal?.aborted).toBe(true)
      expect(timeout).not.toHaveBeenCalled()
    } finally {
      timeout.mockRestore()
      call.mockRestore()
      get.mockRestore()
      Registry.reset()
    }
  })
}

for (const type of ["sqlite", "duckdb"]) {
  for (const mode of ["table", "view", "over-limit"]) {
    test(`${type}: discovery ${mode} samples only base tables within the catalog gate`, async () => {
      Registry.setConfigs({ local: { type, path: ":memory:" } })
      const execute = mock(async (_sql: string, _limit?: number, _binds?: unknown[], _options?: ExecuteOptions) => ({
        rows: [[7]], columns: ["id"], row_count: 1, truncated: false,
      }))
      const get = spyOn(Registry, "get").mockResolvedValue({ execute } as unknown as Connector)
      const call = spyOn(Dispatcher, "call").mockImplementation(async (method: string, params: any) => {
        if (method === "schema.inspect") return { columns: [{ name: "id", data_type: "INTEGER" }] } as any
        return params.schema_name
          ? { tables: [{ schema: "main", name: "items", type: mode }] } as any
          : { schemas: [{ name: "main", table_count: mode === "over-limit" ? 41 : 1 }] } as any
      })
      const timeout = spyOn(AbortSignal, "timeout")
      try {
        const result = await discoverCatalog([{ name: "local", type }], {
          signal: new AbortController().signal, sessionID: "sample-test",
        })
        expect(timeout).not.toHaveBeenCalled()
        if (mode === "table") {
          expect(result).toContain("local: main.items: id INTEGER")
          expect(result).toContain("e.g. 7")
          expect(execute).toHaveBeenCalledTimes(1)
          expect(execute.mock.calls[0][3]?.queryTimeoutMs).toBe(resolveQueryTimeout(Registry.getConfig("local")).ms)
          expect(execute.mock.calls[0][3]?.signal?.aborted).toBe(false)
        } else {
          expect(execute).not.toHaveBeenCalled()
          expect(result).not.toContain("e.g.")
          if (mode === "over-limit") {
            expect(result).toContain("catalog too large")
            expect(call).toHaveBeenCalledTimes(1)
          }
        }
      } finally {
        timeout.mockRestore()
        call.mockRestore()
        get.mockRestore()
        Registry.reset()
      }
    })
  }
}

import { describe, expect, test } from "bun:test"
import { isLocalConnection } from "../../../src/altimate/tools/warehouse-discovery"

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

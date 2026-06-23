/**
 * Tests for finops warehouse resolution.
 *
 * Background: telemetry-analysis-2026-05-21 reported finops_* tools at 100%
 * error rate. The dominant failure was the LLM passing an unconfigured
 * warehouse name and getting a dead-end "Credit analysis is not available for
 * unknown warehouses" response. These tests pin the new resolver's contract.
 */

import { afterEach, describe, expect, test } from "bun:test"
import * as Registry from "../../src/altimate/native/connections/registry"
import { resolveFinopsWarehouse } from "../../src/altimate/native/finops/warehouse-resolver"

const CREDIT_SUPPORTED = ["snowflake", "bigquery", "databricks"] as const
const HISTORY_SUPPORTED = [
  "snowflake",
  "postgres",
  "postgresql",
  "bigquery",
  "databricks",
  "clickhouse",
] as const

afterEach(() => {
  Registry.reset()
})

describe("resolveFinopsWarehouse", () => {
  test("returns ok with the requested warehouse when it exists and type is supported", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
      dev_pg: { type: "postgres", host: "localhost" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "prod_sf",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.warehouse).toBe("prod_sf")
      expect(result.type).toBe("snowflake")
      expect(result.autoPicked).toBe(false)
    }
  })

  test("trims leading/trailing whitespace on the requested name before matching", () => {
    // LLMs occasionally surface warehouse names with stray whitespace from
    // prompt copy-paste or YAML/JSON serialization edge cases. Without the
    // trim, "  prod_sf  " is reported as unknown even though "prod_sf" is
    // configured. Pin the contract so a refactor can't silently drop the
    // trim.
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })

    for (const requested of ["  prod_sf", "prod_sf  ", "  prod_sf  ", "\tprod_sf\n"]) {
      const result = resolveFinopsWarehouse({
        requested,
        supportedTypes: CREDIT_SUPPORTED,
        operationName: "Credit analysis",
      })
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.warehouse).toBe("prod_sf")
      }
    }
  })

  test("auto-picks the first compatible warehouse when none is requested", () => {
    Registry.setConfigs({
      dev_pg: { type: "postgres", host: "localhost" } as any,
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
      stage_bq: { type: "bigquery", project: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      // Postgres skipped (unsupported for credit analysis); first match wins.
      expect(result.warehouse).toBe("prod_sf")
      expect(result.type).toBe("snowflake")
      expect(result.autoPicked).toBe(true)
    }
  })

  test("treats an empty string the same as undefined (auto-pick)", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.autoPicked).toBe(true)
      expect(result.warehouse).toBe("prod_sf")
    }
  })

  test("treats whitespace-only string the same as undefined (auto-pick)", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "   ",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.autoPicked).toBe(true)
    }
  })

  test("returns an actionable error when the requested warehouse is unknown", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
      dev_bq: { type: "bigquery", project: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "missing_wh",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      // Error must name the unknown warehouse and list the configured ones.
      expect(result.error).toContain("missing_wh")
      expect(result.error).toContain("prod_sf")
      expect(result.error).toContain("dev_bq")
    }
  })

  test("returns an actionable error when the requested warehouse type is unsupported", () => {
    Registry.setConfigs({
      dev_pg: { type: "postgres", host: "localhost" } as any,
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "dev_pg",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toContain("not available for postgres")
      // Should suggest the compatible one.
      expect(result.error).toContain("prod_sf")
    }
  })

  test("suggests adding a warehouse when none of the configured types are compatible", () => {
    Registry.setConfigs({
      dev_pg: { type: "postgres", host: "localhost" } as any,
      dev_sqlite: { type: "sqlite", path: "/tmp/db" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: "dev_pg",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toContain("not available for postgres")
      // Should mention the supported types as the path forward.
      expect(result.error).toContain("snowflake")
    }
  })

  test("returns an error pointing at warehouse_add when no warehouses are configured", () => {
    Registry.setConfigs({})

    const result = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toContain("none are set up")
      expect(result.error).toContain("warehouse_add")
      expect(result.error).toContain("snowflake")
    }
  })

  test("returns an error pointing at warehouse_add even when a name was requested but no warehouses are configured", () => {
    Registry.setConfigs({})

    const result = resolveFinopsWarehouse({
      requested: "anything",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toContain("warehouse_add")
    }
  })

  test("auto-pick fails cleanly when only incompatible warehouses are configured", () => {
    Registry.setConfigs({
      dev_pg: { type: "postgres", host: "localhost" } as any,
      dev_sqlite: { type: "sqlite", path: "/tmp/db" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toContain("not supported by any of your configured warehouses")
      expect(result.error).toContain("postgres")
      expect(result.error).toContain("sqlite")
      expect(result.error).toContain("warehouse_add")
    }
  })

  test("query-history supports postgres (broader type list than credit-analysis)", () => {
    Registry.setConfigs({
      dev_pg: { type: "postgres", host: "localhost" } as any,
    })

    const creditResult = resolveFinopsWarehouse({
      requested: "dev_pg",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })
    expect(creditResult.kind).toBe("error")

    const historyResult = resolveFinopsWarehouse({
      requested: "dev_pg",
      supportedTypes: HISTORY_SUPPORTED,
      operationName: "Query history",
    })
    expect(historyResult.kind).toBe("ok")
    if (historyResult.kind === "ok") {
      expect(historyResult.type).toBe("postgres")
    }
  })

  test("the operation name is reflected in the error message so the LLM can route to the right tool", () => {
    Registry.setConfigs({})

    const credit = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })
    const history = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: HISTORY_SUPPORTED,
      operationName: "Query history",
    })

    if (credit.kind === "error") expect(credit.error).toContain("Credit analysis")
    if (history.kind === "error") expect(history.error).toContain("Query history")
  })

  test("matches type case-insensitively (Snowflake / snowflake / SNOWFLAKE all resolve)", () => {
    // Driver lookup in registry.ts uses toLowerCase(), so a user config with
    // mixed-case `type` (Snowflake) gets a working driver but used to fail the
    // resolver's case-sensitive supportedTypes.includes(). Pin the fix.
    Registry.setConfigs({
      prod_titlecase: { type: "Snowflake", account: "x", user: "u", password: "p" } as any,
    })

    const titleResult = resolveFinopsWarehouse({
      requested: "prod_titlecase",
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })
    expect(titleResult.kind).toBe("ok")
    if (titleResult.kind === "ok") {
      // Returned type is normalized to lowercase so downstream SQL-template
      // selectors (which compare against "snowflake" etc.) work.
      expect(titleResult.type).toBe("snowflake")
    }

    Registry.reset()
    Registry.setConfigs({
      prod_upper: { type: "SNOWFLAKE", account: "x", user: "u", password: "p" } as any,
    })
    const upperResult = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })
    expect(upperResult.kind).toBe("ok")
    if (upperResult.kind === "ok") {
      expect(upperResult.type).toBe("snowflake")
      expect(upperResult.autoPicked).toBe(true)
    }
  })

  test("filters compatible warehouses case-insensitively during auto-pick", () => {
    Registry.setConfigs({
      dev_pg: { type: "Postgres", host: "localhost" } as any,
      prod_bq: { type: "BIGQUERY", project: "p" } as any,
    })

    const result = resolveFinopsWarehouse({
      requested: undefined,
      supportedTypes: CREDIT_SUPPORTED,
      operationName: "Credit analysis",
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      // Skips mixed-case postgres (unsupported) and picks the uppercase bigquery.
      expect(result.warehouse).toBe("prod_bq")
      expect(result.type).toBe("bigquery")
    }
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { detectPii, piiColumnsFromReport } from "../../src/altimate/native/schema/pii-detector"
import * as Registry from "../../src/altimate/native/connections/registry"

const RUN = process.env.ALTIMATE_RUN_WAREHOUSE_E2E === "1"
const e2eTest = RUN ? test : test.skip

describe("piiColumnsFromReport (real engine PiiReport shape)", () => {
  test("extracts PII rows and drops 'None' rows from a live classifyPii result", () => {
    const core = require("@altimateai/altimate-core")
    const schema = core.Schema.fromJson(
      JSON.stringify({
        tables: {
          users: {
            columns: [
              { name: "id", type: "INTEGER" },
              { name: "email", type: "VARCHAR" },
              { name: "note", type: "VARCHAR" },
            ],
          },
        },
      }),
    )
    const report = JSON.parse(JSON.stringify(core.classifyPii(schema)))
    // Sanity: the engine returns a row per column under `columns` (not `findings`).
    expect(report.findings).toBeUndefined()
    expect(report.columns.length).toBe(3)

    const pii = piiColumnsFromReport(report)
    expect(pii.length).toBe(report.pii_count)
    expect(pii.some((c) => c.column === "email" && c.classification === "Email")).toBe(true)
    expect(pii.some((c) => c.classification === "None")).toBe(false)
  })

  test("fails closed on malformed reports (missing/non-array columns)", () => {
    // A PiiReport always carries a columns array — anything else is malformed
    // and must throw rather than silently yield zero findings.
    expect(() => piiColumnsFromReport(undefined)).toThrow("malformed PiiReport")
    expect(() => piiColumnsFromReport({})).toThrow("malformed PiiReport")
    expect(() => piiColumnsFromReport({ columns: "not-an-array" })).toThrow("malformed PiiReport")
    expect(() => piiColumnsFromReport({ findings: [{ category: "email" }] })).toThrow("malformed PiiReport")
    expect(piiColumnsFromReport({ columns: [] })).toEqual([])
  })
})

/**
 * Regression: pii-detector read `piiData.findings` + `finding.category`, but the
 * engine's classifyPii returns PiiReport `{ columns, pii_count, … }` with
 * `classification` — so schema-level PII detection silently returned zero
 * findings for every scan (latent since the Python-engine elimination).
 */
describe("schema.detect_pii DuckDB e2e", () => {
  let priorTelemetry: string | undefined

  beforeAll(() => {
    priorTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  })

  afterAll(() => {
    if (priorTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = priorTelemetry
    Registry.reset()
  })

  e2eTest("detects PII columns through a real DuckDB warehouse (live path)", async () => {
    Registry.reset()
    Registry.setConfigs({ duck_pii_e2e: { type: "duckdb", path: ":memory:" } })
    const conn = await Registry.get("duck_pii_e2e")

    await conn.execute("CREATE TABLE users (id INTEGER, email VARCHAR, note VARCHAR)")

    let result: Awaited<ReturnType<typeof detectPii>>
    try {
      result = await detectPii({ warehouse: "duck_pii_e2e" })
    } finally {
      // Registry.reset() clears the cache without closing connectors.
      await conn.close()
    }

    expect(result.success).toBe(true)
    expect(result.finding_count).toBeGreaterThan(0)
    const emailFinding = result.findings.find((f) => f.column === "email")
    expect(emailFinding).toBeDefined()
    expect(emailFinding!.pii_category).toBe("Email")
    // Non-PII columns (classification "None") must NOT be reported.
    expect(result.findings.some((f) => f.pii_category === "None")).toBe(false)
    expect(result.findings.some((f) => f.pii_category === "UNKNOWN")).toBe(false)
  })
})

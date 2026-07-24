/**
 * tool-detection.ts — parses `dbt --version` output to decide whether the
 * user's local toolchain can run the sample's dbt build workflow. This
 * test only covers the parsing shape — the actual subprocess probe is
 * exercised end-to-end via the dbt-e2e test (guarded by DBT_E2E_SKIP)
 * elsewhere.
 *
 * To make the probe unit-testable without mocking subprocess spawn, we
 * assert against curated `dbt --version` output samples that match what
 * dbt-core 1.x emits.
 */

import { describe, expect, test } from "bun:test"

// The parser is an inline regex inside `probe()` — we test the same
// pattern here to pin its behavior against representative outputs. If
// the impl regex changes, update BOTH.
const HAS_DBT_DUCKDB_RE = /^\s*-\s*duckdb:/m
const VERSION_RE = /-\s*installed:\s*([0-9]+\.[0-9]+\.[0-9]+)/

describe("dbt --version output parsing", () => {
  test("dbt 1.11 with duckdb plugin installed → adapter detected", () => {
    const out = `Core:
  - installed: 1.11.8
  - latest:    1.12.0 - Update available!

Plugins:
  - duckdb: 1.11.4 - Update available!
`
    expect(HAS_DBT_DUCKDB_RE.test(out)).toBe(true)
    expect(VERSION_RE.exec(out)?.[1]).toBe("1.11.8")
  })

  test("dbt with only non-duckdb plugins → adapter NOT detected (codex fix #4 — this is the case that used to false-positive on a substring match)", () => {
    const out = `Core:
  - installed: 1.11.8

Plugins:
  - snowflake: 1.11.0
  - bigquery:  1.11.1
`
    expect(HAS_DBT_DUCKDB_RE.test(out)).toBe(false)
  })

  test("dbt version with 'duckdb' as a substring in an upgrade hint (not on a plugin line) → NOT detected", () => {
    const out = `Core:
  - installed: 1.11.8
  - latest:    1.12.0

Try installing dbt-duckdb for a local warehouse.
`
    // Substring "dbt-duckdb" is on a prose line, not on a plugin bullet.
    // The regex requires `^\s*-\s*duckdb:` which won't match.
    expect(HAS_DBT_DUCKDB_RE.test(out)).toBe(false)
  })

  test("dbt output with plugin line but no colon (unusual formatting) → NOT detected", () => {
    // Defensive — some dbt versions or user shells strip color-code
    // artifacts differently. If the impl regex is ever loosened to
    // accept "  - duckdb" (no colon), that would false-positive on
    // the following prose line where 'duckdb' happens to appear as a
    // bare word. We assert the strict form here.
    const out = `Plugins:
  - duckdb        1.11.4
`
    expect(HAS_DBT_DUCKDB_RE.test(out)).toBe(false)
  })

  test("empty output → nothing detected", () => {
    expect(HAS_DBT_DUCKDB_RE.test("")).toBe(false)
    expect(VERSION_RE.exec("")).toBeNull()
  })
})

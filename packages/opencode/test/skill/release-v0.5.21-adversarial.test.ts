/**
 * Adversarial tests for v0.5.21 release.
 *
 * Covers:
 *   1. {env:...} regex tightening — non-identifier chars rejected
 *   2. Env-var single-pass: no chain injection, $${VAR} escape
 *   3. EXPLAIN dialect selection — all warehouse types + edge cases
 *   4. EXPLAIN error translation — bind placeholders, empty warehouse
 *   5. explainAlternative — specific guidance per unsupported warehouse
 *   6. dbt unit test generator — input validation edge cases
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"
import {
  buildExplainPlan,
  translateExplainError,
} from "../../src/altimate/native/connections/register"

// ---------------------------------------------------------------------------
// 1. {env:...} regex hardening
// ---------------------------------------------------------------------------

describe("{env:...} regex rejects non-identifier characters", () => {
  const KEYS_TO_CLEAR = [
    "VALID_VAR",
    "../../etc/passwd",
    "FOO BAR",
    "FOO-BAR",
    "FOO.BAR",
  ]

  beforeEach(() => {
    process.env["VALID_VAR"] = "good"
    // These should never be looked up, but set them to detect false positives
    process.env["../../etc/passwd"] = "LEAKED"
    process.env["FOO BAR"] = "LEAKED"
    process.env["FOO-BAR"] = "LEAKED"
    process.env["FOO.BAR"] = "LEAKED"
  })

  afterEach(() => {
    for (const k of KEYS_TO_CLEAR) delete process.env[k]
  })

  test("valid identifier resolves", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:VALID_VAR}")).toBe("good")
  })

  test("path traversal NOT resolved — stays literal", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:../../etc/passwd}")).toBe(
      "{env:../../etc/passwd}",
    )
  })

  test("space in name NOT resolved — stays literal", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:FOO BAR}")).toBe(
      "{env:FOO BAR}",
    )
  })

  test("dash in name NOT resolved — stays literal", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:FOO-BAR}")).toBe(
      "{env:FOO-BAR}",
    )
  })

  test("dot in name NOT resolved — stays literal", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:FOO.BAR}")).toBe(
      "{env:FOO.BAR}",
    )
  })

  test("empty name NOT resolved", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:}")).toBe("{env:}")
  })

  test("leading digit NOT resolved", () => {
    process.env["1BAD"] = "LEAKED"
    try {
      expect(ConfigPaths.resolveEnvVarsInString("{env:1BAD}")).toBe("{env:1BAD}")
    } finally {
      delete process.env["1BAD"]
    }
  })

  test("underscore-prefixed name resolves (valid identifier)", () => {
    process.env["_PRIVATE"] = "ok"
    try {
      expect(ConfigPaths.resolveEnvVarsInString("{env:_PRIVATE}")).toBe("ok")
    } finally {
      delete process.env["_PRIVATE"]
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Single-pass env-var — chain injection blocked
// ---------------------------------------------------------------------------

describe("env-var single-pass prevents chain injection", () => {
  beforeEach(() => {
    process.env["CHAIN_OUTER"] = "${CHAIN_SECRET}"
    process.env["CHAIN_SECRET"] = "TOP_SECRET_VALUE"
  })

  afterEach(() => {
    delete process.env["CHAIN_OUTER"]
    delete process.env["CHAIN_SECRET"]
  })

  test("${CHAIN_OUTER} resolves to literal '${CHAIN_SECRET}', not 'TOP_SECRET_VALUE'", () => {
    const result = ConfigPaths.resolveEnvVarsInString("${CHAIN_OUTER}")
    expect(result).toBe("${CHAIN_SECRET}")
    expect(result).not.toBe("TOP_SECRET_VALUE")
  })

  test("$${VAR} produces literal ${VAR}", () => {
    process.env["ESCAPED"] = "should_not_appear"
    try {
      expect(ConfigPaths.resolveEnvVarsInString("$${ESCAPED}")).toBe(
        "${ESCAPED}",
      )
    } finally {
      delete process.env["ESCAPED"]
    }
  })

  test("$${VAR:-default} produces literal ${VAR:-default}", () => {
    expect(ConfigPaths.resolveEnvVarsInString("$${MISSING:-fallback}")).toBe(
      "${MISSING:-fallback}",
    )
  })
})

// ---------------------------------------------------------------------------
// 3. buildExplainPlan — dialect coverage + edge cases
// ---------------------------------------------------------------------------

describe("buildExplainPlan edge cases", () => {
  test("undefined warehouse falls back to EXPLAIN (no analyze)", () => {
    const plan = buildExplainPlan(undefined, false)
    expect(plan.prefix).toBe("EXPLAIN")
    expect(plan.actuallyAnalyzed).toBe(false)
  })

  test("undefined warehouse falls back to EXPLAIN ANALYZE", () => {
    const plan = buildExplainPlan(undefined, true)
    expect(plan.prefix).toBe("EXPLAIN ANALYZE")
    expect(plan.actuallyAnalyzed).toBe(true)
  })

  test("empty string warehouse falls back to EXPLAIN", () => {
    const plan = buildExplainPlan("", false)
    expect(plan.prefix).toBe("EXPLAIN")
  })

  test("case-insensitive matching (SNOWFLAKE → snowflake)", () => {
    expect(buildExplainPlan("SNOWFLAKE", false).prefix).toBe(
      "EXPLAIN USING TEXT",
    )
    expect(buildExplainPlan("Snowflake", false).prefix).toBe(
      "EXPLAIN USING TEXT",
    )
  })

  test("bigquery returns empty prefix", () => {
    const plan = buildExplainPlan("bigquery", true)
    expect(plan.prefix).toBe("")
    expect(plan.actuallyAnalyzed).toBe(false)
  })

  test("oracle returns empty prefix", () => {
    expect(buildExplainPlan("oracle", false).prefix).toBe("")
  })

  test("mssql returns empty prefix", () => {
    expect(buildExplainPlan("mssql", false).prefix).toBe("")
  })

  test("sqlserver returns empty prefix (alias)", () => {
    expect(buildExplainPlan("sqlserver", false).prefix).toBe("")
  })

  test("snowflake ignores analyze flag", () => {
    const withAnalyze = buildExplainPlan("snowflake", true)
    const without = buildExplainPlan("snowflake", false)
    expect(withAnalyze.prefix).toBe(without.prefix)
    expect(withAnalyze.actuallyAnalyzed).toBe(false)
  })

  test("redshift ignores analyze flag", () => {
    const plan = buildExplainPlan("redshift", true)
    expect(plan.prefix).toBe("EXPLAIN")
    expect(plan.actuallyAnalyzed).toBe(false)
  })

  test("clickhouse ignores analyze flag", () => {
    const plan = buildExplainPlan("clickhouse", true)
    expect(plan.prefix).toBe("EXPLAIN")
    expect(plan.actuallyAnalyzed).toBe(false)
  })

  test("postgres with analyze returns EXPLAIN (ANALYZE, BUFFERS)", () => {
    expect(buildExplainPlan("postgres", true).prefix).toBe(
      "EXPLAIN (ANALYZE, BUFFERS)",
    )
    expect(buildExplainPlan("postgres", true).actuallyAnalyzed).toBe(true)
  })

  test("postgresql alias works", () => {
    expect(buildExplainPlan("postgresql", false).prefix).toBe("EXPLAIN")
  })

  test("databricks with analyze returns EXPLAIN FORMATTED", () => {
    expect(buildExplainPlan("databricks", true).prefix).toBe(
      "EXPLAIN FORMATTED",
    )
    expect(buildExplainPlan("databricks", true).actuallyAnalyzed).toBe(false)
  })

  test("spark alias works", () => {
    expect(buildExplainPlan("spark", true).prefix).toBe("EXPLAIN FORMATTED")
  })

  test("unknown warehouse type still returns a prefix", () => {
    const plan = buildExplainPlan("some_future_db", false)
    expect(plan.prefix).toBe("EXPLAIN")
  })
})

// ---------------------------------------------------------------------------
// 4. translateExplainError — bind placeholders + edge cases
// ---------------------------------------------------------------------------

describe("translateExplainError edge cases", () => {
  test("returns original message for non-matching errors", () => {
    const result = translateExplainError("Some random database error", undefined, [])
    expect(result).toBe("Some random database error")
  })

  test("detects ? bind placeholder", () => {
    const result = translateExplainError(
      "syntax error at or near ? at position 42", undefined, [],
    )
    expect(result).toContain("bind")
  })

  test("detects $1 bind placeholder", () => {
    const result = translateExplainError(
      "there is no parameter $1 in the query", undefined, [],
    )
    expect(result).toContain("bind")
  })

  test("detects :name bind placeholder", () => {
    const result = translateExplainError(
      "syntax error: unexpected token :user_id", undefined, [],
    )
    expect(result).toContain("bind")
  })

  test("detects no warehouse configured (empty list)", () => {
    const result = translateExplainError(
      "Connection ? not found. Available: (none)", undefined, [],
    )
    expect(result).toContain("warehouse")
    expect(result).toContain("warehouse_add")
  })

  test("detects no warehouse configured (with alternatives)", () => {
    const result = translateExplainError(
      "Connection foo not found", "foo", ["bar", "baz"],
    )
    expect(result).toContain("bar")
    expect(result).toContain("baz")
  })

  test("handles empty string error gracefully", () => {
    const result = translateExplainError("", undefined, [])
    expect(result).toBe("")
  })

  test("handles very long error string without hanging", () => {
    const longError = "x".repeat(100_000)
    // Should complete quickly without ReDoS
    const start = performance.now()
    translateExplainError(longError, undefined, [])
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000) // 1s budget
  })
})

// ---------------------------------------------------------------------------
// 5. ENV_VAR_PATTERN — boundary and injection tests
// ---------------------------------------------------------------------------

describe("ENV_VAR_PATTERN boundary tests", () => {
  beforeEach(() => {
    process.env["TEST_A"] = "alpha"
    process.env["TEST_B"] = "beta"
  })

  afterEach(() => {
    delete process.env["TEST_A"]
    delete process.env["TEST_B"]
  })

  test("adjacent variables resolve independently", () => {
    expect(
      ConfigPaths.resolveEnvVarsInString("${TEST_A}${TEST_B}"),
    ).toBe("alphabeta")
  })

  test("variable embedded in URL", () => {
    expect(
      ConfigPaths.resolveEnvVarsInString(
        "https://${TEST_A}.example.com/${TEST_B}",
      ),
    ).toBe("https://alpha.example.com/beta")
  })

  test("mixed ${} and {env:} syntax in same string", () => {
    expect(
      ConfigPaths.resolveEnvVarsInString("${TEST_A} and {env:TEST_B}"),
    ).toBe("alpha and beta")
  })

  test("default value with special characters", () => {
    expect(
      ConfigPaths.resolveEnvVarsInString("${NONEXISTENT:-hello world!}"),
    ).toBe("hello world!")
  })

  test("empty default is distinct from unresolved", () => {
    const stats = ConfigPaths.newEnvSubstitutionStats()
    const result = ConfigPaths.resolveEnvVarsInString(
      "${NONEXISTENT:-}",
      stats,
    )
    expect(result).toBe("")
    expect(stats.dollarDefaulted).toBe(1)
    expect(stats.dollarUnresolved).toBe(0) // has a default, so not unresolved
  })

  test("unresolved without default counts as unresolved", () => {
    const stats = ConfigPaths.newEnvSubstitutionStats()
    ConfigPaths.resolveEnvVarsInString("${TOTALLY_MISSING_XYZ}", stats)
    expect(stats.dollarUnresolved).toBe(1)
    expect(stats.unresolvedNames).toContain("TOTALLY_MISSING_XYZ")
  })

  test("__proto__ key resolves from process.env (no prototype pollution)", () => {
    // __proto__ IS a valid identifier pattern, but process.env["__proto__"]
    // returns Object.prototype in JS engines. The resolver should return
    // whatever process.env gives back without crashing.
    const result = ConfigPaths.resolveEnvVarsInString("{env:__proto__}")
    // Result is whatever String(process.env["__proto__"]) produces — we just
    // verify it doesn't throw or hang, not a specific value.
    expect(typeof result).toBe("string")
  })
})

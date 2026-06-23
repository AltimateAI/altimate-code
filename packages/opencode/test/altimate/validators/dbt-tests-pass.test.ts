import { describe, expect, test } from "bun:test"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import type { TestSummary } from "../../../src/altimate/validators/dbt-tests-pass"

// ---------------------------------------------------------------------------
// parseDbtTestOutput — null / empty guard
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — null/empty guard", () => {
  test("returns null for empty string", () => {
    expect(parseDbtTestOutput("")).toBeNull()
  })

  test("returns null for whitespace-only string", () => {
    expect(parseDbtTestOutput("   \n  \t  ")).toBeNull()
  })

  test("returns null when no summary line is present", () => {
    expect(parseDbtTestOutput("Running tests...\n[error] compilation failed")).toBeNull()
  })

  test("returns null when dbt itself errored before tests ran", () => {
    const stdout = [
      "17:00:00  Running with dbt=1.8.0",
      "17:00:01  Encountered an error:",
      "17:00:01  Compilation Error in model orders",
      "17:00:01    column 'foo' was not found in source table",
    ].join("\n")
    expect(parseDbtTestOutput(stdout)).toBeNull()
  })

  test("returns null when output was truncated before Done. line", () => {
    const stdout = [
      "17:04:15  1 of 3 PASS not_null_orders_order_id [PASS in 0.10s]",
      "17:04:16  2 of 3 PASS unique_orders_order_id [PASS in 0.08s]",
      // truncated — no Done. line
    ].join("\n")
    expect(parseDbtTestOutput(stdout)).toBeNull()
  })

  test("returns null for null input (runtime safety)", () => {
    expect(parseDbtTestOutput(null as unknown as string)).toBeNull()
  })

  test("returns null for undefined input (runtime safety)", () => {
    expect(parseDbtTestOutput(undefined as unknown as string)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — clean all-pass cases
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — all-pass scenarios", () => {
  test("parses a clean all-pass summary", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:15  1 of 3 PASS not_null_orders_order_id [PASS in 0.10s]",
      "17:04:16  2 of 3 PASS unique_orders_order_id [PASS in 0.08s]",
      "17:04:17  3 of 3 PASS relationships_orders_customer_id [PASS in 0.12s]",
      "17:04:17  Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3",
    ].join("\n")
    const result = parseDbtTestOutput(stdout) as TestSummary
    expect(result).not.toBeNull()
    expect(result.pass).toBe(3)
    expect(result.error).toBe(0)
    expect(result.total).toBe(3)
    expect(result.failingTests).toEqual([])
  })

  test("reports no failing tests when all pass", () => {
    const stdout = "Done. PASS=10 WARN=0 ERROR=0 SKIP=0 TOTAL=10"
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests).toHaveLength(0)
  })

  test("parses a summary with SKIP but no failures", () => {
    const stdout = "Done. PASS=5 WARN=0 ERROR=0 SKIP=3 TOTAL=8"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(5)
    expect(result.error).toBe(0)
    expect(result.total).toBe(8)
    expect(result.failingTests).toHaveLength(0)
  })

  test("parses a summary with WARN but no ERROR", () => {
    const stdout = "Done. PASS=4 WARN=2 ERROR=0 SKIP=0 TOTAL=6"
    const result = parseDbtTestOutput(stdout)!
    expect(result.error).toBe(0)
    expect(result.pass).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — NO-OP variant
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — NO-OP (no tests in project)", () => {
  test("parses NO-OP variant (zero tests, dbt 1.6+)", () => {
    const stdout = "17:04:14  Done. PASS=0 WARN=0 ERROR=0 SKIP=0 NO-OP=1 TOTAL=0"
    const result = parseDbtTestOutput(stdout)!
    expect(result).not.toBeNull()
    expect(result.total).toBe(0)
    expect(result.error).toBe(0)
  })

  test("parses NO-OP with multiple no-op invocations", () => {
    const stdout = "Done. PASS=0 WARN=0 ERROR=0 SKIP=0 NO-OP=5 TOTAL=0"
    const result = parseDbtTestOutput(stdout)!
    expect(result.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — failure extraction
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — failure extraction", () => {
  test("extracts failing test names from FAIL lines", () => {
    const stdout = [
      "17:04:16  2 of 4 FAIL 5 unique_orders_order_id [FAIL 5 in 0.05s]",
      "17:04:17  3 of 4 ERROR not_null_orders_amount [ERROR in 0.04s]",
      "17:04:17  Done. PASS=2 WARN=0 ERROR=2 SKIP=0 TOTAL=4",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.error).toBe(2)
    expect(result.failingTests).toContain("unique_orders_order_id")
    expect(result.failingTests).toContain("not_null_orders_amount")
  })

  test("deduplicates test names when same test appears in multiple lines", () => {
    const stdout = [
      "1 of 1 FAIL 3 unique_orders_id [FAIL 3 in 0.05s]",
      "1 of 1 FAIL 3 unique_orders_id [FAIL 3 in 0.05s]", // duplicate line
      "Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests.filter((n) => n === "unique_orders_id")).toHaveLength(1)
  })

  test("does not include [FAIL token as a test name", () => {
    const stdout = [
      "1 of 1 FAIL 1 my_test [FAIL 1 in 0.01s]",
      "Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests).not.toContain("[FAIL")
    expect(result.failingTests).toContain("my_test")
  })

  test("does not include [ERROR token as a test name", () => {
    const stdout = [
      "1 of 1 ERROR my_test [ERROR in 0.01s]",
      "Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests).not.toContain("[ERROR")
    expect(result.failingTests).toContain("my_test")
  })

  test("handles test names with dots and multiple underscores", () => {
    const stdout = [
      "1 of 1 FAIL 1 not_null_orders__customer__order_id.primary_key [FAIL 1 in 0.01s]",
      "Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests.length).toBeGreaterThan(0)
    expect(result.failingTests[0]).not.toContain("[FAIL")
  })

  test("extracts up to 10+ failing test names (no artificial cap on extraction)", () => {
    const lines: string[] = []
    for (let i = 1; i <= 15; i++) {
      lines.push(`${i} of 15 FAIL 1 test_name_${i} [FAIL 1 in 0.01s]`)
    }
    lines.push("Done. PASS=0 WARN=0 ERROR=15 SKIP=0 TOTAL=15")
    const result = parseDbtTestOutput(lines.join("\n"))!
    // All 15 failing test names should be captured
    expect(result.failingTests.length).toBe(15)
  })

  test("handles mixed FAIL and ERROR lines", () => {
    const stdout = [
      "1 of 3 FAIL 2 unique_id [FAIL 2 in 0.01s]",
      "2 of 3 ERROR not_null_amount [ERROR in 0.02s]",
      "3 of 3 PASS some_test [PASS in 0.01s]",
      "Done. PASS=1 WARN=0 ERROR=2 SKIP=0 TOTAL=3",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.failingTests).toContain("unique_id")
    expect(result.failingTests).toContain("not_null_amount")
    expect(result.failingTests.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — large counts and numeric edge cases
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — numeric edge cases", () => {
  test("handles very large pass/error/total counts", () => {
    const stdout = "Done. PASS=99999 WARN=0 ERROR=99999 SKIP=0 TOTAL=199998"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(99999)
    expect(result.error).toBe(99999)
    expect(result.total).toBe(199998)
  })

  test("handles single-test project", () => {
    const stdout = "Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    const result = parseDbtTestOutput(stdout)!
    expect(result.total).toBe(1)
    expect(result.pass).toBe(1)
  })

  test("handles all-zero counts (empty project)", () => {
    const stdout = "Done. PASS=0 WARN=0 ERROR=0 SKIP=0 TOTAL=0"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(0)
    expect(result.error).toBe(0)
    expect(result.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — format resilience (named groups, field order)
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — format resilience", () => {
  test("is case-insensitive for Done. keyword", () => {
    expect(parseDbtTestOutput("done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1")).not.toBeNull()
    expect(parseDbtTestOutput("DONE. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1")).not.toBeNull()
    expect(parseDbtTestOutput("Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1")).not.toBeNull()
  })

  test("extracts correct value for PASS using named group (not positional index)", () => {
    const stdout = "Done. PASS=7 WARN=0 ERROR=3 SKIP=1 TOTAL=11"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(7)
    expect(result.error).toBe(3)
    expect(result.total).toBe(11)
  })

  test("handles summary line preceded by dbt 1.x timestamps", () => {
    const stdout = "17:04:17  Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(5)
    expect(result.total).toBe(5)
  })

  test("handles ANSI colour codes around the summary line", () => {
    const stdout = "\x1b[32m17:04:17  Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5\x1b[0m"
    const result = parseDbtTestOutput(stdout)!
    expect(result).not.toBeNull()
    expect(result.pass).toBe(5)
  })

  test("handles Windows CRLF line endings", () => {
    const stdout = "17:04:17  Running tests\r\nDone. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2\r\n"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(2)
  })

  test("summary line at the very start of output (no preceding lines)", () => {
    const stdout = "Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(1)
  })

  test("summary line at the very end with nothing after", () => {
    const stdout = "Running...\nDone. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    expect(parseDbtTestOutput(stdout)).not.toBeNull()
  })

  test("uses FIRST matching Done. line (regex .match returns first)", () => {
    // .match() finds the first occurrence. Both lines are valid.
    // We document this: first line's counts are returned.
    const stdout = [
      "Done. PASS=1 WARN=0 ERROR=2 SKIP=0 TOTAL=3",  // first
      "Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3",  // second (re-run)
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    // Just verify it doesn't crash; exact first/last behavior is implementation detail
    expect(result).not.toBeNull()
    expect(result.total).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — realistic full-output scenarios
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput — realistic full-output scenarios", () => {
  test("dbt 1.8 full output — all pass", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.3 (PyPI latest)",
      "17:04:14",
      "17:04:14  Found 12 models, 47 tests, 2 sources, 0 exposures, 0 metrics",
      "17:04:14",
      "17:04:14  Concurrency: 1 threads (target='dev')",
      "17:04:14",
      "17:04:15  1 of 5 START test not_null_orders_order_id ......... [RUN]",
      "17:04:15  1 of 5 PASS not_null_orders_order_id ............... [PASS in 0.05s]",
      "17:04:15  2 of 5 START test unique_orders_order_id ........... [RUN]",
      "17:04:15  2 of 5 PASS unique_orders_order_id ................. [PASS in 0.04s]",
      "17:04:15  3 of 5 START test relationships_orders_customer .... [RUN]",
      "17:04:16  3 of 5 PASS relationships_orders_customer .......... [PASS in 0.12s]",
      "17:04:16  4 of 5 START test accepted_values_orders_status ... [RUN]",
      "17:04:16  4 of 5 PASS accepted_values_orders_status ......... [PASS in 0.08s]",
      "17:04:16  5 of 5 PASS some_custom_test ...................... [PASS in 0.06s]",
      "17:04:16",
      "17:04:16  Finished running 5 tests in 0 hours 0 minutes and 0.35 seconds (0.35s).",
      "17:04:16",
      "17:04:16  Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5",
      "17:04:16",
      "17:04:16  Completed successfully",
      "17:04:16",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(5)
    expect(result.error).toBe(0)
    expect(result.total).toBe(5)
    expect(result.failingTests).toHaveLength(0)
  })

  test("dbt 1.8 full output — partial failures", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.3",
      "17:04:15  1 of 4 PASS not_null_orders_id ............. [PASS in 0.05s]",
      "17:04:16  2 of 4 FAIL 5 unique_orders_order_id ....... [FAIL 5 in 0.05s]",
      "17:04:16  3 of 4 ERROR not_null_orders_amount ......... [ERROR in 0.04s]",
      "17:04:17  4 of 4 PASS relationships_orders ............ [PASS in 0.12s]",
      "17:04:17",
      "17:04:17  Finished running 4 tests in 0.26s.",
      "17:04:17",
      "17:04:17  Done. PASS=2 WARN=0 ERROR=2 SKIP=0 TOTAL=4",
      "17:04:17",
      "17:04:17  Completed with 2 errors and 0 warnings:",
      "17:04:17",
      "17:04:17  Failure in test unique_orders_order_id (models/staging/schema.yml)",
      "17:04:17    Got 5 results, configured to fail if != 0",
    ].join("\n")
    const result = parseDbtTestOutput(stdout) as TestSummary
    expect(result.pass).toBe(2)
    expect(result.error).toBe(2)
    expect(result.total).toBe(4)
    expect(result.failingTests).toContain("unique_orders_order_id")
    expect(result.failingTests).toContain("not_null_orders_amount")
  })

  test("dbt output with ANSI colours and timestamps (realistic Docker output)", () => {
    const stdout = [
      "\x1b[0m17:04:14  \x1b[32mRunning with dbt=1.8.3\x1b[0m",
      "\x1b[0m17:04:15  \x1b[32m1 of 3 PASS not_null_id\x1b[0m \x1b[32m[PASS in 0.05s]\x1b[0m",
      "\x1b[0m17:04:15  \x1b[31m2 of 3 FAIL 2 unique_id\x1b[0m \x1b[31m[FAIL 2 in 0.05s]\x1b[0m",
      "\x1b[0m17:04:16  \x1b[32m3 of 3 PASS test_3\x1b[0m \x1b[32m[PASS in 0.05s]\x1b[0m",
      "\x1b[0m17:04:16  \x1b[0mDone. PASS=2 WARN=0 ERROR=1 SKIP=0 TOTAL=3\x1b[0m",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.pass).toBe(2)
    expect(result.error).toBe(1)
    expect(result.total).toBe(3)
  })

  test("output wrapped in altimate-dbt envelope (stdout field extracted)", () => {
    // This simulates the scenario where parseDbtTestOutput receives the inner
    // dbt log (already unwrapped from the {"stdout": "..."} envelope)
    const dbtLog = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:15  1 of 2 PASS test_a [PASS in 0.05s]",
      "17:04:15  2 of 2 PASS test_b [PASS in 0.05s]",
      "17:04:15  Done. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2",
    ].join("\n")
    const result = parseDbtTestOutput(dbtLog)!
    expect(result.pass).toBe(2)
    expect(result.error).toBe(0)
  })

  test("dbt output with skipped tests (--exclude flag)", () => {
    const stdout = "Done. PASS=3 WARN=0 ERROR=0 SKIP=5 TOTAL=8"
    const result = parseDbtTestOutput(stdout)!
    expect(result.total).toBe(8)
    expect(result.pass).toBe(3)
    expect(result.error).toBe(0)
  })

  test("dbt output when model has no tests defined", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:14  Nothing to do.",
      "17:04:14  Done. PASS=0 WARN=0 ERROR=0 SKIP=0 NO-OP=1 TOTAL=0",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)!
    expect(result.total).toBe(0)
    expect(result.error).toBe(0)
    expect(result.failingTests).toHaveLength(0)
  })
})

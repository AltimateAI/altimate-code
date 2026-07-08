import { describe, test, expect } from "bun:test"
import { computeIdealVerdict, makeFinding, type Finding } from "../../src/altimate/review"

// A critical finding in a blocking category (contract_violation), varying only
// by its evidence tool/result — to prove the verdict-layer enforcement.
function crit(tool: string, result?: Record<string, unknown>): Finding {
  return makeFinding({
    severity: "critical",
    category: "contract_violation",
    title: "x",
    body: "y",
    file: "models/marts/fct_orders.sql",
    model: "fct_orders",
    confidence: "high",
    evidence: { tool, result },
    ruleKey: "t:" + tool,
  })
}

function warning(tool: string, n: number): Finding {
  return makeFinding({
    severity: "warning",
    category: "test_coverage",
    title: "x",
    body: "y",
    file: "models/marts/fct_orders.sql",
    model: "fct_orders",
    confidence: "high",
    evidence: { tool, result: { n } },
    ruleKey: `t:${tool}:${n}`,
  })
}

describe("verdict enforcement — a spec-test finding may only block when executed+declared", () => {
  test("normal contract_violation critical still blocks (regression guard)", () => {
    expect(computeIdealVerdict([crit("altimate_core.dbt_config")])).toBe("REQUEST_CHANGES")
  })

  test("spec-test critical that was EXECUTED against a DECLARED constraint blocks", () => {
    expect(
      computeIdealVerdict([crit("altimate.spec_test.executed", { executed: true, origin: "declared_constraint" })]),
    ).toBe("REQUEST_CHANGES")
  })

  test("spec-test critical NOT executed does NOT block (downgrades to COMMENT)", () => {
    expect(
      computeIdealVerdict([crit("altimate.spec_test.executed", { executed: false, origin: "declared_constraint" })]),
    ).toBe("COMMENT")
  })

  test("spec-test critical from an INFERRED origin does NOT block", () => {
    expect(
      computeIdealVerdict([crit("altimate.spec_test.executed", { executed: true, origin: "inferred_context" })]),
    ).toBe("COMMENT")
  })

  test("a P0 proposed spec-test critical (advisory) can never block", () => {
    expect(computeIdealVerdict([crit("altimate.spec_test.proposed", { proposal: {} })])).toBe("COMMENT")
  })

  test("spoofed proposed/candidate results with executed+declared still do not block", () => {
    const spoofed = { executed: true, origin: "declared_constraint" }
    expect(computeIdealVerdict([crit("altimate.spec_test.proposed", spoofed)])).toBe("COMMENT")
    expect(computeIdealVerdict([crit("altimate.spec_test.candidate", spoofed)])).toBe("COMMENT")
  })

  test("candidate spec-test warnings do not accumulate into a blocking verdict", () => {
    expect(
      computeIdealVerdict([
        warning("altimate.spec_test.candidate", 1),
        warning("altimate.spec_test.candidate", 2),
        warning("altimate.spec_test.candidate", 3),
      ]),
    ).toBe("COMMENT")
  })
})

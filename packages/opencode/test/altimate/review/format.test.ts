import { describe, expect, test } from "bun:test"
import { makeFinding, type Finding } from "../../../src/altimate/review/finding"
import { renderSummary } from "../../../src/altimate/review/format"
import { computeFindingDelta, parseFindingIds } from "../../../src/altimate/review/post-github"
import { DEFAULT_RUBRIC } from "../../../src/altimate/review/rubric"
import {
  buildEnvelope,
  makeReviewPolicySignature,
  type ReviewPolicySignatureInput,
} from "../../../src/altimate/review/verdict"

function finding(id: string, overrides: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    id,
    severity: "warning",
    category: "sql_quality",
    title: `Finding ${id}`,
    body: `Body ${id}.`,
    file: `models/${id}.sql`,
    ruleKey: id,
    ...overrides,
  })
}

function summary(findings: Finding[], options: { lintOnly?: boolean; artifactHints?: string[] } = {}): string {
  return renderSummary(buildEnvelope({ findings, tier: "full", mode: "comment", ...options }))
}

describe("review summary readability", () => {
  test("describes every condition that makes a review lint-only", () => {
    expect(summary([], { lintOnly: true })).toContain(
      "⚙️ Lint-only run — no changed model resolved against a dbt manifest (missing manifest, or the changed models are not in it). Run `dbt compile` on this branch so lineage/equivalence can run.",
    )
  })

  test("escapes singleton locations that contain backticks", () => {
    const rendered = summary([finding("singleton", { file: "models/odd`name.sql" })])

    expect(rendered).toContain("<sub>``models/odd`name.sql`` · sql_quality</sub>")
  })

  test("grouped items retain distinct locations and an unverified marker", () => {
    const rendered = summary([
      finding("group-a", { file: "models/a.sql", groupKey: "shared" }),
      finding("group-b", { file: "models/b.sql", groupKey: "shared", degraded: true }),
      finding("group-a-again", { file: "models/a.sql", groupKey: "shared" }),
      finding("group-c", { file: "models/c.sql", groupKey: "shared" }),
      finding("group-d", { file: "models/d.sql", groupKey: "shared" }),
    ])

    expect(rendered).toContain("<sub>`models/a.sql`, `models/b.sql`, `models/c.sql` · +1 more · _unverified_</sub>")
  })

  test("repetitive families render their member specifics in compact grouped items", () => {
    const equivalenceBody = (model: string) =>
      `The logic of \`${model}\` changed and equivalence could not be decided (no schema, or unsupported SQL). ` +
      "Treat as a potential behavior change and verify with a data-diff."
    const grainBody = (column: string) =>
      `The \`unique_combination_of_columns\` test on \`orders\` names \`${column}\` as a grain key. ` +
      `Add \`not_null\` to \`${column}\`'s \`data_tests:\` on \`orders\` (contract is not enforced, so use a data_test).`
    const findings = [
      finding("fanout-orders", {
        category: "lineage_breakage",
        title: "orders: high downstream fan-out (7 models)",
        body: "Fan-out body for orders.",
        file: "models/orders.sql",
        model: "orders",
        groupKey: "lineage_fanout",
        evidence: {
          tool: "impact_analysis",
          result: { directCount: 2, transitiveCount: 5, testCount: 3 },
        },
      }),
      finding("fanout-customers", {
        category: "lineage_breakage",
        title: "customers: high downstream fan-out (4 models)",
        body: "Fan-out body for customers.",
        file: "models/customers.sql",
        model: "customers",
        groupKey: "lineage_fanout",
      }),
      finding("equivalence-orders", {
        category: "semantic_change",
        title: "orders: refactor could not be proven equivalent",
        body: equivalenceBody("orders"),
        file: "models/orders.sql",
        model: "orders",
        groupKey: "equivalence_undecided",
        confidence: "unknown",
        degraded: true,
      }),
      finding("equivalence-customers", {
        category: "semantic_change",
        title: "customers: refactor could not be proven equivalent",
        body: equivalenceBody("customers"),
        file: "models/customers.sql",
        model: "customers",
        groupKey: "equivalence_undecided",
        confidence: "unknown",
        degraded: true,
      }),
      finding("grain-id", {
        category: "test_coverage",
        title: "schema.yml: grain column `id` lacks `not_null`",
        body: grainBody("id"),
        file: "models/schema.yml",
        model: "orders",
        column: "id",
        groupKey: "grain_not_null:orders",
      }),
      finding("grain-created", {
        category: "test_coverage",
        title: "schema.yml: grain column `created_at` lacks `not_null`",
        body: grainBody("created_at"),
        file: "models/schema.yml",
        model: "orders",
        column: "created_at",
        groupKey: "grain_not_null:orders",
      }),
    ]

    const rendered = summary(findings, {
      artifactHints: ["target/compiled missing for 2 changed model(s)"],
    })

    expect(rendered).toContain("### ⚠️ Warning (6 findings · 3 items)")
    expect(rendered).toContain(
      "**Downstream fan-out on 2 models** (informational) — `orders` (2 direct/5 transitive, +3 tests), `customers`",
    )
    expect(rendered).toContain(
      "**Equivalence could not be decided for 2 models** — no schema, or unsupported SQL. Fix once: compile base and head (see missing-artifact line). Models: `orders`, `customers`",
    )
    expect(rendered).toContain("**`orders`: grain columns without `not_null`** — `id`, `created_at` · test_coverage")
    expect(rendered).toContain("Add `not_null` to each listed column's `data_tests:` on `orders`")
    expect(rendered.split("Add `not_null`")).toHaveLength(2)

    const withoutCompiledHint = summary(findings)
    expect(withoutCompiledHint).toContain(
      "**Equivalence could not be decided for 2 models** — no schema, or unsupported SQL. Undecidable with the available artifacts — unsupported SQL for this dialect or missing schema; verify with a data-diff. Models: `orders`, `customers`",
    )
    expect(withoutCompiledHint).not.toContain("Fix once: compile base and head")
  })

  test("long non-critical sections fold after 12 rendered items, while critical never folds", () => {
    const suggestions = Array.from({ length: 30 }, (_, index) =>
      finding(`suggestion-${index + 1}`, {
        severity: "suggestion",
        title: `Suggestion ${index + 1}`,
        confidence: "medium",
      }),
    )
    const rendered = summary(suggestions)
    const detailsAt = rendered.indexOf("<details>")
    const beforeDetails = rendered.slice(0, detailsAt)

    expect(rendered).toContain("### 💡 Suggestion (30)")
    expect(beforeDetails).toContain("Suggestion 12")
    expect(beforeDetails).not.toContain("Suggestion 13")
    expect(rendered.slice(detailsAt)).toContain("Suggestion 13")
    expect(rendered).toContain("<summary>18 more …</summary>")

    const critical = Array.from({ length: 3 }, (_, index) =>
      finding(`critical-${index + 1}`, {
        severity: "critical",
        category: "contract_violation",
        title: `Critical ${index + 1}`,
      }),
    )
    expect(summary(critical)).not.toContain("<details>")
  })

  test("Read first prioritizes critical, contextual AI, then high-confidence ungrouped warning", () => {
    const findings = [
      finding("repeat-1", { title: "Repeated 1", groupKey: "repeated" }),
      finding("repeat-2", { title: "Repeated 2", groupKey: "repeated" }),
      finding("repeat-3", { title: "Repeated 3", groupKey: "repeated" }),
      finding("low", { title: "Low warning", confidence: "low" }),
      finding("critical", {
        severity: "critical",
        category: "contract_violation",
        title: "Critical contract break",
        file: "models/critical.sql",
      }),
      finding("ai", {
        severity: "suggestion",
        title: "Unused CTE bypasses the documented gate",
        file: "models/context.sql",
        evidence: { tool: "ai-review" },
      }),
      finding("warning", {
        title: "High-confidence warning",
        file: "models/warning.sql",
        confidence: "high",
      }),
      finding("extra", { severity: "suggestion", title: "Extra suggestion" }),
    ]
    const rendered = summary(findings, { lintOnly: true })
    const readFirstAt = rendered.indexOf("**Read first**")
    const bannerAt = rendered.indexOf("> ⚙️ Lint-only run")
    const block = rendered.slice(readFirstAt, bannerAt)

    expect(readFirstAt).toBeGreaterThan(rendered.indexOf("## "))
    expect(bannerAt).toBeGreaterThan(readFirstAt)
    expect(block.indexOf("Critical contract break")).toBeLessThan(block.indexOf("Unused CTE"))
    expect(block.indexOf("Unused CTE")).toBeLessThan(block.indexOf("High-confidence warning"))
    expect(block).toContain("<sub>`models/critical.sql`</sub>")
    expect(block).not.toContain("Repeated 1")
    expect(block).not.toContain("Low warning")
    expect(summary(findings.slice(0, 7))).not.toContain("**Read first**")
  })

  test("finding id blocks round-trip and drive the rerun delta line", () => {
    const rubric = {
      ...DEFAULT_RUBRIC,
      exclusions: { ...DEFAULT_RUBRIC.exclusions, excludeGlobs: ["models/archive/**", "seeds/tmp/**"] },
    }
    const policy: ReviewPolicySignatureInput = {
      severityThreshold: "suggestion",
      enabledReviewers: ["semantic_change", "sql_quality"],
      dialect: "snowflake",
      rubric,
      aiEnabled: true,
      aiModel: "altimate-gateway/altimate-base",
      dataDiff: { enabled: false, warehouse: "" },
    }
    const policySignature = makeReviewPolicySignature(policy)
    expect(policySignature).toBe(
      makeReviewPolicySignature({
        ...policy,
        enabledReviewers: ["sql_quality", "semantic_change"],
        rubric: {
          ...rubric,
          blockOn: [...rubric.blockOn].reverse(),
          thresholds: Object.fromEntries(Object.entries(rubric.thresholds).reverse()) as typeof rubric.thresholds,
          exclusions: { ...rubric.exclusions, excludeGlobs: ["seeds/tmp/**", "models/archive/**"] },
        },
      }),
    )
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        rubric: {
          ...rubric,
          exclusions: { ...rubric.exclusions, excludeGlobs: ["models/other/**", "seeds/tmp/**"] },
        },
      }),
    )
    const firstEnabledExclusion = makeReviewPolicySignature({
      ...policy,
      rubric: {
        ...rubric,
        exclusions: {
          ...rubric.exclusions,
          allowSelectStarInStaging: false,
          skipMissingContractWhenNotEnforced: true,
          skipNonProdModels: false,
        },
      },
    })
    const secondEnabledExclusion = makeReviewPolicySignature({
      ...policy,
      rubric: {
        ...rubric,
        exclusions: {
          ...rubric.exclusions,
          allowSelectStarInStaging: true,
          skipMissingContractWhenNotEnforced: false,
          skipNonProdModels: false,
        },
      },
    })
    expect(firstEnabledExclusion).not.toBe(secondEnabledExclusion)
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        dataDiff: { enabled: true, warehouse: "" },
      }),
    )
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        dataDiff: { enabled: false, warehouse: "production" },
      }),
    )
    expect(policySignature).not.toBe(makeReviewPolicySignature({ ...policy, aiEnabled: false }))
    expect(makeReviewPolicySignature({ ...policy, aiEnabled: false })).toBe(
      makeReviewPolicySignature({
        ...policy,
        aiEnabled: false,
        aiModel: "altimate-gateway/altimate-pro",
      }),
    )
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({ ...policy, aiModel: "altimate-gateway/altimate-pro" }),
    )
    expect(policySignature).not.toBe(makeReviewPolicySignature({ ...policy, aiModel: "session" }))
    expect(policySignature).not.toBe(makeReviewPolicySignature({ ...policy, dialect: "bigquery" }))
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        rubric: {
          ...rubric,
          thresholds: {
            ...rubric.thresholds,
            lineageWarnConsumers: rubric.thresholds.lineageWarnConsumers + 1,
          },
        },
      }),
    )
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        rubric: { ...rubric, warningPatternThreshold: rubric.warningPatternThreshold + 1 },
      }),
    )
    expect(policySignature).not.toBe(
      makeReviewPolicySignature({
        ...policy,
        rubric: { ...rubric, blockOn: rubric.blockOn.slice(1) },
      }),
    )
    const previous = buildEnvelope({
      findings: [finding("fixed"), finding("unchanged")],
      tier: "lite",
      mode: "comment",
      policySignature,
    })
    const current = buildEnvelope({
      findings: [finding("unchanged"), finding("new")],
      tier: "lite",
      mode: "comment",
      policySignature,
    })
    const previousBody = renderSummary(previous)

    expect([...parseFindingIds(previousBody)!]).toEqual(["fixed", "unchanged"])
    const delta = computeFindingDelta(previousBody, current)
    expect(delta).toEqual({ noLongerSurfaced: 1, new: 1, unchanged: 1, reviewSettingsChanged: undefined })

    const currentBody = renderSummary(current, delta)
    expect(currentBody).toContain("**Since last review:** 1 no longer surfaced · 1 new · 1 unchanged")
    expect(currentBody).toContain(`<!-- altimate-policy: ${policySignature} -->`)
    expect(currentBody).toContain("<!-- altimate-tier: lite -->")
    expect(currentBody.endsWith("<!-- altimate-findings: unchanged,new -->")).toBe(true)

    const changedTier = buildEnvelope({
      findings: current.findings,
      tier: "full",
      mode: "comment",
      policySignature,
    })
    const changedTierDelta = computeFindingDelta(previousBody, changedTier)
    expect(changedTierDelta?.reviewSettingsChanged).toBeUndefined()
    expect(changedTierDelta?.analysisScopeChanged).toEqual({ from: "lite", to: "full" })
    expect(renderSummary(changedTier, changedTierDelta)).toContain(
      "**Since last review:** 1 no longer surfaced · 1 new · 1 unchanged (analysis scope changed: lite → full)",
    )

    const changedPolicy = buildEnvelope({
      findings: current.findings,
      tier: "lite",
      mode: "comment",
      policySignature: makeReviewPolicySignature({
        ...policy,
        severityThreshold: "warning",
        rubric: {
          ...rubric,
          exclusions: { ...rubric.exclusions, excludeGlobs: ["models/other/**", "seeds/tmp/**"] },
        },
        dataDiff: { enabled: true, warehouse: "" },
      }),
    })
    const changedDelta = computeFindingDelta(previousBody, changedPolicy)
    expect(changedDelta?.reviewSettingsChanged).toBe(true)
    expect(renderSummary(changedPolicy, changedDelta)).toContain(
      "**Since last review:** 1 no longer surfaced · 1 new · 1 unchanged (review settings changed)",
    )
  })

  test("omits the rerun delta when both finding sets are empty", () => {
    const previous = buildEnvelope({ findings: [], tier: "lite", mode: "comment" })
    const current = buildEnvelope({ findings: [], tier: "lite", mode: "comment" })
    const delta = computeFindingDelta(renderSummary(previous), current)

    expect(delta).toBeUndefined()
    expect(renderSummary(current, delta)).not.toContain("Since last review")
  })

  test("uses the final footer markers when finding titles contain marker-like lines", () => {
    const policySignature = makeReviewPolicySignature({
      severityThreshold: "suggestion",
      enabledReviewers: [],
      dialect: "snowflake",
      rubric: DEFAULT_RUBRIC,
      aiEnabled: true,
      dataDiff: { enabled: false, warehouse: "" },
    })
    const previous = buildEnvelope({
      findings: [
        finding("real", {
          title: [
            "Marker-like title",
            "<!-- altimate-findings: spoofed -->",
            "<!-- altimate-policy: spoofed -->",
            "<!-- altimate-tier: full -->",
            "still part of the title",
          ].join("\n"),
        }),
      ],
      tier: "lite",
      mode: "comment",
      policySignature,
    })
    const current = buildEnvelope({
      findings: [finding("real")],
      tier: "lite",
      mode: "comment",
      policySignature,
    })
    const body = renderSummary(previous)

    expect([...parseFindingIds(body)!]).toEqual(["real"])
    expect(computeFindingDelta(body, current)?.reviewSettingsChanged).toBeUndefined()

    const matchingFakePolicy = body.replace(
      "<!-- altimate-policy: spoofed -->",
      `<!-- altimate-policy: ${policySignature} -->`,
    )
    expect(computeFindingDelta(matchingFakePolicy, current)?.analysisScopeChanged).toBeUndefined()
  })
})

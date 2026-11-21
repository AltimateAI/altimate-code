import { describe, test, expect, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { makeFinding, findingOrigin, fingerprint, ruleId, type Finding } from "../../src/altimate/review/finding"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_RUBRIC, Rubric } from "../../src/altimate/review/rubric"
import { buildEnvelope, computeIdealVerdict, signEnvelope, verdictEligible, verifyEnvelope } from "../../src/altimate/review/verdict"
import { DEFAULT_REVIEW_CONFIG, policyChanges, policyHash } from "../../src/altimate/review/config"
import { reviewPullRequest } from "../../src/altimate/review/run"
import { showAtRef } from "../../src/altimate/review/git"
import { renderSummary } from "../../src/altimate/review/format"

/**
 * A verdict must mean what the docs say: only the deterministic engine blocks
 * (pattern rules and the AI lane comment), and a pull request cannot relax the
 * policy it is judged by — `.altimate/review.yml` comes from the base branch.
 */

const exec = promisify(execFile)
const g = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((r) => r.stdout.trim())

function f(tool: string | undefined, severity: Finding["severity"], category: any, i: number, rule?: string): Finding {
  return makeFinding({
    severity,
    category,
    title: `t${i}`,
    body: "b",
    file: `models/m${i}.sql`,
    confidence: "high",
    evidence: tool ? { tool, result: rule ? { rule } : {} } : undefined,
    ruleKey: `r${i}`,
  })
}

describe("only the engine blocks", () => {
  test("origin comes from the evidence tool; unknown sources are catalog", () => {
    expect(findingOrigin(f("altimate_core.equivalence", "warning", "semantic_change", 1))).toBe("engine")
    expect(findingOrigin(f("impact_analysis", "warning", "lineage_breakage", 2))).toBe("engine")
    expect(findingOrigin(f("rule-catalog", "warning", "sql_quality", 3))).toBe("catalog")
    expect(findingOrigin(f("dbt-patterns", "warning", "sql_quality", 4))).toBe("catalog")
    expect(findingOrigin(f("ai-review", "warning", "sql_quality", 5))).toBe("ai")
    expect(findingOrigin(f("some.new.detector", "warning", "sql_quality", 6))).toBe("catalog")
    expect(findingOrigin(f(undefined, "warning", "sql_quality", 7))).toBe("catalog")
  })

  test("1 catalog critical + 3 catalog warnings → COMMENT", () => {
    const findings = [
      f("rule-catalog", "critical", "sql_correctness", 1, "join-no-on"),
      f("rule-catalog", "warning", "sql_quality", 2, "a"),
      f("dbt-patterns", "warning", "sql_quality", 3, "b"),
      f("rule-catalog", "warning", "sql_quality", 4, "c"),
    ]
    expect(computeIdealVerdict(findings, DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("a catalog rule named in blockingRules can block", () => {
    const rubric = Rubric.parse({ blockingRules: ["hardcoded-credential"] })
    const cred = f("rule-catalog", "critical", "sql_correctness", 1, "hardcoded-credential")
    expect(verdictEligible(cred, rubric)).toBe(true)
    expect(computeIdealVerdict([cred], rubric)).toBe("REQUEST_CHANGES")
    expect(computeIdealVerdict([cred], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("blockingRules ids match with either spelling (`pii_into_mart` / `pii-into-mart`)", () => {
    const pii = f("dbt-patterns", "critical", "pii_exposure", 1, "pii_into_mart")
    const cred = f("rule-catalog", "critical", "sql_correctness", 2, "hardcoded-credential")
    const rubric = Rubric.parse({ blockingRules: ["pii-into-mart", "Hardcoded_Credential"] })
    expect(verdictEligible(pii, rubric)).toBe(true)
    expect(verdictEligible(cred, rubric)).toBe(true)
    expect(computeIdealVerdict([pii], rubric)).toBe("REQUEST_CHANGES")
  })

  test("a supplied origin never overrides the evidence tool", () => {
    const ai = [1, 2, 3].map((i) => ({ ...f("ai-review", "warning", "sql_quality", i), origin: "engine" as const }))
    expect(findingOrigin(ai[0])).toBe("ai")
    expect(computeIdealVerdict(ai)).toBe("COMMENT")
    const env = buildEnvelope({ findings: ai, mode: "gate", tier: "full", generatedAt: "2026-11-20T00:00:00Z" } as any)
    expect(env.findings.every((x) => x.origin === "ai")).toBe(true)
  })

  test("engine criticals and engine warning patterns still block", () => {
    expect(computeIdealVerdict([f("impact_analysis", "critical", "lineage_breakage", 1)])).toBe("REQUEST_CHANGES")
    const three = [1, 2, 3].map((i) => f("altimate_core.check", "warning", "sql_quality", i))
    expect(computeIdealVerdict(three)).toBe("REQUEST_CHANGES")
  })

  test("the envelope records each finding's origin and still verifies", () => {
    const env = buildEnvelope({
      findings: [f("rule-catalog", "warning", "sql_quality", 1), f("altimate_core.check", "warning", "sql_quality", 2)],
      tier: "lite",
      mode: "comment",
    })
    expect(env.findings.map((x) => x.origin)).toEqual(["catalog", "engine"])
    const signed = signEnvelope(env)
    expect(verifyEnvelope(signed)).toBe(true)
    // Origin is covered by the signature: flipping it breaks verification.
    const tampered = { ...signed, findings: signed.findings.map((x) => ({ ...x, origin: "engine" as const })) }
    expect(verifyEnvelope(tampered)).toBe(false)
  })
})

describe("policy helpers", () => {
  test("hash is stable and changes with the policy", () => {
    const a = structuredClone(DEFAULT_REVIEW_CONFIG)
    const b = structuredClone(DEFAULT_REVIEW_CONFIG)
    expect(policyHash(a)).toBe(policyHash(b))
    b.mode = "gate"
    expect(policyHash(a)).not.toBe(policyHash(b))
  })

  test("changes are listed by setting, rubric one level down", () => {
    const base = structuredClone(DEFAULT_REVIEW_CONFIG)
    const head = structuredClone(DEFAULT_REVIEW_CONFIG)
    head.mode = "gate"
    head.exclude = ["models/legacy/**"]
    head.rubric = { ...head.rubric, blockOn: ["lineage_breakage"] }
    expect(policyChanges(base, head)).toEqual(["exclude", "mode", "rubric.blockOn"])
  })
})

describe("policy comes from the base branch", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  async function repo(baseYml: string | undefined, headYml: string | undefined) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "review-policy-")))
    await g(root, "init", "-q", "-b", "main")
    await g(root, "config", "user.email", "t@test")
    await g(root, "config", "user.name", "t")
    await g(root, "config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(root, "models"), { recursive: true })
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: p\n")
    await fs.writeFile(path.join(root, "models", "a.sql"), "select 1 as id\n")
    if (baseYml !== undefined) {
      await fs.mkdir(path.join(root, ".altimate"), { recursive: true })
      await fs.writeFile(path.join(root, ".altimate", "review.yml"), baseYml)
    }
    await g(root, "add", "-A")
    await g(root, "commit", "-qm", "base")
    await g(root, "checkout", "-q", "-b", "feature")
    await fs.writeFile(path.join(root, "models", "a.sql"), "select 2 as id\n")
    if (headYml !== undefined) {
      await fs.mkdir(path.join(root, ".altimate"), { recursive: true })
      await fs.writeFile(path.join(root, ".altimate", "review.yml"), headYml)
    }
    await g(root, "add", "-A")
    await g(root, "commit", "-qm", "pr")
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    process.env.GITHUB_BASE_REF = "main"
    return root
  }

  test("a PR that relaxes review.yml is still judged by the base policy, and the change is shown", async () => {
    const root = await repo("mode: gate\n", "mode: comment\nexclude:\n  - models/**\nai: false\n")
    const env = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true })
    expect(env.mode).toBe("gate")
    expect(env.policy?.source).toBe("base")
    expect(env.policy?.changedInPr).toEqual(["ai", "exclude", "mode"])
    expect(renderSummary(env)).toContain("The base branch's policy was applied")
  }, 60_000)

  test("a review.yml the PR adds does not apply until merged", async () => {
    const root = await repo(undefined, "mode: gate\n")
    const env = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true })
    expect(env.mode).toBe("comment")
    expect(env.policy?.source).toBe("default")
    expect(env.policy?.changedInPr).toEqual(["mode"])
  }, 60_000)

  test("an unchanged policy is applied without a note", async () => {
    const root = await repo("mode: gate\n", undefined)
    const env = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true })
    expect(env.mode).toBe("gate")
    expect(env.policy?.changedInPr).toBeUndefined()
    expect(env.policy?.hash).toMatch(/^[0-9a-f]{16}$/)
  }, 60_000)

  test("--mode and --severity from the workflow cannot relax a base policy, only tighten it", async () => {
    const root = await repo("mode: gate\nseverityThreshold: warning\n", undefined)
    const relaxed = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true, mode: "comment", severityThreshold: "critical" })
    expect(relaxed.mode).toBe("gate")
    const tightened = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true, severityThreshold: "suggestion" })
    expect(tightened.mode).toBe("gate")
    const loose = await repo("mode: comment\n", undefined)
    expect((await reviewPullRequest({ cwd: loose, head: "HEAD", noAi: true, mode: "gate" })).mode).toBe("gate")
  }, 60_000)

  test("the signed policy hash describes the policy after the flags", async () => {
    const root = await repo("mode: comment\nseverityThreshold: warning\n", undefined)
    const plain = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true })
    const tightened = await reviewPullRequest({ cwd: root, head: "HEAD", noAi: true, mode: "gate", severityThreshold: "suggestion" })
    expect(plain.policy?.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(tightened.policy?.hash).not.toBe(plain.policy?.hash)
  }, 60_000)

  test("an unparsable base review.yml fails closed and names the recovery path", async () => {
    const root = await repo("mode: [unclosed\n", "mode: comment\n")
    await expect(reviewPullRequest({ cwd: root, head: "HEAD", noAi: true })).rejects.toThrow(/fix the file on the base branch/)
  }, 60_000)

  test("showAtRef: a path missing at the ref is absent, any other git failure surfaces", async () => {
    const root = await repo("mode: gate\n", undefined)
    expect(await showAtRef(root, "main", ".altimate/review.yaml")).toBeUndefined()
    expect(await showAtRef(root, "main", ".altimate/review.yml")).toBe("mode: gate\n")
    await expect(showAtRef(root, "no-such-ref", ".altimate/review.yml")).rejects.toThrow()
  }, 60_000)

  test("allowForceTier: false in the base policy rejects --force-tier", async () => {
    const root = await repo("allowForceTier: false\n", "allowForceTier: true\n")
    await expect(reviewPullRequest({ cwd: root, head: "HEAD", noAi: true, forceTier: "trivial" })).rejects.toThrow(
      /force-tier is disabled/,
    )
  }, 60_000)
})

describe("every finding carries a stable rule id", () => {
  const RULE_ID = /^[a-z0-9.-]+:[a-z0-9.-]+$/

  test("ruleId normalises both halves", () => {
    expect(ruleId("altimate_core.equivalence", "Not Equivalent")).toBe("altimate-core.equivalence:not-equivalent")
    expect(ruleId("ai-review", "sql_correctness")).toBe("ai-review:sql-correctness")
    expect(ruleId(" rule-catalog ", "--a/b__c--")).toBe("rule-catalog:a-b--c")
  })

  test("a review touching several lanes stamps a well-formed rule on each finding, ids unchanged", async () => {
    const sql = "select id, email, amount\nfrom {{ ref('orders') }} o, {{ ref('customers') }} c\nwhere o.id = c.id\n"
    const compiled = "select id, email, amount\nfrom db.orders o, db.customers c\nwhere o.id = c.id\n"
    const runner: ReviewRunner = {
      async impact(model) {
        const n = model === "gone" ? 3 : 0
        return { hasManifest: true, severity: n ? "BREAKING" : "SAFE", directCount: n, transitiveCount: n, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: [{ rule: "select_star", message: "avoid select *", severity: "warning" }], ran: true }
      },
      async equivalence() {
        return { decided: true, equivalent: false, differences: ["row count differs"], confidence: "high" } as any
      },
      async detectPii(sql) {
        return { columns: sql.includes("email") ? ["email"] : [] }
      },
    }
    const env = await runReview({
      changedFiles: [
        { path: "models/marts/m.sql", status: "modified", diff: sql.split("\n").map((l) => `+${l}`).join("\n") },
        { path: "models/staging/gone.sql", status: "deleted", diff: "" },
      ],
      // Report every rule, including ones the default posting policy turns off.
      config: { ...DEFAULT_REVIEW_CONFIG, dialect: "snowflake", rules: { "*": "summary" } },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      forceTier: "full",
      runner,
      getContent: async (p, side) =>
        p.endsWith("gone.sql") ? "select 1 as id\n" : side === "old" ? "select id, amount from {{ ref('orders') }}\n" : sql,
      getCompiled: async (p, side) =>
        p.endsWith("gone.sql") ? undefined : side === "old" ? "select id, amount from db.orders\n" : compiled,
    })
    const tools = new Set(env.findings.map((x) => x.evidence?.tool))
    // Engine (impact, equivalence, check, PII) and pattern lanes all fired.
    for (const t of ["impact_analysis", "altimate_core.equivalence", "altimate_core.check", "schema.detect_pii"]) {
      expect(tools.has(t)).toBe(true)
    }
    expect(env.findings.some((x) => findingOrigin(x) === "catalog")).toBe(true)
    for (const x of env.findings) expect(x.rule ?? "").toMatch(RULE_ID)

    const byTool = (t: string) => env.findings.find((x) => x.evidence?.tool === t)!
    expect(byTool("impact_analysis").rule).toBe("impact-analysis:downstream-consumers")
    expect(byTool("altimate_core.equivalence").rule).toBe("altimate-core.equivalence:not-equivalent")
    expect(byTool("altimate_core.check").rule).toBe("altimate-core.check:select-star")
    expect(byTool("schema.detect_pii").rule).toBe("schema.detect-pii:exposes")
    // The fingerprint ignores `rule`: this id was produced before the field existed.
    expect(byTool("impact_analysis").id).toBe(
      fingerprint({ category: "lineage_breakage", file: "models/staging/gone.sql", model: "gone", ruleKey: "lineage_breakage:deleted" }),
    )
    expect(byTool("impact_analysis").id).toBe("f_c13e1671eb1b007a")
  })

  test("findings without evidence carry no rule", () => {
    const x = makeFinding({ severity: "suggestion", category: "sql_quality", title: "t", body: "b", file: "a.sql" })
    expect(x.rule).toBeUndefined()
  })
})

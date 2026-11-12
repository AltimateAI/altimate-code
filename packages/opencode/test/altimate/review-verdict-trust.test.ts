import { describe, test, expect, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { makeFinding, findingOrigin, type Finding } from "../../src/altimate/review/finding"
import { DEFAULT_RUBRIC, Rubric } from "../../src/altimate/review/rubric"
import { buildEnvelope, computeIdealVerdict, signEnvelope, verdictEligible, verifyEnvelope } from "../../src/altimate/review/verdict"
import { DEFAULT_REVIEW_CONFIG, policyChanges, policyHash } from "../../src/altimate/review/config"
import { reviewPullRequest } from "../../src/altimate/review/run"
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

  test("allowForceTier: false in the base policy rejects --force-tier", async () => {
    const root = await repo("allowForceTier: false\n", "allowForceTier: true\n")
    await expect(reviewPullRequest({ cwd: root, head: "HEAD", noAi: true, forceTier: "trivial" })).rejects.toThrow(
      /force-tier is disabled/,
    )
  }, 60_000)
})

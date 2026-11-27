import { describe, test, expect } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding, repeatGroupId, ruleId, type Finding } from "../../src/altimate/review/finding"
import { NOISY_RULES_OFF, dropRulesOff, resolveRulesOff, rulesOffEnv } from "../../src/altimate/review/rules-off"
import { envSwitch, resolveAiSwitches } from "../../src/altimate/review/ai-switches"
import type { AiLaneStatus, AiReviewInput } from "../../src/altimate/review/ai-review"

// Rule types off: the shipped list drops those rule findings once the AI lane runs.

const finding = (rule: string, tool = "dbt-patterns", n = 1, severity: Finding["severity"] = "warning"): Finding =>
  makeFinding({
    severity,
    category: "sql_quality",
    title: `m: ${rule} ${n}`,
    body: "b",
    file: "models/m.sql",
    evidence: { tool, result: {} },
    ruleKey: `${rule}-${n}`,
    rule,
  })

describe("NOISY_RULES_OFF", () => {
  test("36 distinct rule ids", () => {
    expect(NOISY_RULES_OFF).toHaveLength(36)
    expect(new Set(NOISY_RULES_OFF).size).toBe(36)
    for (const r of NOISY_RULES_OFF) expect(r).toMatch(/^[a-z.-]+:[a-z0-9-]+$/)
  })
})

describe("resolveRulesOff", () => {
  const on = { rulesOff: true }

  test("default: the shipped list; switch off: undefined", () => {
    expect([...resolveRulesOff({ ai: true }, on, {})!]).toEqual([...NOISY_RULES_OFF])
    expect(resolveRulesOff({ ai: true }, { rulesOff: false }, {})).toBeUndefined()
  })

  test("`ai.rulesOn` takes single ids back out", () => {
    const cfg = parseReviewConfig(`ai:\n  rulesOn:\n    - ${NOISY_RULES_OFF[0]}\n    - not:in-the-list`)
    const off = resolveRulesOff(cfg, resolveAiSwitches(cfg, {}), {})!
    expect(off.has(NOISY_RULES_OFF[0])).toBe(false)
    expect(off.size).toBe(NOISY_RULES_OFF.length - 1)
  })

  test("`ai.rulesOff: false` and `ALTIMATE_REVIEW_RULES_OFF=0` keep every type", () => {
    const cfg = parseReviewConfig("ai:\n  rulesOff: false")
    expect(resolveRulesOff(cfg, resolveAiSwitches(cfg, {}), {})).toBeUndefined()
    const env = { ALTIMATE_REVIEW_RULES_OFF: "0" }
    expect(resolveRulesOff({ ai: true }, resolveAiSwitches({ ai: true }, env), env)).toBeUndefined()
  })

  test("`ALTIMATE_REVIEW_RULES_OFF=<file>` replaces the list, even over `ai.rulesOff: false`; a bad file is an error", async () => {
    await using tmp = await tmpdir()
    let n = 0
    const listFile = (body: string) => {
      const file = join(tmp.path, `rules_off_${n++}.json`)
      writeFileSync(file, body)
      return file
    }
    const file = listFile('["a:b", "c:d"]')
    const env = { ALTIMATE_REVIEW_RULES_OFF: file }
    expect(envSwitch("rulesOff", env)).toBe(true)
    const cfg = parseReviewConfig("ai:\n  rulesOff: false")
    expect([...resolveRulesOff(cfg, resolveAiSwitches(cfg, env), env)!]).toEqual(["a:b", "c:d"])
    const bad = (body: string) => ({ ALTIMATE_REVIEW_RULES_OFF: listFile(body) })
    expect(() => resolveRulesOff({ ai: true }, on, bad('{"a": 1}'))).toThrow(/JSON list of rule ids/)
    expect(() => resolveRulesOff({ ai: true }, on, bad("[1]"))).toThrow(/JSON list of rule ids/)
    // A missing or unparsable file names the variable and the file, not a bare ENOENT or SyntaxError.
    expect(() => resolveRulesOff({ ai: true }, on, { ALTIMATE_REVIEW_RULES_OFF: "/nonexistent/rules_off.json" })).toThrow(
      "ALTIMATE_REVIEW_RULES_OFF: cannot read the rule list /nonexistent/rules_off.json: file not found",
    )
    const broken = listFile("[not json")
    expect(() => resolveRulesOff({ ai: true }, on, { ALTIMATE_REVIEW_RULES_OFF: broken })).toThrow(
      new RegExp(`^ALTIMATE_REVIEW_RULES_OFF: cannot read the rule list ${broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `),
    )
  })

  test("`ALTIMATE_REVIEW_RULES_OFF` spellings: on/off/true/false switch; only a path-like value is a file", () => {
    for (const v of ["0", "off", "OFF", "false", "False"]) {
      const env = { ALTIMATE_REVIEW_RULES_OFF: v }
      expect(envSwitch("rulesOff", env)).toBe(false)
      expect(resolveRulesOff({ ai: true }, resolveAiSwitches({ ai: true }, env), env)).toBeUndefined()
    }
    for (const v of ["1", "on", "true", "TRUE"]) {
      const env = { ALTIMATE_REVIEW_RULES_OFF: v }
      expect(envSwitch("rulesOff", env)).toBe(true)
      // The shipped list; no file is read.
      expect([...resolveRulesOff({ ai: true }, resolveAiSwitches({ ai: true }, env), env)!]).toEqual([...NOISY_RULES_OFF])
    }
    // Not a switch value and not a path: ignored (config and default decide), never read as a file.
    const odd = { ALTIMATE_REVIEW_RULES_OFF: "yes please" }
    expect(envSwitch("rulesOff", odd)).toBeUndefined()
    expect([...resolveRulesOff({ ai: true }, resolveAiSwitches({ ai: true }, odd), odd)!]).toEqual([...NOISY_RULES_OFF])
    expect(rulesOffEnv("rules_off.json")).toEqual({ on: true, file: "rules_off.json" })
    expect(rulesOffEnv("./list")).toEqual({ on: true, file: "./list" })
    expect(rulesOffEnv("C:\\lists\\off")).toEqual({ on: true, file: "C:\\lists\\off" })
  })

  test("`ai.rulesOn` ids match in either spelling", () => {
    const cfg = parseReviewConfig("ai:\n  rulesOn:\n    - dbt_patterns:self_join\n    - RULE-CATALOG:Nested_Case")
    const off = resolveRulesOff(cfg, resolveAiSwitches(cfg, {}), {})!
    expect(off.has("dbt-patterns:self-join")).toBe(false)
    expect(off.has("rule-catalog:nested-case")).toBe(false)
    expect(off.size).toBe(NOISY_RULES_OFF.length - 2)
  })
})

describe("dropRulesOff", () => {
  test("drops listed rule findings and counts them per rule; AI findings and unlisted rules stay", () => {
    const fs = [
      finding("dbt-patterns:select-star", "dbt-patterns", 1),
      finding("dbt-patterns:select-star", "dbt-patterns", 2),
      finding("rule-catalog:order-by", "rule-catalog"),
      finding("dbt-patterns:kept"),
      finding(ruleId("ai-review", "sql_quality"), "ai-review"),
    ]
    const off = new Set(["dbt-patterns:select-star", "rule-catalog:order-by", ruleId("ai-review", "sql_quality")])
    const r = dropRulesOff(fs, off)
    expect(r.kept.map((f) => f.rule)).toEqual(["dbt-patterns:kept", ruleId("ai-review", "sql_quality")])
    expect(r.dropped).toEqual({ "dbt-patterns:select-star": 2, "rule-catalog:order-by": 1 })
    expect(dropRulesOff(fs, undefined)).toEqual({ kept: fs, dropped: {} })
    expect(dropRulesOff(fs, new Set())).toEqual({ kept: fs, dropped: {} })
  })

  test("critical rule findings are never dropped, e.g. a new high-confidence PII column in a mart", () => {
    const pii = "altimate-core.classify-pii:exposes"
    expect(NOISY_RULES_OFF).toContain(pii)
    const critical = finding(pii, "altimate_core.classify_pii", 1, "critical")
    const warning = finding(pii, "altimate_core.classify_pii", 2, "warning")
    const r = dropRulesOff([critical, warning], new Set(NOISY_RULES_OFF))
    expect(r.kept).toEqual([critical])
    expect(r.dropped).toEqual({ [pii]: 1 })
  })

  test("a finding's rule id matches the list in either spelling", () => {
    const r = dropRulesOff([finding("dbt_patterns:self_join")], new Set(["dbt-patterns:self-join"]))
    expect(r.kept).toEqual([])
    // Counted under the normalized id, so two spellings of one rule add up.
    expect(r.dropped).toEqual({ "dbt-patterns:self-join": 1 })
  })
})

describe("orchestrator: rule types off", () => {
  const runner: ReviewRunner = {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "B" }
    },
    async check() {
      return { issues: [], ran: true }
    },
    async equivalence() {
      return { decided: true, equivalent: true }
    },
    async detectPii() {
      return { columns: [] }
    },
  } as ReviewRunner
  const SQL = "select *\nfrom raw.orders\nwhere status = 'x'\norder by 1"
  const run = (opts: { seen?: AiReviewInput[]; rulesOff?: Set<string>; ai?: boolean; status?: AiLaneStatus; aiFindings?: Finding[] }) =>
    runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
      generatedAt: "2026-11-25T00:00:00Z",
      ...(opts.rulesOff ? { rulesOff: opts.rulesOff } : {}),
      ...(opts.ai === false
        ? {}
        : {
            aiReview: async (input: AiReviewInput) => {
              opts.seen?.push(input)
              return { findings: opts.aiFindings ?? [], status: opts.status ?? { state: "ok" as const } }
            },
          }),
    })

  test("listed rule findings are dropped and counted; the finder's input is unchanged", async () => {
    const offSeen: AiReviewInput[] = []
    const base = await run({ seen: offSeen })
    expect(base.rulesOff).toBeUndefined()
    const rules = [...new Set(base.findings.map((f) => f.rule!))]
    expect(rules.length).toBeGreaterThan(1)
    const target = rules[0]
    const n = base.findings.filter((f) => f.rule === target).length

    const onSeen: AiReviewInput[] = []
    const on = await run({ seen: onSeen, rulesOff: new Set([target, "dbt-patterns:not-in-this-pr"]) })
    expect(on.findings).toEqual(base.findings.filter((f) => f.rule !== target))
    expect(on.rulesOff).toEqual({ [target]: n })
    // The summary tallies the verdict's findings, which rule-noise steps do not filter.
    expect(on.summary).toEqual(base.summary)
    // The finder's grounding is the same as without the list.
    expect(onSeen[0]).toEqual(offSeen[0])

    // A list that matches nothing: same findings, an empty record.
    const none = await run({ rulesOff: new Set(["x:y"]) })
    expect(none.findings).toEqual(base.findings)
    expect(none.rulesOff).toEqual({})
  })

  test("AI lane configured but skipped or failed: the list is not applied (fail-open)", async () => {
    const base = await run({})
    const target = base.findings[0].rule!
    for (const status of [
      { state: "skipped", reason: "dry run (ALTIMATE_REVIEW_AI_DRYRUN=1): no model call" },
      { state: "skipped", reason: "no usable model: none configured" },
      { state: "error", reason: "provider unreachable" },
      { state: "timeout", reason: "slow" },
    ] as AiLaneStatus[]) {
      const env = await run({ rulesOff: new Set([target]), status })
      expect(env.findings).toEqual(base.findings)
      expect(env.rulesOff).toBeUndefined()
    }
  })

  test("a repeat-merged comment with an AI member is not dropped with its rule finding", async () => {
    const base = await run({})
    const rule = base.findings.find((f) => f.severity !== "critical" && f.startLine)!
    // The same file, category, severity and title as the rule finding, so the two merge; its body
    // sorts after the rule finding's, so the merged comment is led by the rule finding.
    const ai = makeFinding({
      severity: rule.severity,
      category: rule.category,
      title: rule.title,
      body: "zzz the AI finder's own catch",
      file: rule.file,
      startLine: rule.startLine,
      endLine: rule.startLine,
      confidence: "medium",
      evidence: { tool: "ai-review", result: {} },
      ruleKey: "ai:merged-with-rule",
      rule: ruleId("ai-review", rule.category),
    })
    const merged = await run({ aiFindings: [ai] })
    const group = merged.findings.find((f) => f.id === repeatGroupId(rule))
    expect(group?.body).toContain("zzz the AI finder's own catch")
    const off = await run({ aiFindings: [ai], rulesOff: new Set([rule.rule!]) })
    expect(off.findings.find((f) => f.id === repeatGroupId(rule))).toEqual(group)
  })

  test("AI lane off: the list is ignored and the envelope is unchanged", async () => {
    const base = await run({ ai: false })
    const target = base.findings[0].rule!
    const withList = await run({ ai: false, rulesOff: new Set([target]) })
    expect(withList).toEqual(base)
    expect(withList.rulesOff).toBeUndefined()
  })
})

describe("round 2: rule types off", () => {
  test("counts are keyed by the normalized rule id, so two spellings add up", () => {
    const a = finding("dbt_patterns:self_join", "dbt-patterns", 1)
    const b = finding("dbt-patterns:self-join", "dbt-patterns", 2)
    expect(dropRulesOff([a, b], new Set(["dbt-patterns:self-join"])).dropped).toEqual({ "dbt-patterns:self-join": 2 })
  })

  test("ALTIMATE_REVIEW_RULES_OFF=<file> must be absolute and outside the git work tree", async () => {
    const on = { rulesOff: true }
    expect(() => resolveRulesOff({ ai: true }, on, { ALTIMATE_REVIEW_RULES_OFF: "rules_off.json" })).toThrow("absolute path")
    await using repo = await tmpdir({ git: true })
    const inside = join(repo.path, "rules_off.json")
    writeFileSync(inside, '["a:b"]')
    expect(() => resolveRulesOff({ ai: true }, on, { ALTIMATE_REVIEW_RULES_OFF: inside }, repo.path)).toThrow("inside the git work tree")
  })
})

describe("round 2: rule types off apply only to files the AI lane reviewed", () => {
  const runner: ReviewRunner = {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "B" }
    },
    async check() {
      return { issues: [], ran: true }
    },
    async equivalence() {
      return { decided: true, equivalent: true }
    },
    async detectPii() {
      return { columns: [] }
    },
  } as ReviewRunner
  const SQL = "select *\nfrom raw.orders\nwhere status = 'x'\norder by 1"
  const run = (rulesOff: Set<string> | undefined, status: AiLaneStatus) =>
    runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
      generatedAt: "2026-11-27T00:00:00Z",
      ...(rulesOff ? { rulesOff } : {}),
      aiReview: async () => ({ findings: [], status }),
    })

  test("the file's call failed while others answered: its rule findings of off types are posted", async () => {
    const base = await run(undefined, { state: "ok" })
    const target = base.findings[0].rule!
    const reviewed = await run(new Set([target]), { state: "ok" })
    expect(reviewed.findings.length).toBeLessThan(base.findings.length)
    const failed = await run(new Set([target]), { state: "ok", reason: "1 of 2 calls failed: boom", failedFiles: ["models/marts/m.sql"] })
    expect(failed.findings).toEqual(base.findings)
  })
})

describe("round 2b: rules-off env and list file", () => {
  test("`yes`/`no` work like the other switches; the warning names the extra spellings", () => {
    expect(rulesOffEnv("no").on).toBe(false)
    expect(rulesOffEnv("YES").on).toBe(true)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_RULES_OFF: "no" }).rulesOff).toBe(false)
    const write0 = process.stderr.write
    let err = ""
    ;(process.stderr as any).write = (s: string) => ((err += s), true)
    try {
      resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY_RULES: "sometimes-2b" })
    } finally {
      ;(process.stderr as any).write = write0
    }
    expect(err).toContain("drop_refuted/off")
  })

  test("a list named `..x.json` inside the review's repository is refused", async () => {
    await using repo = await tmpdir({ git: true })
    const file = join(repo.path, "..rules.json")
    writeFileSync(file, '["a:b"]')
    expect(() => resolveRulesOff({ ai: true }, { rulesOff: true }, { ALTIMATE_REVIEW_RULES_OFF: file }, repo.path)).toThrow("inside the git work tree")
  })

  test("fails closed when no work tree resolves; the review's repository is checked from anywhere", async () => {
    await using repo = await tmpdir({ git: true })
    await using elsewhere = await tmpdir()
    const file = join(repo.path, "rules.json")
    writeFileSync(file, '["a:b"]')
    const cwd = process.cwd()
    process.chdir(elsewhere.path)
    try {
      expect(() => resolveRulesOff({ ai: true }, { rulesOff: true }, { ALTIMATE_REVIEW_RULES_OFF: file })).toThrow("refusing it")
      expect(() => resolveRulesOff({ ai: true }, { rulesOff: true }, { ALTIMATE_REVIEW_RULES_OFF: file }, repo.path)).toThrow("inside the git work tree")
    } finally {
      process.chdir(cwd)
    }
  })
})

describe("round 3: rules-off, verification and explainable verdicts", () => {
  const runner: ReviewRunner = {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "B" }
    },
    async check() {
      return { issues: [], ran: true }
    },
    async equivalence() {
      return { decided: true, equivalent: true }
    },
    async detectPii() {
      return { columns: [] }
    },
  } as ReviewRunner
  const SQL = "select *\nfrom raw.orders\nwhere status = 'x'\norder by 1"
  const model = { path: "models/marts/m.sql", status: "modified" as const, diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }
  const yml = { path: "config/extra.yml", status: "modified" as const, diff: "@@ -1 +1 @@\n-a: 1\n+a: [\n" }
  const run = (changed: any[], rulesOff: Set<string> | undefined, seen: AiReviewInput[] = []) =>
    runReview({
      changedFiles: changed,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiVerify: true,
      aiSwitches: { verifyRules: true, otherFiles: false },
      getContent: async (f, side) => (f.endsWith(".yml") ? (side === "old" ? "a: 1\n" : "a: [\n") : side === "old" ? "select 1" : SQL),
      generatedAt: "2026-11-27T00:00:00Z",
      ...(rulesOff ? { rulesOff } : {}),
      aiReview: async (input: AiReviewInput) => {
        seen.push(input)
        return { findings: [], status: { state: "ok" as const } }
      },
    })

  test("a rules-off finding on a file the AI lane does not send is verified (it will be posted)", async () => {
    const base = await run([model, yml], undefined)
    const ymlRule = base.findings.find((f) => f.file === "config/extra.yml")?.rule
    expect(ymlRule).toBeDefined()
    const seen: AiReviewInput[] = []
    await run([model, yml], new Set([ymlRule!]), seen)
    expect(seen[0].files.map((f) => f.path)).not.toContain("config/extra.yml")
    expect((seen[0].verifyRulesAfter ?? []).some((f) => f.file === "config/extra.yml")).toBe(true)
  })

})

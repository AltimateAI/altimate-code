import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding, ruleId, type Finding } from "../../src/altimate/review/finding"
import { NOISY_RULES_OFF, dropRulesOff, resolveRulesOff } from "../../src/altimate/review/rules-off"
import { envSwitch, resolveAiSwitches } from "../../src/altimate/review/ai-switches"
import type { AiReviewInput } from "../../src/altimate/review/ai-review"

// Rule types off: the shipped list drops those rule findings once the AI lane runs.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function listFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rules-off-"))
  dirs.push(dir)
  const file = join(dir, "rules_off.json")
  writeFileSync(file, body)
  return file
}

const finding = (rule: string, tool = "dbt-patterns", n = 1): Finding =>
  makeFinding({
    severity: "warning",
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

  test("`ALTIMATE_REVIEW_RULES_OFF=<file>` replaces the list, even over `ai.rulesOff: false`; a bad file is an error", () => {
    const file = listFile('["a:b", "c:d"]')
    const env = { ALTIMATE_REVIEW_RULES_OFF: file }
    expect(envSwitch("rulesOff", env)).toBe(true)
    const cfg = parseReviewConfig("ai:\n  rulesOff: false")
    expect([...resolveRulesOff(cfg, resolveAiSwitches(cfg, env), env)!]).toEqual(["a:b", "c:d"])
    const bad = (body: string) => ({ ALTIMATE_REVIEW_RULES_OFF: listFile(body) })
    expect(() => resolveRulesOff({ ai: true }, on, bad('{"a": 1}'))).toThrow(/JSON list of rule ids/)
    expect(() => resolveRulesOff({ ai: true }, on, bad("[1]"))).toThrow(/JSON list of rule ids/)
    expect(() => resolveRulesOff({ ai: true }, on, { ALTIMATE_REVIEW_RULES_OFF: "/nonexistent/rules_off.json" })).toThrow()
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
  const run = (opts: { seen?: AiReviewInput[]; rulesOff?: Set<string>; ai?: boolean }) =>
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
              return { findings: [], status: { state: "ok" as const } }
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
    expect(on.summary.warning + on.summary.critical + on.summary.suggestion).toBe(base.findings.length - n)
    // The finder's grounding is the same as without the list.
    expect(onSeen[0]).toEqual(offSeen[0])

    // A list that matches nothing: same findings, an empty record.
    const none = await run({ rulesOff: new Set(["x:y"]) })
    expect(none.findings).toEqual(base.findings)
    expect(none.rulesOff).toEqual({})
  })

  test("AI lane off: the list is ignored and the envelope is unchanged", async () => {
    const base = await run({ ai: false })
    const target = base.findings[0].rule!
    const withList = await run({ ai: false, rulesOff: new Set([target]) })
    expect(withList).toEqual(base)
    expect(withList.rulesOff).toBeUndefined()
  })
})

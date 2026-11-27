import { describe, test, expect } from "bun:test"
import { mergeProjectEnvelopes } from "../../src/altimate/review/multi-project"
import { renderSummary } from "../../src/altimate/review/format"
import { makeFinding, type Finding } from "../../src/altimate/review/finding"
import {
  applyMode,
  buildEnvelope,
  computeIdealVerdict,
  verdictEligible,
  type ReviewMode,
  type Verdict,
  type VerdictEnvelope,
} from "../../src/altimate/review/verdict"

// `--all-projects` withheld lists over every two-project combination of mode, posted findings,
// withheld findings and an incomplete review. Each project's envelope is built the way runReview
// builds it: the verdict counts posted and withheld findings, and the withheld ones are listed only
// when they change the project's own verdict (orchestrate.ts, `listed`).

type Level = "rc" | "comment" | "none"
interface Spec {
  mode: ReviewMode
  posted: Level
  withheld: Level
  incomplete: boolean
}

const RANK: Record<Verdict, number> = { APPROVE: 0, COMMENT: 1, REQUEST_CHANGES: 2 }
const worst = (vs: Verdict[]) => vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))

function engine(file: string, key: string, severity: Finding["severity"]): Finding {
  return makeFinding({
    severity,
    category: "lineage_breakage",
    title: `m: ${key}`,
    body: "b",
    file,
    evidence: { tool: "impact_analysis", result: {} },
    ruleKey: `${file}:${key}`,
  })
}

function project(root: string, spec: Spec) {
  const file = `${root}/models/m.sql`
  // A blocking critical reaches REQUEST_CHANGES; a suggestion only COMMENT.
  const posted =
    spec.posted === "rc" ? [engine(file, "crit", "critical")] : spec.posted === "comment" ? [engine(file, "sugg", "suggestion")] : []
  // Three confident warnings reach REQUEST_CHANGES (the pattern threshold); two only COMMENT.
  const n = spec.withheld === "rc" ? 3 : spec.withheld === "comment" ? 2 : 0
  const withheld = Array.from({ length: n }, (_, i) => engine(file, `warn-${i}`, "warning"))
  const idealAll = computeIdealVerdict([...posted, ...withheld])
  const idealPosted = computeIdealVerdict(posted)
  const blocking = (f: Finding) => f.severity === "warning" && f.confidence !== "unknown" && verdictEligible(f)
  const listed =
    idealAll === "REQUEST_CHANGES" && idealPosted !== "REQUEST_CHANGES"
      ? withheld.filter(blocking)
      : idealAll !== "APPROVE" && idealPosted === "APPROVE"
        ? withheld
        : []
  const env = buildEnvelope({
    findings: posted,
    verdictFindings: [...posted, ...withheld],
    withheld: listed.map((f) => ({ id: f.id, title: f.title, file: f.file, severity: f.severity, reason: "refuted" as const })),
    mode: spec.mode,
    tier: "full",
    scope: {
      notReviewed: [],
      ...(spec.incomplete ? { unverified: [{ path: file, reason: "no compiled SQL", kind: "not_compiled" as const, side: "head" as const }] } : {}),
    },
  })
  // The verdict on the posted findings alone, with and without the incomplete-review raise.
  const withoutWithheld = applyMode(idealPosted === "APPROVE" && spec.incomplete ? "COMMENT" : idealPosted, spec.mode)
  return { root, file, spec, env, withoutWithheld }
}

const specs: Spec[] = (["gate", "comment"] as const).flatMap((mode) =>
  (["rc", "comment", "none"] as const).flatMap((posted) =>
    (["rc", "comment", "none"] as const).flatMap((withheld) =>
      [true, false].map((incomplete) => ({ mode, posted, withheld, incomplete })),
    ),
  ),
)

const label = (s: Spec) => `${s.mode}/posted:${s.posted}/withheld:${s.withheld}${s.incomplete ? "/incomplete" : ""}`

/** The invariants one merged envelope breaks, as readable strings (empty when it keeps them all). */
function violations(a: Spec, b: Spec): string[] {
  const ps = [project("a", a), project("b", b)]
  const merged: VerdictEnvelope = mergeProjectEnvelopes(ps.map((p) => ({ root: p.root, paths: [p.file], env: p.env })))
  const vm = merged.verdict
  const listedIds = new Set((merged.withheld ?? []).map((w) => w.id))
  const out: string[] = []
  // (i) A merged verdict that rests on withheld findings (lower without every project's) lists
  // them: every list of a project at that verdict is kept.
  if (RANK[worst(ps.map((p) => p.withoutWithheld))] < RANK[vm])
    for (const p of ps)
      if (p.env.verdict === vm)
        for (const w of p.env.withheld ?? []) if (!listedIds.has(w.id)) out.push(`(i) ${p.root}'s ${w.id} not listed under ${vm}`)
  // (ii) The comment never shows a non-zero tally next to "No issues found".
  const tally = merged.summary.critical + merged.summary.warning + merged.summary.suggestion
  if (tally > 0 && renderSummary(merged, { maxChars: Infinity }).includes("No issues found"))
    out.push(`(ii) tally ${tally} with "No issues found"`)
  // (iii) Lists are those of the projects at the merged verdict, each as its own comment shows it;
  // a list of a project below the merged verdict is not shown under it.
  for (const p of ps) {
    const own = p.env.withheld ?? []
    const shown = own.filter((w) => listedIds.has(w.id))
    if (p.env.verdict !== vm && shown.length) out.push(`(iii) ${p.root}'s list (at ${p.env.verdict}) shown under ${vm}`)
    if (p.env.verdict === vm && shown.length !== own.length) out.push(`(iii) ${p.root}'s own list not shown under ${vm}`)
  }
  // (iv) Every finding the merged tally counts is posted or listed, apart from the withheld findings
  // a project's own comment counts without listing: merging hides no counted finding.
  const count = (t: VerdictEnvelope["summary"]) => t.critical + t.warning + t.suggestion
  const hidden = (e: VerdictEnvelope, listed: number) => count(e.summary) - e.findings.length - listed
  const ownHidden = ps.reduce((n, p) => n + hidden(p.env, p.env.withheld?.length ?? 0), 0)
  if (hidden(merged, listedIds.size) !== ownHidden)
    out.push(`(iv) ${hidden(merged, listedIds.size)} counted findings neither posted nor listed (the projects' own comments: ${ownHidden})`)
  return out
}

describe("--all-projects: withheld lists over every two-project combination", () => {
  test("the listed withheld findings explain the merged verdict and the tally; lists below the merged verdict are not shown", () => {
    const failures: string[] = []
    for (const a of specs)
      for (const b of specs) for (const v of violations(a, b)) failures.push(`a=${label(a)} b=${label(b)}: ${v}`)
    expect(specs.length).toBe(36)
    expect(failures).toEqual([])
  })

  test("a gate project blocking on withheld findings keeps its list next to a comment-mode posted critical", () => {
    const a = project("a", { mode: "gate", posted: "none", withheld: "rc", incomplete: false })
    const b = project("b", { mode: "comment", posted: "rc", withheld: "none", incomplete: false })
    const merged = mergeProjectEnvelopes([a, b].map((p) => ({ root: p.root, paths: [p.file], env: p.env })))
    expect(merged.verdict).toBe("REQUEST_CHANGES")
    expect(merged.withheld?.map((w) => w.id).sort()).toEqual(a.env.withheld!.map((w) => w.id).sort())
  })

  test("comment mode: posted suggestions and withheld warnings next to a clean project keep the list", () => {
    const a = project("a", { mode: "comment", posted: "comment", withheld: "rc", incomplete: false })
    const b = project("b", { mode: "comment", posted: "none", withheld: "none", incomplete: false })
    const merged = mergeProjectEnvelopes([a, b].map((p) => ({ root: p.root, paths: [p.file], env: p.env })))
    expect(merged.verdict).toBe("COMMENT")
    expect(merged.summary.warning).toBe(3)
    expect(merged.withheld?.map((w) => w.id).sort()).toEqual(a.env.withheld!.map((w) => w.id).sort())
  })

  test("withheld-only warnings next to a project at COMMENT only because a check did not run are listed", () => {
    const a = project("a", { mode: "gate", posted: "none", withheld: "comment", incomplete: false })
    const b = project("b", { mode: "gate", posted: "none", withheld: "none", incomplete: true })
    const merged = mergeProjectEnvelopes([a, b].map((p) => ({ root: p.root, paths: [p.file], env: p.env })))
    expect(merged.verdict).toBe("COMMENT")
    expect(merged.summary.warning).toBe(2)
    expect(merged.withheld).toHaveLength(2)
    const body = renderSummary(merged, { maxChars: Infinity })
    expect(body).toContain("### Withheld rule findings")
    expect(body).not.toContain("No issues found")
  })
})

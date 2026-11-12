import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding } from "../../src/altimate/review/finding"
import { aiTimeoutMs } from "../../src/altimate/review/ai-review"
import { coverageNotes, renderSummary } from "../../src/altimate/review/format"
import { prContextFromEnv } from "../../src/altimate/review/run"
import { verifyEnvelope } from "../../src/altimate/review/verdict"

/**
 * The PR comment must be honest about what was checked: a manifest-backed run
 * is not "lint-only" because one finding was undecidable, the advisory AI lane
 * never fails silently, and the PR's title/description reach the intent check.
 */

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
    // Undecidable → the semantic lane emits a `degraded` finding.
    return { decided: false }
  },
  async detectPii() {
    return { columns: [] }
  },
} as ReviewRunner

const modified = [{ path: "models/marts/m.sql", status: "modified" as const, diff: "-select 1 as id\n+select 2 as id\n" }]
const content = async (_f: string, side: "old" | "new") => (side === "old" ? "select 1 as id" : "select 2 as id")

function review(extra: Partial<Parameters<typeof runReview>[0]> = {}) {
  return runReview({
    changedFiles: modified,
    config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change", "ai_review"] },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    getContent: content,
    getCompiled: content,
    generatedAt: "2026-11-12T00:00:00Z",
    ...extra,
  })
}

describe("lint-only banner", () => {
  test("an undecidable finding on a manifest-backed run does not flip the run to lint-only", async () => {
    const env = await review()
    expect(env.findings.some((f) => f.degraded)).toBe(true)
    expect(env.summary.degraded).toBe(false)
    const md = renderSummary(env)
    expect(md).not.toContain("Lint-only run")
    expect(md).toContain("could not be decided by the engine")
  })

  test("no manifest for the changed models is still lint-only", async () => {
    const env = await review({
      runner: {
        ...runner,
        async impact() {
          return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
        },
      } as ReviewRunner,
    })
    expect(env.summary.degraded).toBe(true)
    expect(renderSummary(env)).toContain("Lint-only run")
  })
})

describe("advisory AI lane status", () => {
  test("disabled lane is reported as skipped with the reason", async () => {
    const env = await review({ aiDisabledReason: "disabled by --no-ai" })
    expect(env.ai).toEqual({ state: "skipped", reason: "disabled by --no-ai" })
    expect(coverageNotes(env).join("\n")).toContain("Advisory AI review skipped: disabled by --no-ai")
  })

  test("lane outside the tier is reported as skipped", async () => {
    const env = await review({ config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"] } })
    expect(env.ai?.state).toBe("skipped")
    expect(env.ai?.reason).toContain("tier")
  })

  test("a timeout is surfaced, signed, and never blocks", async () => {
    const env = await review({
      aiReview: async () => ({ findings: [], status: { state: "timeout", reason: "no answer within 75 s", durationMs: 75000 } }),
    })
    expect(env.ai?.state).toBe("timeout")
    expect(verifyEnvelope(env)).toBe(true)
    expect(renderSummary(env)).toContain("Advisory AI review timed out: no answer within 75 s")
  })

  test("a throwing lane becomes an error status instead of vanishing", async () => {
    const env = await review({
      aiReview: async () => {
        throw new Error("provider exploded")
      },
    })
    expect(env.ai).toEqual({ state: "error", reason: "provider exploded" })
  })

  test("a successful lane is ok, its model goes in the footer, and the model selector is passed through", async () => {
    let sawModel: string | undefined
    const env = await review({
      aiModel: "anthropic/claude-sonnet-5-5",
      aiReview: async (input) => {
        sawModel = input.model
        return {
          findings: [
            makeFinding({
              severity: "critical",
              category: "semantic_change",
              title: "m: intent mismatch",
              body: "x",
              file: "models/marts/m.sql",
              model: "m",
              confidence: "medium",
              evidence: { tool: "ai-review", result: {} },
              ruleKey: "ai:t",
            }),
          ],
          status: { state: "ok", model: "anthropic/claude-sonnet-5-5", durationMs: 1200 },
        }
      },
    })
    expect(sawModel).toBe("anthropic/claude-sonnet-5-5")
    expect(env.ai?.state).toBe("ok")
    // Clamped: the AI lane never blocks.
    expect(env.findings.find((f) => f.evidence?.tool === "ai-review")?.severity).toBe("warning")
    expect(renderSummary(env)).toContain("AI `anthropic/claude-sonnet-5-5`")
    expect(coverageNotes(env).join("\n")).not.toContain("Advisory AI review")
  })

  test("legacy lanes returning a bare findings array still work", async () => {
    const env = await review({ aiReview: async () => [] })
    expect(env.ai?.state).toBe("ok")
  })

  test("timeout scales with the prompt and is capped", () => {
    expect(aiTimeoutMs(0)).toBe(60_000)
    expect(aiTimeoutMs(30_000)).toBe(75_000)
    expect(aiTimeoutMs(10_000_000)).toBe(300_000)
  })
})

describe("PR title and description reach the intent check", () => {
  test("GitHub: read from the pull_request event", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "review-event-"))
    const ev = path.join(dir, "event.json")
    await fs.writeFile(ev, JSON.stringify({ pull_request: { title: "Add fct_orders", body: "## Spec\n- grain: order_id" } }))
    expect(await prContextFromEnv({ GITHUB_EVENT_PATH: ev })).toEqual({
      prTitle: "Add fct_orders",
      prBody: "## Spec\n- grain: order_id",
    })
  })

  test("GitLab: read from the merge-request variables", async () => {
    expect(
      await prContextFromEnv({ CI_MERGE_REQUEST_TITLE: "Fix grain", CI_MERGE_REQUEST_DESCRIPTION: "dedupe on id" }),
    ).toEqual({ prTitle: "Fix grain", prBody: "dedupe on id" })
  })

  test("outside a PR run there is no context", async () => {
    expect(await prContextFromEnv({})).toEqual({ prTitle: undefined, prBody: undefined })
  })

  test("the context is forwarded to the AI lane", async () => {
    let seen: { prTitle?: string; prBody?: string } = {}
    await review({
      prTitle: "Add fct_orders",
      prBody: "grain: order_id",
      aiReview: async (input) => {
        seen = { prTitle: input.prTitle, prBody: input.prBody }
        return []
      },
    })
    expect(seen).toEqual({ prTitle: "Add fct_orders", prBody: "grain: order_id" })
  })
})

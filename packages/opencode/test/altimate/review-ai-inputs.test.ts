import { describe, test, expect } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { buildUserMessage, selectAiFiles, type AiReviewFile, type AiReviewInput } from "../../src/altimate/review/ai-review"
import type { ChangedFile } from "../../src/altimate/review/diff-filter"

/**
 * Defects in macros, singular tests and yml never show in a model diff, so the
 * advisory lane receives every changed dbt file, each labeled with its role.
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
    return { decided: true, equivalent: true }
  },
  async detectPii() {
    return { columns: [] }
  },
} as ReviewRunner

const FILES: Record<string, string> = {
  "models/marts/m.sql": "select 2 as id",
  "macros/to_cents.sql": "{% macro to_cents(c) %}round({{ c }} * 100){% endmacro %}",
  "models/marts/_marts.yml": "models:\n  - name: m\n    columns:\n      - name: id\n",
  "tests/assert_positive.sql": "select * from {{ ref('m') }} where id < 0",
  "seeds/country_codes.csv": "code,name\nUS,United States\n",
}

async function aiInputFor(changed: ChangedFile[]): Promise<AiReviewInput | undefined> {
  let seen: AiReviewInput | undefined
  await runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    getContent: async (f, side) => (side === "old" ? undefined : FILES[f]),
    generatedAt: "2026-11-14T00:00:00Z",
    aiReview: async (input) => {
      seen = input
      return { findings: [], status: { state: "ok" } }
    },
  })
  return seen
}

const mod = (path: string, diff = "+x\n"): ChangedFile => ({ path, status: "modified", diff })

describe("files sent to the advisory AI lane", () => {
  test("macros, singular tests, yml and seeds go with the model, labeled by role", async () => {
    const input = await aiInputFor(Object.keys(FILES).map((p) => mod(p)))
    const byPath = new Map(input!.files.map((f) => [f.path, f]))
    expect([...byPath.keys()].sort()).toEqual(Object.keys(FILES).sort())
    expect(byPath.get("macros/to_cents.sql")).toMatchObject({ kind: "macro", sql: FILES["macros/to_cents.sql"] })
    expect(byPath.get("tests/assert_positive.sql")?.kind).toBe("test")
    expect(byPath.get("models/marts/_marts.yml")).toMatchObject({ kind: "schema_yml", sql: FILES["models/marts/_marts.yml"] })
    // A seed goes as its diff only.
    expect(byPath.get("seeds/country_codes.csv")).toMatchObject({ kind: "seed", sql: undefined })
  })

  test("a macro-only PR reaches the lane instead of being skipped", async () => {
    const input = await aiInputFor([mod("macros/to_cents.sql", "-round({{ c }})\n+round({{ c }} * 100)\n")])
    expect(input?.files.map((f) => f.path)).toEqual(["macros/to_cents.sql"])
  })

  test("deleted files are not sent", async () => {
    const input = await aiInputFor([mod("models/marts/m.sql"), { path: "macros/old.sql", status: "deleted", diff: "-x\n" }])
    expect(input?.files.some((f) => f.path === "macros/old.sql")).toBe(false)
  })
})

describe("selection and prompt layout", () => {
  const f = (path: string, kind: string, status = "modified"): AiReviewFile => ({ path, status, kind, model: path, diff: "+x\n" })

  test("models first, then macros, tests, yml; deleted dropped; capped at 20", () => {
    const files = [
      f("_s.yml", "schema_yml"),
      f("t.sql", "test"),
      f("gone.sql", "macro", "deleted"),
      f("mac.sql", "macro"),
      ...Array.from({ length: 19 }, (_, i) => f(`m${i}.sql`, "model_sql")),
    ]
    const picked = selectAiFiles(files).map((x) => x.path)
    expect(picked).toHaveLength(20)
    expect(picked.slice(0, 19).every((p) => /^m\d+\.sql$/.test(p))).toBe(true)
    expect(picked[19]).toBe("mac.sql")
  })

  test("each file's header names its role and its content is fenced by type", () => {
    const msg = buildUserMessage({
      grounding: [],
      files: [
        { path: "macros/m.sql", status: "modified", kind: "macro", model: "m", sql: "{% macro m() %}1{% endmacro %}" },
        { path: "models/_s.yml", status: "added", kind: "schema_yml", model: "_s.yml", sql: "models: []" },
        { path: "models/a.sql", status: "modified", model: "a", sql: "select 1" },
      ],
    })
    expect(msg).toContain("### macros/m.sql (modified, macro (Jinja; changes every model that calls it))")
    expect(msg).toContain("### models/_s.yml (added, schema yml (tests, contracts, descriptions))\nCurrent file:\n```yaml")
    expect(msg).toContain("### models/a.sql (modified)\nCurrent SQL:\n```sql")
  })
})

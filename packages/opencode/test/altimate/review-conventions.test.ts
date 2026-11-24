import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { execFileSync } from "node:child_process"
import {
  CONVENTIONS_HEADING,
  appliesTo,
  conventionSpecificity,
  conventionsFor,
  loadConventions,
  parseMdc,
  renderConventions,
  sliceContributing,
  type Convention,
} from "../../src/altimate/review/conventions"
import { planAiInput, runAiReview, type AiReviewFile, type AiReviewInput } from "../../src/altimate/review/ai-review"
import { lsTreeAtRef, showAtRef } from "../../src/altimate/review/git"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { Dispatcher } from "../../src/altimate/native"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { resolveAiSwitches } from "../../src/altimate/review/ai-switches"

// Team conventions (repo review instructions) from the base branch for the AI finder.

const FIXTURE = path.join(import.meta.dir, "fixtures", "review-conventions")

async function fixtureFiles(dir = FIXTURE, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await fixtureFiles(path.join(dir, e.name), rel)))
    else out.push(rel)
  }
  return out
}

/** The fixture as the base commit: a reader and a directory listing over it. */
async function fixtureBase() {
  const files = await fixtureFiles()
  const reads: string[] = []
  return {
    reads,
    readBase: async (rel: string) => {
      reads.push(rel)
      return files.includes(rel) ? fs.readFile(path.join(FIXTURE, rel), "utf8") : undefined
    },
    listBase: async (dir: string) => files.filter((f) => f.startsWith(dir + "/")),
  }
}

const CHANGED = ["models/marts/fct_orders.sql", "models/staging/stg_orders.sql", "models/staging/stg_orders.yml"]

async function loadFixture(changed = CHANGED) {
  const base = await fixtureBase()
  return loadConventions({ readBase: base.readBase, listBase: base.listBase, changedPaths: changed })
}

describe("loadConventions (fixture as the base commit)", () => {
  test("every source, in load order, with scope and globs", async () => {
    const all = await loadFixture()
    expect(all.map((c) => [c.path, c.source, c.scope, c.globs ?? null])).toEqual([
      ["CLAUDE.md", "claude_md", "", null],
      ["models/marts/CLAUDE.md", "claude_md", "models/marts", null],
      [".coderabbit.yaml", "coderabbit", "", null],
      [".coderabbit.yaml", "coderabbit", "", ["models/staging/**/*.sql"]],
      [".coderabbit.yaml", "coderabbit", "", ["models/marts/**"]],
      [".cursor/rules/dbt-models.mdc", "cursor", "", ["models/**/*.sql"]],
      ["CONTRIBUTING.md", "contributing", "", null],
    ])
    expect(all[2].text).toBe("Tone: Be brief; name the column.")
    expect(all[5].text).toContain("never hardcode schemas")
    // The manual Cursor rule (no globs, not alwaysApply) and the negated CodeRabbit path are skipped.
    expect(all.some((c) => c.text.includes("manual rule"))).toBe(false)
    expect(all.some((c) => c.text.includes("ignored negation"))).toBe(false)
  })

  test("CONTRIBUTING.md keeps only the dbt/model/test sections", async () => {
    const all = await loadFixture()
    const contributing = all.find((c) => c.source === "contributing")!.text
    expect(contributing).toContain("## dbt model naming")
    expect(contributing).toContain("### Tests")
    expect(contributing).not.toContain("Setup")
    expect(contributing).not.toContain("Releasing")
  })

  test("scoped files are looked up only in ancestors of changed paths", async () => {
    const base = await fixtureBase()
    const all = await loadConventions({ readBase: base.readBase, listBase: base.listBase, changedPaths: ["models/staging/stg_orders.sql"] })
    expect(all.some((c) => c.path === "models/marts/CLAUDE.md")).toBe(false)
    expect(base.reads).toContain("models/staging/CLAUDE.md")
    expect(base.reads).not.toContain("models/marts/CLAUDE.md")
  })

  test("the files #1774 read (REVIEW.md, .altimate/REVIEW.md, AGENTS.md, CLAUDE.md) are all covered", async () => {
    const files: Record<string, string> = {
      "REVIEW.md": "Root rule.",
      ".altimate/REVIEW.md": "Altimate rule.",
      "models/marts/AGENTS.md": "Marts agents rule.",
      "models/marts/CLAUDE.md": "Marts claude rule.",
    }
    const all = await loadConventions({ readBase: async (rel) => files[rel], changedPaths: ["models/marts/x.sql"] })
    expect(all.map((c) => [c.path, c.scope]).sort()).toEqual([
      [".altimate/REVIEW.md", ""],
      ["REVIEW.md", ""],
      ["models/marts/AGENTS.md", "models/marts"],
      ["models/marts/CLAUDE.md", "models/marts"],
    ])
  })

  test("per-file cap of 4,000 characters; unreadable files are skipped", async () => {
    const all = await loadConventions({
      readBase: async (rel) => (rel === "AGENTS.md" ? "x".repeat(9_000) : rel === "REVIEW.md" ? Promise.reject(new Error("boom")) : undefined),
      changedPaths: ["models/a.sql"],
    })
    expect(all.map((c) => c.path)).toEqual(["AGENTS.md"])
    expect(all[0].text.startsWith("x".repeat(4_000) + "\n… (truncated)")).toBe(true)
  })

  test(".altimate/review.md, .claude/CLAUDE.md, .cursorrules and copilot instructions apply to the whole repo", async () => {
    const files: Record<string, string> = {
      ".altimate/review.md": "Prefer qualify over subqueries.",
      ".claude/CLAUDE.md": "Run dbt build before pushing.",
      ".cursorrules": "Use 4-space indent in SQL.",
      ".github/copilot-instructions.md": "Every model needs a description.",
    }
    const all = await loadConventions({ readBase: async (rel) => files[rel], changedPaths: ["models/a.sql"] })
    expect(all.map((c) => [c.path, c.source, c.scope])).toEqual([
      [".altimate/review.md", "altimate", ""],
      [".claude/CLAUDE.md", "claude_md", ""],
      [".cursorrules", "cursorrules", ""],
      [".github/copilot-instructions.md", "copilot", ""],
    ])
  })
})

describe("parsing helpers", () => {
  test("parseMdc: string, comma list, bracket list and YAML list globs; alwaysApply", () => {
    expect(parseMdc("---\nglobs: models/**/*.sql\n---\nbody")).toEqual({ globs: ["models/**/*.sql"], alwaysApply: false, body: "body" })
    expect(parseMdc("---\nglobs: *.sql, *.yml\nalwaysApply: false\n---\nb").globs).toEqual(["*.sql", "*.yml"])
    expect(parseMdc('---\nglobs: ["a/*.sql", \'b/**\']\n---\nb').globs).toEqual(["a/*.sql", "b/**"])
    expect(parseMdc("---\nglobs:\n  - a/*.sql\n  - \"b/**\"\ndescription: x\n---\nb").globs).toEqual(["a/*.sql", "b/**"])
    expect(parseMdc("---\nalwaysApply: true\n---\nalways").alwaysApply).toBe(true)
    expect(parseMdc("no frontmatter")).toEqual({ globs: [], alwaysApply: false, body: "no frontmatter" })
  })

  test("sliceContributing: matching sections and their subsections, capped", () => {
    const text = "# Intro\nhi\n## SQL style\nlower case\n### Joins\nexplicit\n## Release\nno\n## Naming\nsnake"
    expect(sliceContributing(text)).toBe("## SQL style\nlower case\n### Joins\nexplicit\n## Naming\nsnake")
    expect(sliceContributing("## Tests\n" + "y".repeat(3_000), 100).length).toBeLessThan(120)
  })

  test("the conventions switch: on by default, env 1/0 wins over `ai.conventions`", () => {
    expect(resolveAiSwitches({ ai: true }, {}).conventions).toBe(true)
    expect(resolveAiSwitches({ ai: { conventions: false } }, {}).conventions).toBe(false)
    expect(resolveAiSwitches({ ai: { conventions: false } }, { ALTIMATE_REVIEW_CONVENTIONS: "1" }).conventions).toBe(true)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_CONVENTIONS: "0" }).conventions).toBe(false)
  })
})

describe("scoping and budget", () => {
  test("glob and directory scoping; slash-less globs match at any depth; braces expand", async () => {
    const all = await loadFixture()
    const byPath = (p: string, i = 0) => all.filter((c) => c.path === p)[i]
    expect(conventionSpecificity(byPath("CLAUDE.md"), "anything/x.sql")).toBe(0)
    expect(conventionSpecificity(byPath("models/marts/CLAUDE.md"), "models/marts/fct.sql")).toBe("models/marts/".length)
    expect(conventionSpecificity(byPath("models/marts/CLAUDE.md"), "models/staging/stg.sql")).toBeUndefined()
    expect(conventionSpecificity(byPath(".coderabbit.yaml", 1), "models/staging/sub/stg.sql")).toBeGreaterThan(0)
    expect(conventionSpecificity(byPath(".coderabbit.yaml", 1), "models/staging/stg.yml")).toBeUndefined()
    const loose: Convention = { path: "x.mdc", source: "cursor", scope: "", globs: ["**/*.sql"], text: "t" }
    expect(conventionSpecificity(loose, "a/b/c.sql")).toBe(".sql".length)
    const files: Record<string, string> = { ".cursor/rules/y.mdc": "---\nglobs: models/*.{sql,yml}\n---\nboth" }
    const braces = await loadConventions({ readBase: async (r) => files[r], listBase: async () => Object.keys(files), changedPaths: [] })
    expect(braces[0].globs).toEqual(["models/*.sql", "models/*.yml"])
  })

  test("conventionsFor: most specific first, then load order; within the budget", async () => {
    const all = await loadFixture()
    expect(conventionsFor(all, "models/marts/fct_orders.sql").map((c) => c.path + (c.globs ? ` ${c.globs[0]}` : ""))).toEqual([
      "models/marts/CLAUDE.md",
      ".coderabbit.yaml models/marts/**",
      ".cursor/rules/dbt-models.mdc models/**/*.sql",
      "CLAUDE.md",
      ".coderabbit.yaml",
      "CONTRIBUTING.md",
    ])
    expect(conventionsFor(all, "models/staging/stg_orders.yml").map((c) => c.path)).toEqual(["CLAUDE.md", ".coderabbit.yaml", "CONTRIBUTING.md"])
    // A tight budget keeps the most specific entries that fit.
    const tight = conventionsFor(all, "models/marts/fct_orders.sql", 300)
    expect(tight[0].path).toBe("models/marts/CLAUDE.md")
    expect(tight.length).toBeLessThan(6)
    // One entry over the whole budget is cut to fit rather than dropped.
    const big: Convention = { path: "AGENTS.md", source: "agents_md", scope: "", text: "z".repeat(5_000) }
    const cutOne = conventionsFor([big], "a.sql", 1_000)
    expect(cutOne).toHaveLength(1)
    expect(cutOne[0].text.length).toBeLessThan(1_000)
  })

  test("renderConventions: the section for the call's files only, headings say what each applies to", async () => {
    const all = await loadFixture()
    const r = renderConventions(all, ["models/staging/stg_orders.sql"])
    expect(r.text.startsWith(CONVENTIONS_HEADING)).toBe(true)
    expect(r.text).toContain("### .coderabbit.yaml (applies to models/staging/**/*.sql)\nStaging models only rename")
    expect(r.text).toContain("### CLAUDE.md (applies to the whole repo)")
    expect(r.text).not.toContain("models/marts/CLAUDE.md")
    expect(r.text).not.toContain("Every mart has")
    expect(r.paths).toEqual([".coderabbit.yaml", ".cursor/rules/dbt-models.mdc", "CLAUDE.md", "CONTRIBUTING.md"])
    const marts = renderConventions(all, ["models/marts/fct_orders.sql"])
    expect(marts.text.indexOf("### models/marts/CLAUDE.md (applies to models/marts/)")).toBeLessThan(marts.text.indexOf("### CLAUDE.md"))
    expect(renderConventions(all, ["models/marts/fct_orders.sql"], 400).text.length).toBeLessThan(400 + CONVENTIONS_HEADING.length + 10)
    expect(renderConventions([], ["a.sql"])).toEqual({ text: "", paths: [] })
    expect(appliesTo({ scope: "", globs: ["a/**", "b/*.sql"] })).toBe("a/**, b/*.sql")
  })
})


describe("loadConventions over git: the base commit, never the PR's edits", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()

  test("showAtRef + lsTreeAtRef at the merge base read the base versions and the base Cursor rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-"))
    try {
      await fs.cp(FIXTURE, dir, { recursive: true })
      git(dir, "init", "-q", "-b", "main")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "base")
      const base = git(dir, "rev-parse", "HEAD").trim()
      git(dir, "checkout", "-q", "-b", "pr")
      await fs.writeFile(path.join(dir, "CLAUDE.md"), "PR rewrote the rules.\n")
      await fs.writeFile(path.join(dir, ".cursor/rules/new.mdc"), "---\nalwaysApply: true\n---\nAdded by the PR.\n")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "pr")
      const all = await loadConventions({
        readBase: (rel) => showAtRef(dir, base, rel),
        listBase: (d) => lsTreeAtRef(dir, base, d),
        changedPaths: CHANGED,
      })
      expect(all.map((c) => c.path)).toEqual((await loadFixture()).map((c) => c.path))
      expect(all.find((c) => c.path === "CLAUDE.md")!.text).toContain("snake_case")
      expect(all.some((c) => c.text.includes("Added by the PR"))).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

const aiFile = (p: string, kind = "model_sql"): AiReviewFile => ({
  path: p,
  status: "modified",
  model: p.split("/").pop()!.replace(/\.\w+$/, ""),
  kind,
  diff: `@@ -1,2 +1,3 @@\n select a,\n+  b / 100 as amount,\n from t\n`,
  sql: "select a,\n  b / 100 as amount,\nfrom t\n",
})

const FOCUSED = { ALTIMATE_REVIEW_AI_FOCUSED: "1", ALTIMATE_REVIEW_AI_FOCUS_MIN_FILES: "2", ALTIMATE_REVIEW_AI_FOCUS_BATCH_FILES: "1" }

describe("standard finder: each call carries the conventions of its files", () => {
  test("flag off (no conventions given): the plan is byte-identical, also with an empty list", async () => {
    const files = [aiFile("models/marts/fct_orders.sql"), aiFile("models/staging/stg_orders.sql")]
    for (const env of [{}, { ALTIMATE_REVIEW_AI_COVERAGE: "1" }, FOCUSED]) {
      const base = planAiInput({ grounding: [], files }, env)
      const empty = planAiInput({ grounding: [], files, conventions: [] }, env)
      expect(empty.messages).toEqual(base.messages)
      expect(empty.input).toEqual(base.input)
      expect(base.messages.join("\n")).not.toContain("TEAM CONVENTIONS")
      expect(base.input.some((r) => "conventions" in r)).toBe(false)
    }
  })

  test("flag on: after the grounding, before the changed files; only the call's conventions; recorded on its first file", async () => {
    const conventions = await loadFixture()
    const files = [aiFile("models/marts/fct_orders.sql")]
    const off = planAiInput({ grounding: [], files }, {})
    const plan = planAiInput({ grounding: [], files, conventions }, {})
    const m = plan.messages[0]
    expect(m.indexOf("## GROUNDING")).toBeLessThan(m.indexOf("## TEAM CONVENTIONS"))
    expect(m.indexOf("## TEAM CONVENTIONS")).toBeLessThan(m.indexOf("## CHANGED FILES"))
    expect(m).toContain("### models/marts/CLAUDE.md (applies to models/marts/)\nMarts are incremental")
    expect(m).not.toContain("Staging models only rename")
    // Removing the section gives back the flag-off message exactly.
    const section = renderConventions(conventions, files.map((f) => f.path)).text
    expect(m.replace("\n" + section, "")).toBe(off.messages[0])
    expect(plan.input[0].conventions).toEqual(renderConventions(conventions, ["models/marts/fct_orders.sql"]).paths)
    expect(section.length).toBeLessThan(3_000 + CONVENTIONS_HEADING.length + 10)
  })

  test("focused calls: each call gets the conventions of its own files", async () => {
    const conventions = await loadFixture()
    const files = [aiFile("models/marts/fct_orders.sql"), aiFile("models/staging/stg_orders.sql")]
    const plan = planAiInput({ grounding: [], files, conventions }, FOCUSED)
    expect(plan.messages).toHaveLength(2)
    const marts = plan.messages.find((x) => x.includes("### models/marts/fct_orders.sql"))!
    const staging = plan.messages.find((x) => x.includes("### models/staging/stg_orders.sql (modified"))!
    expect(marts).toContain("Every mart has a unique")
    expect(marts).not.toContain("Staging models only rename")
    expect(staging).toContain("Staging models only rename")
    expect(staging).not.toContain("models/marts/CLAUDE.md")
  })

  test("a call whose files no convention applies to carries no section", () => {
    const only: Convention[] = [{ path: "models/marts/CLAUDE.md", source: "claude_md", scope: "models/marts", text: "marts only" }]
    const files = [aiFile("macros/m.sql", "macro")]
    expect(planAiInput({ grounding: [], files, conventions: only }, {}).messages).toEqual(planAiInput({ grounding: [], files }, {}).messages)
  })
})

describe("runAiReview records ai.conventions and sends the section", () => {
  afterEach(() => mock.restore())

  test("the model receives the section; the status lists every loaded convention as {path, source, scope, chars}", async () => {
    const conventions = await loadFixture()
    spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as any)
    spyOn(Dispatcher, "call").mockImplementation((async (method: string) =>
      method === "altimate_core.review_ai_prompt" ? { success: true, data: { prompt: "SYSTEM" } } : { success: true, data: { findings: [] } }) as any)
    const seen: any[] = []
    spyOn(LLM, "stream").mockImplementation(async (input: any) => {
      seen.push(input)
      return {
        fullStream: (async function* () {})(),
        text: Promise.resolve("[]"),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ messages: [] }),
        totalUsage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
      } as any
    })
    const res = await runAiReview({ files: [aiFile("models/marts/fct_orders.sql")], grounding: [], conventions })
    expect(String(seen[0].messages[0].content)).toContain("### models/marts/CLAUDE.md (applies to models/marts/)")
    expect(res.status.conventions).toEqual(conventions.map((c) => ({ path: c.path, source: c.source, scope: c.scope, ...(c.globs ? { globs: c.globs } : {}), chars: c.text.length })))
    const without = await runAiReview({ files: [aiFile("models/marts/fct_orders.sql")], grounding: [] })
    expect(without.status.conventions).toBeUndefined()
    expect(String(seen[1].messages[0].content)).not.toContain("TEAM CONVENTIONS")
  })
})

describe("orchestrator passes the conventions to the lane and the envelope keeps the record", () => {
  const runner = {
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

  test("absent: the lane input has no conventions; present: passed through and recorded under ai.conventions", async () => {
    const conventions = await loadFixture()
    const run = (extra: { conventions?: Convention[] }) => {
      let seen: AiReviewInput | undefined
      return runReview({
        changedFiles: [{ path: "models/marts/fct_orders.sql", status: "modified", diff: "@@ -1 +1,2 @@\n select 1\n+, 2 as b\n" }],
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        forceTier: "full",
        getContent: async (_f, side) => (side === "old" ? "select 1" : "select 1\n, 2 as b"),
        generatedAt: "2026-11-24T00:00:00Z",
        ...extra,
        aiReview: async (input) => {
          seen = input
          return { findings: [], status: { state: "ok", ...(input.conventions ? { conventions: [{ path: "CLAUDE.md", source: "claude_md", scope: "", chars: 5 }] } : {}) } }
        },
      }).then((env) => ({ env, seen: seen! }))
    }
    const off = await run({})
    expect("conventions" in off.seen).toBe(false)
    expect(off.env.ai?.conventions).toBeUndefined()
    const on = await run({ conventions })
    expect(on.seen.conventions).toBe(conventions)
    expect(on.env.ai?.conventions).toEqual([{ path: "CLAUDE.md", source: "claude_md", scope: "", chars: 5 }])
    expect(on.env.findings).toEqual(off.env.findings)
  })
})

describe("reviewPullRequest end to end (AI dry run, no model call)", () => {
  const KEYS = ["ALTIMATE_REVIEW_CONVENTIONS", "ALTIMATE_REVIEW_AI_DRYRUN", "GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()

  test("on by default: the base CLAUDE.md goes into ai.conventions and the call record; `0` records nothing", async () => {
    const { reviewPullRequest } = await import("../../src/altimate/review/run")
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-e2e-")))
    try {
      await fs.mkdir(path.join(dir, "models"), { recursive: true })
      await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: p\n")
      await fs.writeFile(path.join(dir, "CLAUDE.md"), "Column names are snake_case.\n")
      await fs.writeFile(path.join(dir, "models/m.sql"), "select 1 as id\n")
      git(dir, "init", "-q", "-b", "main")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "base")
      git(dir, "checkout", "-q", "-b", "pr")
      await fs.writeFile(path.join(dir, "models/m.sql"), "select 1 as id, 2 as amountCents\n")
      await fs.writeFile(path.join(dir, "CLAUDE.md"), "PR rewrote the rules.\n")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      process.env.ALTIMATE_REVIEW_CONVENTIONS = "0"
      const off = await reviewPullRequest({ cwd: dir, base: "main", head: "HEAD" })
      expect(off.ai?.state).toBe("skipped")
      expect(off.ai?.conventions).toBeUndefined()
      expect(off.ai?.input?.[0].conventions).toBeUndefined()
      delete process.env.ALTIMATE_REVIEW_CONVENTIONS
      const on = await reviewPullRequest({ cwd: dir, base: "main", head: "HEAD" })
      expect(on.ai?.conventions).toEqual([{ path: "CLAUDE.md", source: "claude_md", scope: "", chars: "Column names are snake_case.".length }])
      expect(on.ai?.input?.find((r) => r.path === "models/m.sql")?.conventions).toEqual(["CLAUDE.md"])
      expect(on.findings).toEqual(off.findings)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

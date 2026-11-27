import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { execFileSync } from "node:child_process"
import {
  CONVENTIONS_HEADING,
  appliesTo,
  citedConvention,
  groupConventionFindings,
  conventionSpecificity,
  conventionsFor,
  loadConventions,
  parseCoderabbit,
  parseMdc,
  renderConventions,
  sliceContributing,
  type Convention,
} from "../../src/altimate/review/conventions"
import { planAiInput, runAiReview, type AiReviewFile, type AiReviewInput } from "../../src/altimate/review/ai-review"
import { listFilesAt, showAtRef } from "../../src/altimate/review/git"
import { VerdictEnvelope } from "../../src/altimate/review/verdict"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { Dispatcher } from "../../src/altimate/native"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { resolveAiSwitches } from "../../src/altimate/review/ai-switches"
import { makeFinding } from "../../src/altimate/review/finding"

// Team conventions (repo review instructions) from the base branch for the AI finder.

const FIXTURE = path.join(import.meta.dir, "fixtures", "review-conventions")

// Credential-shaped fixtures are built at runtime from obviously fake parts, so no committed string
// matches a secret scanner; each value still has the shape the redactor looks for.
const charRange = (from: string, to: string) =>
  Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(from.charCodeAt(0) + i)).join("")
const ALNUM = charRange("a", "z") + charRange("A", "Z") + charRange("0", "9")
/** `n` distinct characters of ALNUM taken with a stride: mixed case and digits, enough entropy to look like a credential. */
const fakeChars = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => ALNUM[(seed + i * 7) % ALNUM.length]).join("")
const FAKE_AWS_KEY_ID = "AKIA" + "FAKE".repeat(4)
const PEM_BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")
const PEM_END = ["-----END", "PRIVATE", "KEY-----"].join(" ")

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
    listBase: async () => files,
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
    // Without the base listing every candidate is probed (with it, only listed paths are read).
    const all = await loadConventions({ readBase: base.readBase, changedPaths: ["models/staging/stg_orders.sql"] })
    expect(all.some((c) => c.path === "models/marts/CLAUDE.md")).toBe(false)
    expect(base.reads).toContain("models/staging/CLAUDE.md")
    expect(base.reads).not.toContain("models/marts/CLAUDE.md")
  })

  test("REVIEW.md, .altimate/REVIEW.md and nested AGENTS.md/CLAUDE.md are loaded", async () => {
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

  test("per-file cap of 4,000 characters; absent files are skipped", async () => {
    const all = await loadConventions({
      readBase: async (rel) => (rel === "AGENTS.md" ? "x".repeat(9_000) : undefined),
      changedPaths: ["models/a.sql"],
    })
    expect(all.map((c) => c.path)).toEqual(["AGENTS.md"])
    expect(all[0].text.startsWith("x".repeat(4_000) + "\n… (truncated)")).toBe(true)
  })

  test("a git failure reading or listing the base commit throws instead of passing for no conventions", async () => {
    const boom = async (rel: string) => (rel === "REVIEW.md" ? Promise.reject(new Error("boom")) : undefined)
    await expect(loadConventions({ readBase: boom, changedPaths: ["models/a.sql"] })).rejects.toThrow("boom")
    const noList = async (): Promise<string[]> => Promise.reject(new Error("ls-tree failed"))
    await expect(loadConventions({ readBase: async () => undefined, listBase: noList, changedPaths: [] })).rejects.toThrow("ls-tree failed")
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

  test("parseMdc: inline YAML comments, in valid YAML and in Cursor's unquoted-glob form", () => {
    expect(parseMdc('---\nglobs: "models/**/*.sql" # marts only\nalwaysApply: false # manual\n---\nb')).toEqual({
      globs: ["models/**/*.sql"],
      alwaysApply: false,
      body: "b",
    })
    expect(parseMdc("---\nglobs:\n  - a/*.sql # first\n  - b/** # second\n---\nb").globs).toEqual(["a/*.sql", "b/**"])
    // `**/*.sql` unquoted is not valid YAML (an alias): read line by line, comments dropped.
    expect(parseMdc("---\nglobs: **/*.sql # all sql\nalwaysApply: true # always\n---\nb")).toEqual({
      globs: ["**/*.sql"],
      alwaysApply: true,
      body: "b",
    })
  })

  test("parseCoderabbit: tone_instructions at the document root, or under reviews when the root has none", () => {
    expect(parseCoderabbit("tone_instructions: Be terse.\nreviews:\n  path_instructions: []\n", ".coderabbit.yaml").map((c) => c.text)).toEqual([
      "Tone: Be terse.",
    ])
    expect(parseCoderabbit("tone_instructions: Root.\n", ".coderabbit.yaml").map((c) => c.text)).toEqual(["Tone: Root."])
    expect(parseCoderabbit("reviews:\n  tone_instructions: Nested.\n", ".coderabbit.yaml").map((c) => c.text)).toEqual(["Tone: Nested."])
    expect(
      parseCoderabbit("tone_instructions: Root.\nreviews:\n  tone_instructions: Nested.\n", ".coderabbit.yaml").map((c) => c.text),
    ).toEqual(["Tone: Root."])
  })

  test("the envelope accepts only the known convention sources", () => {
    const source = VerdictEnvelope.shape.ai.unwrap().shape.conventions.unwrap().element.shape.source
    expect(source.safeParse("claude_md").success).toBe(true)
    expect(source.safeParse("bogus").success).toBe(false)
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
    // The budget covers the whole section, heading and truncation marker included.
    for (const budget of [400, 600, 3_000]) expect(renderConventions(all, ["models/marts/fct_orders.sql"], budget).text.length).toBeLessThanOrEqual(budget)
    const big: Convention = { path: "AGENTS.md", source: "agents_md", scope: "", text: "z".repeat(5_000) }
    expect(renderConventions([big], ["a.sql"], 1_000).text.length).toBeLessThanOrEqual(1_000)
    expect(renderConventions([], ["a.sql"])).toEqual({ text: "", paths: [] })
    expect(appliesTo({ scope: "", globs: ["a/**", "b/*.sql"] })).toBe("a/**, b/*.sql")
  })
})


describe("loadConventions over git: the base commit, never the PR's edits", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()

  test("showAtRef + listFilesAt at the merge base read the base versions and the base Cursor rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-"))
    try {
      await fs.cp(FIXTURE, dir, { recursive: true })
      // A rule whose name git would C-quote without -z.
      await fs.writeFile(path.join(dir, ".cursor/rules/naïve rule.mdc"), "---\nalwaysApply: true\n---\nNon-ASCII name.\n")
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
        listBase: async () => (await listFilesAt(dir, base))!,
        changedPaths: CHANGED,
      })
      const fixturePaths = (await loadFixture()).map((c) => c.path)
      expect(all.map((c) => c.path)).toEqual([
        ...fixturePaths.filter((p) => p !== "CONTRIBUTING.md"),
        ".cursor/rules/naïve rule.mdc",
        "CONTRIBUTING.md",
      ])
      expect(all.find((c) => c.path === "CLAUDE.md")!.text).toContain("snake_case")
      expect(all.some((c) => c.text.includes("Added by the PR"))).toBe(false)
      // An unreadable base commit is an error, not "no conventions".
      await expect(loadConventions({ readBase: (rel) => showAtRef(dir, "no-such-ref", rel), changedPaths: CHANGED })).rejects.toThrow()
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

describe("reviewPullRequest: conventions are searched above the files the review covers", () => {
  const KEYS = ["ALTIMATE_REVIEW_AI_DRYRUN", "GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()

  test("a CLAUDE.md beside an unrelated changed file outside the project is not loaded", async () => {
    const { reviewPullRequest } = await import("../../src/altimate/review/run")
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-scope-")))
    try {
      for (const [rel, body] of [
        ["dbt/dbt_project.yml", "name: p\n"],
        ["dbt/models/m.sql", "select 1 as id\n"],
        ["dbt/models/CLAUDE.md", "Models rule.\n"],
        ["infra/CLAUDE.md", "Terraform rule.\n"],
        ["infra/main.tf", "a = 1\n"],
      ]) {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
        await fs.writeFile(path.join(dir, rel), body)
      }
      git(dir, "init", "-q", "-b", "main")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "base")
      git(dir, "checkout", "-q", "-b", "pr")
      await fs.writeFile(path.join(dir, "dbt/models/m.sql"), "select 1 as id, 2 as x\n")
      await fs.writeFile(path.join(dir, "infra/main.tf"), "a = 2\n")
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      const env = await reviewPullRequest({ cwd: path.join(dir, "dbt"), base: "main", head: "HEAD" })
      expect(env.ai?.conventions?.map((c) => c.path)).toEqual(["dbt/models/CLAUDE.md"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("repeated convention findings become one comment", () => {
  afterEach(() => mock.restore())
  const conv: Convention[] = [
    { path: "models/CLAUDE.md", source: "claude_md", scope: "models", text: "Every model has a description." },
    { path: "CLAUDE.md", source: "claude_md", scope: "", text: "Snake case." },
  ]
  const f = (file: string, model: string, title: string, body: string, severity: "warning" | "suggestion" = "suggestion") =>
    makeFinding({
      severity,
      category: "sql_quality",
      title: `${model}: ${title}`,
      body,
      file,
      model,
      startLine: 1,
      endLine: 1,
      confidence: "medium",
      evidence: { tool: "ai-review", result: {} },
      ruleKey: `ai:sql_quality:${title}`,
      rule: "ai-review:sql-quality",
    })

  test("same convention, same issue on three files: one finding listing the other files", () => {
    const out = groupConventionFindings(
      [
        f("models/a.sql", "fct_a", "Missing model description", "Per models/CLAUDE.md every model needs a description."),
        f("models/b.sql", "fct_b", "Missing model description for fct_b", "models/CLAUDE.md: add a description.", "warning"),
        f("models/c.sql", "fct_c", "missing model description", "See models/CLAUDE.md."),
        f("models/a.sql", "fct_a", "Wrong join", "Unrelated defect."),
      ],
      conv,
    )
    // The folded findings stay, in place, pointing at the lead; the unrelated one is untouched.
    expect(out.map((x) => x.file)).toEqual(["models/a.sql", "models/b.sql", "models/c.sql", "models/a.sql"])
    expect(out[1].severity).toBe("warning")
    expect(out[1].body).toEndWith("The same applies to: `models/a.sql`, `models/c.sql`.")
    expect(out[0].groupedInto).toBe(out[1].id)
    expect(out[2].groupedInto).toBe(out[1].id)
    expect(out[3].title).toBe("fct_a: Wrong join")
    expect(out[3].groupedInto).toBeUndefined()
  })

  test("different conventions, different issues, one file or no convention named: unchanged", () => {
    const list = [
      f("models/a.sql", "a", "Missing model description", "Per models/CLAUDE.md."),
      f("models/b.sql", "b", "Missing model description", "Per CLAUDE.md at the root."),
      f("models/c.sql", "c", "Column not snake case", "Per models/CLAUDE.md."),
      f("models/d.sql", "d", "Missing model description", "No convention named."),
      f("models/e.sql", "e", "Missing model description", "No convention named either."),
    ]
    expect(groupConventionFindings(list, conv)).toEqual(list)
    const sameFile = [f("models/a.sql", "a", "X", "models/CLAUDE.md"), f("models/a.sql", "a", "X", "models/CLAUDE.md line 2")]
    expect(groupConventionFindings(sameFile, conv)).toEqual(sameFile)
    expect(groupConventionFindings(list, [])).toEqual(list)
  })

  test("citedConvention prefers the longest path named", () => {
    expect(citedConvention({ title: "t", body: "see models/CLAUDE.md" }, ["CLAUDE.md", "models/CLAUDE.md"])).toBe("models/CLAUDE.md")
    expect(citedConvention({ title: "t", body: "see CLAUDE.md" }, ["CLAUDE.md", "models/CLAUDE.md"])).toBe("CLAUDE.md")
  })

  test("runAiReview groups the lane's findings when conventions were given", async () => {
    spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as any)
    const parsed = [
      { file: "models/a.sql", line: 1, category: "sql_quality", severity: "suggestion", title: "Missing description", body: "Per models/CLAUDE.md.", confidence: "medium" },
      { file: "models/b.sql", line: 1, category: "sql_quality", severity: "suggestion", title: "Missing description", body: "Per models/CLAUDE.md.", confidence: "medium" },
    ]
    spyOn(Dispatcher, "call").mockImplementation((async (method: string) =>
      method === "altimate_core.review_ai_prompt" ? { success: true, data: { prompt: "SYSTEM" } } : { success: true, data: { findings: parsed } }) as any)
    spyOn(LLM, "stream").mockImplementation(async () => ({
      fullStream: (async function* () {})(),
      text: Promise.resolve("[x]"),
      finishReason: Promise.resolve("stop"),
      response: Promise.resolve({ messages: [] }),
      totalUsage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
    }) as any)
    const files = [aiFile("models/a.sql"), aiFile("models/b.sql")]
    const grouped = await runAiReview({ files, grounding: [], conventions: conv })
    expect(grouped.findings).toHaveLength(2)
    expect(grouped.findings[0].body).toContain("The same applies to: `models/b.sql`.")
    expect(grouped.findings[1].groupedInto).toBe(grouped.findings[0].id)
    const plain = await runAiReview({ files, grounding: [] })
    expect(plain.findings).toHaveLength(2)
  })

  test("same-file findings are not folded: one finding per other file joins the lead", () => {
    const list = [
      f("models/a.sql", "fct_a", "Missing model description", "Per models/CLAUDE.md, line 1.", "warning"),
      f("models/a.sql", "fct_a", "Missing model description", "Per models/CLAUDE.md, the second model in the file."),
      f("models/b.sql", "fct_b", "Missing model description", "Per models/CLAUDE.md."),
    ]
    const out = groupConventionFindings(list, conv)
    expect(out.map((x) => x.file)).toEqual(["models/a.sql", "models/a.sql", "models/b.sql"])
    expect(out[0].body).toEndWith("The same applies to: `models/b.sql`.")
    expect(out[1]).toEqual(list[1])
    expect(out[2].groupedInto).toBe(out[0].id)
  })

  test("replay mode records the conventions and groups the replayed findings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-replay-"))
    const saved = process.env.ALTIMATE_REVIEW_AI_REPLAY
    try {
      const stored = [
        f("models/a.sql", "fct_a", "Missing model description", "Per models/CLAUDE.md."),
        f("models/b.sql", "fct_b", "Missing model description", "Per models/CLAUDE.md."),
      ]
      const file = path.join(dir, "envelope.json")
      await fs.writeFile(file, JSON.stringify({ findings: stored, ai: { state: "ok" } }))
      process.env.ALTIMATE_REVIEW_AI_REPLAY = file
      const res = await runAiReview({ files: [aiFile("models/a.sql"), aiFile("models/b.sql")], grounding: [], conventions: conv })
      expect(res.status.replayed).toBe(true)
      expect(res.status.conventions?.map((c) => c.path)).toEqual(["models/CLAUDE.md", "CLAUDE.md"])
      expect(res.findings).toHaveLength(2)
      expect(res.findings[0].body).toContain("The same applies to: `models/b.sql`.")
      expect(res.findings[1].groupedInto).toBe(res.findings[0].id)
    } finally {
      if (saved === undefined) delete process.env.ALTIMATE_REVIEW_AI_REPLAY
      else process.env.ALTIMATE_REVIEW_AI_REPLAY = saved
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("convention grouping keeps every finding (round 2)", () => {
  const conv: Convention[] = [{ path: "models/CLAUDE.md", source: "claude_md", scope: "models", text: "Every model has a description." }]
  const f = (file: string, title: string, body: string, opts: { category?: "sql_quality" | "sql_correctness"; line?: number } = {}) =>
    makeFinding({
      severity: "suggestion",
      category: opts.category ?? "sql_quality",
      title,
      body,
      file,
      model: file.split("/").pop()!.replace(/\.sql$/, ""),
      startLine: opts.line ?? 3,
      endLine: opts.line ?? 3,
      confidence: "medium",
      evidence: { tool: "ai-review", result: {} },
      ruleKey: `ai:${opts.category ?? "sql_quality"}:${title}`,
      rule: "ai-review:sql-quality",
    })

  test("folded findings stay with their own line and point at the lead", () => {
    const list = [f("models/b.sql", "Missing description", "Per models/CLAUDE.md.", { line: 7 }), f("models/a.sql", "Missing description", "Per models/CLAUDE.md.", { line: 2 })]
    const out = groupConventionFindings(list, conv)
    expect(out).toHaveLength(2)
    const folded = out.find((x) => x.groupedInto)!
    expect(folded.file).toBe("models/b.sql")
    expect(folded.startLine).toBe(7)
    expect(folded.body).toBe("Per models/CLAUDE.md.")
  })

  test("the lead is picked by severity, then path: the same whatever order the model returned", () => {
    const a = f("models/a.sql", "Missing description", "Per models/CLAUDE.md.")
    const b = f("models/b.sql", "Missing description", "Per models/CLAUDE.md.")
    const lead = (list: typeof a[]) => groupConventionFindings(list, conv).find((x) => x.body.includes("The same applies to"))!.file
    expect(lead([a, b])).toBe("models/a.sql")
    expect(lead([b, a])).toBe("models/a.sql")
  })

  test("the same generic title in different categories is not folded", () => {
    const list = [
      f("models/a.sql", "Wrong aggregation", "Per models/CLAUDE.md, sum the cents.", { category: "sql_correctness" }),
      f("models/b.sql", "Wrong aggregation", "Per models/CLAUDE.md, name the column.", { category: "sql_quality" }),
    ]
    expect(groupConventionFindings(list, conv)).toEqual(list)
  })
})

describe("folded findings in the PR comment", () => {
  const conv: Convention[] = [{ path: "models/CLAUDE.md", source: "claude_md", scope: "models", text: "Every model has a description." }]
  const mk = (file: string, line: number) =>
    makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "Missing description",
      body: "Per models/CLAUDE.md.",
      file,
      model: file.split("/").pop()!.replace(/\.sql$/, ""),
      startLine: line,
      endLine: line,
      confidence: "high",
      evidence: { tool: "ai-review", result: {} },
      ruleKey: "ai:sql_quality:missing description",
      rule: "ai-review:sql-quality",
    })
  const envelopeOf = (findings: ReturnType<typeof mk>[]) =>
    VerdictEnvelope.parse({
      version: "1",
      verdict: "COMMENT",
      idealVerdict: "COMMENT",
      mode: "comment",
      tier: "full",
      rubricVersion: "test",
      engine: {},
      generatedAt: "2026-11-27T00:00:00Z",
      summary: { critical: 0, warning: findings.length, suggestion: 0, degraded: false },
      findings: findings.map((x) => ({ ...x, tier: "inline" })),
    })

  test("first run: one comment on the lead, carrying the folded findings' markers; the summary lists the lead only", async () => {
    const { inlineComments, renderSummary, postedFindingIds } = await import("../../src/altimate/review/format")
    const grouped = groupConventionFindings([mk("models/a.sql", 1), mk("models/b.sql", 1)], conv)
    const env = envelopeOf(grouped)
    const { comments } = inlineComments(env)
    expect(comments.map((c) => c.path)).toEqual(["models/a.sql"])
    const lead = grouped.find((x) => !x.groupedInto)!
    const folded = grouped.find((x) => x.groupedInto)!
    expect(postedFindingIds([comments[0].body])).toEqual(new Set([lead.id, folded.id]))
    const summary = renderSummary(env, { maxChars: Infinity })
    expect(summary).toContain("`models/a.sql:1`")
    expect(summary).not.toContain("models/b.sql:1")
    // Next run, same findings: nothing is posted again.
    expect(inlineComments(env, postedFindingIds([comments[0].body])).comments).toEqual([])
  })

  test("re-review: a file newly folded into an already-posted lead is posted on its own", async () => {
    const { inlineComments, postedFindingIds } = await import("../../src/altimate/review/format")
    const first = envelopeOf(groupConventionFindings([mk("models/a.sql", 1)], conv))
    const posted = postedFindingIds(inlineComments(first).comments.map((c) => c.body))
    const second = envelopeOf(groupConventionFindings([mk("models/a.sql", 1), mk("models/c.sql", 4)], conv))
    expect(inlineComments(second, posted).comments.map((c) => `${c.path}:${c.line}`)).toEqual(["models/c.sql:4"])
  })
})

describe("loadConventions hardening (round 2)", () => {
  test("a document holding a private key or a service-account key is never loaded", async () => {
    const files: Record<string, string> = {
      "CLAUDE.md": `Deploy with this key:\n${PEM_BEGIN}\nMIIE...\n${PEM_END}\n`,
      "AGENTS.md": 'Use {"type": "service_account", "project_id": "x"} for tests.',
      "REVIEW.md": "Snake case.",
    }
    const all = await loadConventions({ readBase: async (rel) => files[rel], listBase: async () => Object.keys(files), changedPaths: ["models/a.sql"] })
    expect(all.map((c) => c.path)).toEqual(["REVIEW.md"])
  })

  test("many changed directories: only paths in the base listing are read, at most 8 at a time", async () => {
    const changed = Array.from({ length: 150 }, (_, i) => `dir${i}/sub/file.sql`)
    const files = ["CLAUDE.md", "dir7/sub/AGENTS.md"]
    let active = 0
    let peak = 0
    const reads: string[] = []
    const all = await loadConventions({
      readBase: async (rel) => {
        reads.push(rel)
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 1))
        active--
        return files.includes(rel) ? `rule of ${rel}` : undefined
      },
      listBase: async () => files,
      changedPaths: changed,
    })
    expect(all.map((c) => c.path).sort()).toEqual(["CLAUDE.md", "dir7/sub/AGENTS.md"])
    expect(reads.sort()).toEqual(["CLAUDE.md", "dir7/sub/AGENTS.md"])
    expect(peak).toBeLessThanOrEqual(8)
  })

  test("without a listing the reads are still bounded to 8 at a time", async () => {
    let active = 0
    let peak = 0
    await loadConventions({
      readBase: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 1))
        active--
        return undefined
      },
      changedPaths: Array.from({ length: 40 }, (_, i) => `d${i}/f.sql`),
    })
    expect(peak).toBeLessThanOrEqual(8)
  })

  test("a symlinked CLAUDE.md at the base commit is skipped, not loaded as its target's name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-conventions-link-"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()
    try {
      await fs.writeFile(path.join(dir, "AGENTS.md"), "Snake case everywhere.\n")
      await fs.symlink("AGENTS.md", path.join(dir, "CLAUDE.md"))
      git("init", "-q", "-b", "main")
      git("add", "-A")
      git("commit", "-q", "-m", "base")
      const { listSymlinksAt } = await import("../../src/altimate/review/git")
      const all = await loadConventions({
        readBase: (rel) => showAtRef(dir, "HEAD", rel),
        listBase: async () => (await listFilesAt(dir, "HEAD"))!,
        listBaseSymlinks: async () => (await listSymlinksAt(dir, "HEAD"))!,
        changedPaths: ["models/a.sql"],
      })
      expect(all.map((c) => [c.path, c.text])).toEqual([["AGENTS.md", "Snake case everywhere."]])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("a dbt project's own .altimate/review.md is loaded, scoped to the project", async () => {
    const files: Record<string, string> = { "analytics/.altimate/review.md": "Prefer qualify.", ".altimate/review.md": "Root rule." }
    const all = await loadConventions({ readBase: async (rel) => files[rel], listBase: async () => Object.keys(files), changedPaths: ["analytics/models/a.sql"] })
    expect(all.map((c) => [c.path, c.source, c.scope])).toEqual([
      [".altimate/review.md", "altimate", ""],
      ["analytics/.altimate/review.md", "altimate", "analytics"],
    ])
  })

  test("two .coderabbit.yaml entries with the same glob and equal-length text are both kept", async () => {
    const yaml = "reviews:\n  path_instructions:\n    - path: 'models/**'\n      instructions: 'Use snake.'\n    - path: 'models/**'\n      instructions: 'Use cents.'\n"
    const all = await loadConventions({ readBase: async (rel) => (rel === ".coderabbit.yaml" ? yaml : undefined), changedPaths: ["models/a.sql"] })
    expect(all.map((c) => c.text)).toEqual(["Use snake.", "Use cents."])
  })

  test("CONTRIBUTING: a `#` line inside a code fence is not a heading", () => {
    const text = [
      "# Setup",
      "```sh",
      "# install dbt deps",
      "pip install x",
      "```",
      "# Releasing",
      "Tag it.",
      "# dbt models",
      "Name models stg_*.",
      "```sh",
      "# activate venv",
      "```",
      "Every model has tests.",
    ].join("\n")
    const out = sliceContributing(text)
    expect(out).not.toContain("Tag it.")
    expect(out).not.toContain("pip install")
    expect(out).toContain("Name models stg_*.")
    expect(out).toContain("Every model has tests.")
  })

  test("frontmatter that is not YAML keeps every quoted glob", () => {
    const rule = parseMdc('---\nglobs: "**/*.sql", "**/*.yml" # both\n---\nBody.')
    expect(rule.globs).toEqual(["**/*.sql", "**/*.yml"])
  })

  test("a long nested convention leaves room for .altimate/review.md in the call", () => {
    const all: Convention[] = [
      { path: ".altimate/review.md", source: "altimate", scope: "", text: "Prefer qualify over subqueries." },
      { path: "models/CLAUDE.md", source: "claude_md", scope: "models", text: "x".repeat(4_000) },
    ]
    const { paths } = renderConventions(all, ["models/a.sql"])
    expect(paths).toEqual(["models/CLAUDE.md", ".altimate/review.md"])
  })
})

describe("convention evidence for the verifier and the multi-project merge", () => {
  test("read_file serves a convention file's base text, even when the PR does not change it", async () => {
    const { verifierTools } = await import("../../src/altimate/review/ai-verify")
    const read: string[] = []
    const defs = verifierTools({
      dialect: "duckdb",
      files: [],
      runner: {} as ReviewRunner,
      addedLines: new Map(),
      prFiles: ["models/a.sql"],
      conventions: new Map([["models/CLAUDE.md", "Base rule.\nSecond line."]]),
      readFile: async (p: string) => (read.push(p), "head text"),
      compiledSql: async () => undefined,
    } as any)
    const out = await defs.read_file.run({ path: "models/CLAUDE.md", side: "new" })
    expect(out).toContain("Base rule.")
    expect(out).not.toContain("head text")
    expect(read).toEqual([])
  })

  test("mergeProjectEnvelopes unions ai.conventions across projects", async () => {
    const { mergeProjectEnvelopes } = await import("../../src/altimate/review/multi-project")
    const { buildEnvelope, signEnvelope } = await import("../../src/altimate/review/verdict")
    const rec = (p: string, scope: string) => ({ path: p, source: "claude_md", scope, chars: 5 })
    const env = (conventions?: ReturnType<typeof rec>[]) =>
      signEnvelope(buildEnvelope({ findings: [], tier: "full", mode: "comment", ai: { state: "ok", calls: 1, ...(conventions ? { conventions } : {}) } as any }))
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: env([rec("CLAUDE.md", ""), rec("a/CLAUDE.md", "a")]) },
      { root: "b", paths: [], env: env([rec("CLAUDE.md", ""), rec("b/CLAUDE.md", "b")]) },
      { root: "c", paths: [], env: env() },
    ])
    expect(merged.ai?.conventions?.map((c) => c.path)).toEqual(["CLAUDE.md", "a/CLAUDE.md", "b/CLAUDE.md"])
  })
})

describe("convention grouping, round 2b", () => {
  const conv: Convention[] = [{ path: "models/CLAUDE.md", source: "claude_md", scope: "models", text: "Every model has a description." }]
  const mk = (file: string, line: number, body = "Per models/CLAUDE.md.", title = "Missing description") =>
    makeFinding({
      severity: "warning",
      category: "sql_quality",
      title,
      body,
      file,
      model: file.split("/").pop()!.replace(/\.\w+$/, ""),
      startLine: line,
      endLine: line,
      confidence: "high",
      evidence: { tool: "ai-review", result: {} },
      ruleKey: `ai:sql_quality:${title}:${line}`,
      rule: "ai-review:sql-quality",
    })
  const envelopeOf = (findings: ReturnType<typeof mk>[]) =>
    VerdictEnvelope.parse({
      version: "1",
      verdict: "COMMENT",
      idealVerdict: "COMMENT",
      mode: "comment",
      tier: "full",
      rubricVersion: "test",
      engine: {},
      generatedAt: "2026-11-27T00:00:00Z",
      summary: { critical: 0, warning: findings.length, suggestion: 0, degraded: false },
      findings: findings.map((x) => ({ ...x, tier: "inline" })),
    })

  test("a lead body over the clamp still lists the folded files in its comment", async () => {
    const { inlineComments, BODY_MAX_CHARS } = await import("../../src/altimate/review/format")
    const long = "Per models/CLAUDE.md. " + "x".repeat(BODY_MAX_CHARS + 100)
    const grouped = groupConventionFindings([mk("models/a.sql", 1, long), mk("models/b.sql", 1)], conv)
    const { comments } = inlineComments(envelopeOf(grouped))
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain("The same applies to: `models/b.sql`.")
  })

  test("mergeRepeats keeps groupedInto only when every member shares it", async () => {
    const { mergeRepeats } = await import("../../src/altimate/review/finding")
    const lead = mk("models/a.sql", 1)
    const folded = { ...mk("models/b.yml", 3, "Per models/CLAUDE.md.", "Column undocumented"), groupedInto: lead.id }
    const distinct = mk("models/b.yml", 9, "Another column.", "Column undocumented")
    const out = mergeRepeats([lead, folded, distinct])
    const merged = out.find((f) => f.file === "models/b.yml")!
    expect(merged.title).toContain("(+1 more)")
    expect(merged.groupedInto).toBeUndefined()
  })

  test("a lead merged with a sibling: folded findings follow it to the merged comment", async () => {
    const { mergeRepeats } = await import("../../src/altimate/review/finding")
    const lead = mk("models/a.sql", 1)
    const sibling = mk("models/a.sql", 5)
    const folded = { ...mk("models/b.sql", 1), groupedInto: lead.id }
    const out = mergeRepeats([lead, sibling, folded])
    const merged = out.find((f) => f.file === "models/a.sql")!
    expect(merged.id).not.toBe(lead.id)
    expect(out.find((f) => f.file === "models/b.sql")!.groupedInto).toBe(merged.id)
  })

  test("replay strips the folded-files line even when text follows it", () => {
    const { replayFindings } = require("../../src/altimate/review/ai-replay")
    const f = { ...mk("models/a.sql", 1, "Per models/CLAUDE.md.\n\nThe same applies to: `models/b.sql`.\n\nSame rule, also here:\n- x (line 5)") }
    const lane = replayFindings({ findings: [f], ai: { state: "ok", calls: 1 } })
    expect(lane.findings[0].body).not.toContain("The same applies to")
  })
})

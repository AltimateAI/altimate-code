import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { isCatalogPortability, runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { extractColumnList, listMirrorsModel, loadConsumerLists } from "../../src/altimate/review/consumer-lists"
import { detectUnitTestFixtures } from "../../src/altimate/review/unit-tests"
import { capabilityFor } from "../../src/altimate/review/adapter-capabilities"

/**
 * Checks that work on any dbt project from the manifest and the diff:
 * engine-aware integer division, columns removed under exposures or an
 * enforced contract, contract-vs-SELECT, unit-test fixtures that can't test
 * anything, and opt-in consumer column lists outside dbt.
 */

const exec = promisify(execFile)

describe("integer division follows the adapter", () => {
  const file = { path: "models/marts/m.sql", status: "modified" as const }
  const run = (line: string, ctx?: { dialect: string; dialectKnown: boolean }) =>
    evaluateCatalog(file, line, [line], [], DEFAULT_RUBRIC, ctx).filter((f) => f.title.includes("integer division"))

  test("truncating engines get the correctness finding", () => {
    for (const dialect of ["trino", "postgres", "redshift", "tsql"]) {
      expect(capabilityFor(dialect)?.integerDivisionTruncates).toBe(true)
      const [f] = run("select count(*) / count(distinct user_id) as r", { dialect, dialectKnown: true })
      expect(f.body).toContain("returns 3, not 3.5")
      expect(isCatalogPortability(f)).toBe(false)
    }
  })

  test("non-truncating engines get a portability finding (dropped for single-engine projects)", () => {
    for (const dialect of ["snowflake", "bigquery", "databricks", "duckdb"]) {
      const [f] = run("select 7 / 2 as r", { dialect, dialectKnown: true })
      expect(f.body).toContain(`returns a decimal on ${dialect}`)
      expect(isCatalogPortability(f)).toBe(true)
    }
  })

  test("unknown engine keeps the generic finding", () => {
    expect(run("select 7 / 2 as r", { dialect: "snowflake", dialectKnown: false })[0].body).toContain("returns 3")
    expect(run("select 7 / 2 as r")[0].body).toContain("returns 3")
  })

  test("shapes: count ratio and underscore literals match; casts and decimals don't", () => {
    expect(run("select 1_000 / 3 as r")).toHaveLength(1)
    expect(run("select count(*) / nullif(count(x), 0) as r")).toHaveLength(1)
    expect(run("select count(*) * 1.0 / count(x) as r")).toHaveLength(0)
    expect(run("select cast(count(*) as double) / count(x) as r")).toHaveLength(0)
    expect(run("select 7.0 / 2 as r")).toHaveLength(0)
    expect(run("select col1 / 2 as r")).toHaveLength(0)
    expect(run("where dt >= '2024/01/15'")).toHaveLength(0)
    expect(run("select 'a 1/2 b' as label, 3 / 4 as r")).toHaveLength(1)
  })

  test("end to end: a Snowflake project drops it, a multi-adapter package keeps it", async () => {
    const base = {
      changedFiles: [{ path: "models/m.sql", status: "added" as const, diff: "+select 7 / 2 as r\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"], dialect: "snowflake" },
      rubric: DEFAULT_RUBRIC,
      mode: "comment" as const,
      runner: fakeRunner(),
      getContent: async () => "select 7 / 2 as r",
      dialectKnown: true,
    }
    const has = (fs: { title: string }[]) => fs.some((f) => f.title.includes("integer division"))
    expect(has((await runReview({ ...base, suppressPortability: true })).findings)).toBe(false)
    expect(has((await runReview({ ...base, suppressPortability: false })).findings)).toBe(true)
    const trino = { ...base, config: { ...base.config, dialect: "trino" } }
    expect(has((await runReview({ ...trino, suppressPortability: true })).findings)).toBe(true)
  })
})

/** Output columns are read from a simple `select a, b from …`. */
function fakeRunner(consumers?: Awaited<ReturnType<NonNullable<ReviewRunner["modelConsumers"]>>>): ReviewRunner {
  return {
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
      return { decided: true, equivalent: false }
    },
    async detectPii() {
      return { columns: [] }
    },
    async columnLineage(sql: string) {
      const m = /select\s+([\s\S]*?)\s+from/i.exec(sql)
      if (!m) return []
      return m[1].split(",").map((c) => ({ source: `"src"."${c.trim()}"`, target: c.trim().split(/\s+as\s+/i).pop()! }))
    },
    async modelConsumers() {
      return consumers
    },
  } as ReviewRunner
}

const OLD = "select id, email, amount from src"
const NEW = "select id, amount, region from src"
const changed = [{ path: "models/marts/fct.sql", status: "modified" as const, diff: "-select id, email, amount from src\n+select id, amount, region from src\n" }]

function review(consumers: Parameters<typeof fakeRunner>[0], extra: Partial<Parameters<typeof runReview>[0]> = {}) {
  return runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["lineage_breakage", "contract_violation"] },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner: fakeRunner(consumers),
    getContent: async (_f, side) => (side === "old" ? OLD : NEW),
    getCompiled: async (_f, side) => (side === "old" ? OLD : NEW),
    ...extra,
  })
}

describe("consumers outside the DAG", () => {
  test("a removed column on a model with exposures names them", async () => {
    const env = await review({ exposures: [{ name: "revenue_dashboard", type: "dashboard" }], contractEnforced: false, contractColumns: [] })
    const f = env.findings.find((x) => x.title.includes("declared consumers"))
    expect(f?.body).toContain("`email`")
    expect(f?.body).toContain("`revenue_dashboard` (dashboard)")
    expect(f?.origin).toBe("engine")
  })

  test("a removed column on a contracted model is flagged; a model with neither is not", async () => {
    const contracted = await review({ exposures: [], contractEnforced: true, contractColumns: ["id", "amount", "region"] })
    expect(contracted.findings.find((x) => x.title.includes("declared consumers"))?.body).toContain("enforced contract")
    const plain = await review({ exposures: [], contractEnforced: false, contractColumns: [] })
    expect(plain.findings.some((x) => x.title.includes("declared consumers"))).toBe(false)
  })

  test("nothing declared: a final-layer model still gets a suggestion, an intermediate model does not", async () => {
    const none = { exposures: [], contractEnforced: false, contractColumns: [] }
    const mart = (await review(none)).findings.find((x) => x.title.includes("final-layer"))
    expect(mart?.severity).toBe("suggestion")
    expect(mart?.body).toContain("`email`")
    const inter = await review(none, {
      changedFiles: [{ ...changed[0], path: "models/intermediate/int_x.sql" }],
    })
    expect(inter.findings.some((x) => x.title.includes("final-layer"))).toBe(false)
  })

  const optIn = { config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["lineage_breakage", "contract_violation"], checkContractColumns: true } }

  test("opt-in: a new column missing from the enforced contract is reported, and never blocks", async () => {
    const env = await review({ exposures: [], contractEnforced: true, contractColumns: ["id", "email", "amount"] }, optIn)
    const f = env.findings.find((x) => x.title.includes("missing from the enforced contract"))
    expect(f?.body).toContain("`region`")
    expect(f?.origin).toBe("catalog")
  })

  test("off by default (dbt build enforces it), and skipped when the PR declares the column in a changed yml", async () => {
    const consumers = { exposures: [], contractEnforced: true, contractColumns: ["id", "email", "amount"] }
    const def = await review(consumers)
    expect(def.findings.some((x) => x.title.includes("missing from the enforced contract"))).toBe(false)
    const yml = await review(consumers, {
      ...optIn,
      changedFiles: [...changed, { path: "models/marts/_fct.yml", status: "modified", diff: "+      - name: region\n" }],
      getContent: async (f, side) => (f.endsWith(".yml") ? "models:\n  - name: fct\n    columns:\n      - name: region\n" : side === "old" ? OLD : NEW),
    })
    expect(yml.findings.some((x) => x.title.includes("missing from the enforced contract"))).toBe(false)
  })

  test("a star select is never guessed at", async () => {
    const env = await review(
      { exposures: [{ name: "d" }], contractEnforced: false, contractColumns: [] },
      { getCompiled: async (_f, side) => (side === "old" ? "select * from src" : NEW) },
    )
    expect(env.findings.some((x) => x.title.includes("declared consumers"))).toBe(false)
  })
})

describe("opt-in consumer column lists", () => {
  test("lists are extracted from the capture group; models matched by name", () => {
    const py = 'MART_COLUMNS = [\n  "id",\n  "amount",\n  \'email\',\n]\nTABLE = "fct"\n'
    expect(extractColumnList(py, /MART_COLUMNS\s*=\s*\[([^\]]*)\]/)).toEqual(["id", "amount", "email"])
    const list = { path: "loaders/fct.py", columns: ["id"], content: py }
    expect(listMirrorsModel(list, "fct")).toBe(true)
    expect(listMirrorsModel(list, "fct_orders")).toBe(false)
    expect(listMirrorsModel({ ...list, model: "other" }, "fct")).toBe(false)
  })

  test("a list missing the new column and keeping the removed one is reported", async () => {
    const env = await review(undefined, {
      consumerLists: [{ path: "loaders/fct.py", columns: ["id", "email", "amount"], content: "fct" }],
    })
    const f = env.findings.find((x) => x.title.includes("loaders/fct.py"))
    expect(f?.body).toContain("lacks the new column(s) `region`")
    expect(f?.body).toContain("still lists the removed column(s) `email`")
    expect(f?.origin).toBe("catalog")
  })

  test("an up-to-date list, or no lists configured, reports nothing", async () => {
    const ok = await review(undefined, {
      consumerLists: [{ path: "loaders/fct.py", columns: ["id", "amount", "region"], content: "fct" }],
    })
    expect(ok.findings.some((x) => x.title.includes("loaders/fct.py"))).toBe(false)
  })

  test("lists are read from the head with git; a bad pattern is skipped", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "review-lists-")))
    const g = (...a: string[]) => exec("git", a, { cwd: root })
    await g("init", "-q", "-b", "main")
    await fs.mkdir(path.join(root, "loaders"), { recursive: true })
    await fs.writeFile(path.join(root, "loaders", "fct.py"), 'COLS = ["id", "amount"]\n')
    await fs.writeFile(path.join(root, "loaders", "other.txt"), 'COLS = ["x"]\n')
    await g("add", "-A")
    const lists = await loadConsumerLists({
      configs: [
        { files: "loaders/**/*.py", pattern: "COLS\\s*=\\s*\\[([^\\]]*)\\]", model: "fct" },
        { files: "loaders/**", pattern: "([", model: "fct" },
      ],
      gitRoot: root,
      read: (p) => fs.readFile(path.join(root, p), "utf8"),
    })
    expect(lists.map((l) => [l.path, l.columns])).toEqual([["loaders/fct.py", ["id", "amount"]]])
  })
})

describe("unit tests that cannot exercise the model", () => {
  const file = { path: "models/marts/_fct.yml", status: "modified" as const }
  const yml = (expectRows: string) => `unit_tests:
  - name: t1
    model: fct
    given:
      - input: ref('a')
        rows: []
      - input: this
        rows: []
    expect:
      rows: ${expectRows}
`
  test("all inputs empty and nothing expected: cannot fail", () => {
    const [f] = detectUnitTestFixtures(file, undefined, yml("[]"))
    expect(f.title).toContain("doesn't exercise the model")
    expect(f.severity).toBe("suggestion")
  })

  test("all inputs empty but rows expected", () => {
    const [f] = detectUnitTestFixtures(file, undefined, yml("\n        - {id: 1}"))
    expect(f.title).toContain("expects rows from empty inputs")
  })

  test("an empty `this` next to a populated input is fine; unchanged tests are skipped", () => {
    const ok = `unit_tests:
  - name: t1
    model: fct
    given:
      - input: ref('a')
        rows:
          - {id: 1}
      - input: this
        rows: []
    expect:
      rows:
        - {id: 1}
`
    expect(detectUnitTestFixtures(file, undefined, ok)).toHaveLength(0)
    expect(detectUnitTestFixtures(file, yml("[]"), yml("[]"))).toHaveLength(0)
  })
})

describe("dialect packs apply to their own engine", () => {
  const file = { path: "models/marts/fct_orders.sql", status: "added" as const }
  const sql = "select count(distinct user_id) from `proj`.`ds`.`events_fct`"
  const packs = (ctx?: { dialect: string; dialectKnown: boolean }) =>
    evaluateCatalog(file, sql, [sql], [], DEFAULT_RUBRIC, ctx)
      .map((f) => f.title)
      .filter((t) => /: (BigQuery|Snowflake|Redshift|Databricks):/.test(t))

  test("a DuckDB or Snowflake project gets no BigQuery advice", () => {
    expect(packs({ dialect: "duckdb", dialectKnown: true })).toEqual([])
    expect(packs({ dialect: "snowflake", dialectKnown: true })).toEqual([])
  })

  test("a BigQuery project, or an unknown engine, keeps it", () => {
    expect(packs({ dialect: "bigquery", dialectKnown: true }).length).toBeGreaterThan(0)
    expect(packs({ dialect: "snowflake", dialectKnown: false }).length).toBeGreaterThan(0)
    expect(packs().length).toBeGreaterThan(0)
  })
})

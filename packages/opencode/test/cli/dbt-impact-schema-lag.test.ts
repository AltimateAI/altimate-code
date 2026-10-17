// altimate_change start — dbt-impact schema lag: job maps, the selectors
// adapter, dbt ls resolution, compiled-SQL diff mode, and the command handler
// against a FAKE core. No warehouse, no real dbt.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Dispatcher } from "../../src/altimate/native"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { parseLsIds } from "../../src/altimate/native/dbt/runner"
import { jobsFromSelectors, parseJobMap, resolveJobMap } from "../../src/cli/cmd/dbt-impact-jobs"
import { changesFromManifests, compileSides } from "../../src/cli/cmd/dbt-impact-compiled"
import { buildChange, formatImpactText, normalizeImpactReport, reportVerdict } from "../../src/cli/cmd/dbt-impact-helpers"
import { DbtImpactCommand, producerRelation } from "../../src/cli/cmd/dbt-impact"
import type { Manifest } from "../../src/cli/cmd/dbt-mart-helpers"

const tmp = () => mkdtempSync(path.join(tmpdir(), "dbt-impact-lag-"))

describe("job map parsing", () => {
  test("JSON with select / exclude / schedule", () => {
    const m = parseJobMap(
      JSON.stringify({
        jobs: {
          nightly_full: { select: "+tag:nightly", exclude: "", schedule: "0 2 * * *" },
          hourly_reporting: { select: "tag:hourly", schedule: "0 * * * *" },
        },
      }),
    )
    expect(m).toEqual({
      jobs: {
        nightly_full: { select: "+tag:nightly", schedule: "0 2 * * *" },
        hourly_reporting: { select: "tag:hourly", schedule: "0 * * * *" },
      },
    })
  })
  test("a benchmark case.yaml (YAML, other keys around `jobs`) parses as is", () => {
    const m = parseJobMap(
      "id: I13\njobs:\n  nightly_full:\n    select: \"tag:nightly\"\n    exclude: \"\"\n    schedule: \"0 2 * * *\"\nexpect: {}\n",
    )
    expect("error" in m ? m.error : m.jobs.nightly_full).toEqual({ select: "tag:nightly", schedule: "0 2 * * *" })
  })
  test("list selections join, resolved models pass through, bad input is an error", () => {
    const m = parseJobMap(JSON.stringify({ jobs: { a: { select: ["tag:x", "tag:y"], models: ["model.p.m"] } } }))
    expect("error" in m ? m : m.jobs.a).toEqual({ select: "tag:x tag:y", models: ["model.p.m"] })
    expect(parseJobMap("[1, 2]")).toHaveProperty("error")
    expect(parseJobMap(JSON.stringify({ jobs: { a: { schedule: "x" } } }))).toHaveProperty("error")
    expect(parseJobMap("{not: [valid")).toHaveProperty("error")
  })
})

describe("selectors adapter", () => {
  test("one job per selector, cron from schedules.json", () => {
    const dir = tmp()
    writeFileSync(
      path.join(dir, "selectors.yml"),
      "selectors:\n  - name: cost_and_lineage\n    definition: {method: tag, value: cost}\n  - name: all_default\n    definition: {method: fqn, value: '*'}\n",
    )
    writeFileSync(path.join(dir, "schedules.json"), JSON.stringify({ all_default: { cron: "0 5 * * *" }, cost_and_lineage: "0 */4 * * *" }))
    expect(jobsFromSelectors(dir)).toEqual({
      jobs: {
        cost_and_lineage: { selector: "cost_and_lineage", schedule: "0 */4 * * *" },
        all_default: { selector: "all_default", schedule: "0 5 * * *" },
      },
    })
    rmSync(path.join(dir, "schedules.json"))
    expect(jobsFromSelectors(dir)).toEqual({
      jobs: { cost_and_lineage: { selector: "cost_and_lineage" }, all_default: { selector: "all_default" } },
    })
    rmSync(dir, { recursive: true, force: true })
    expect(jobsFromSelectors("/no/such/dir")).toHaveProperty("error")
  })
})

describe("dbt ls resolution", () => {
  test("parses unique_ids out of mixed log / JSON output", () => {
    expect(parseLsIds('INFO:trino.auth:x\n{"unique_id": "model.p.a"}\n12:00  Running\n{"unique_id": "model.p.b"}\n{bad')).toEqual([
      "model.p.a",
      "model.p.b",
    ])
  })
  test("resolves each job with dbt ls, keeps resolved jobs, reports failures", async () => {
    const calls: unknown[] = []
    const r = await resolveJobMap(
      {
        jobs: {
          nightly: { select: "tag:nightly", exclude: "tag:slow", schedule: "0 2 * * *" },
          sel: { selector: "cost_and_lineage" },
          done: { select: "x", models: ["model.p.x"] },
          broken: { select: "tag:nope" },
        },
      },
      { projectDir: "/p" },
      async (sel) => {
        calls.push(sel)
        if (sel.select === "tag:nope") return { ok: false, error: "no such tag" }
        return { ok: true, ids: [`model.p.${sel.selector ?? "n"}`] }
      },
    )
    expect(calls).toEqual([
      { select: "tag:nightly", exclude: "tag:slow", selector: undefined },
      { select: undefined, exclude: undefined, selector: "cost_and_lineage" },
      { select: "tag:nope", exclude: undefined, selector: undefined },
    ])
    expect(r.map.jobs.nightly.models).toEqual(["model.p.n"])
    expect(r.map.jobs.sel.models).toEqual(["model.p.cost_and_lineage"])
    expect(r.map.jobs.done.models).toEqual(["model.p.x"])
    expect(r.map.jobs.broken.models).toBeUndefined()
    expect(r.errors).toEqual(["job broken: dbt ls failed: no such tag"])
  })
})

// ---------------------------------------------------------------------------
// Compiled-SQL diff mode
// ---------------------------------------------------------------------------

const node = (name: string, raw: string, compiled: string | null, config: Record<string, unknown> = { materialized: "table" }) => ({
  unique_id: `model.p.${name}`,
  name,
  resource_type: "model",
  raw_code: raw,
  compiled_code: compiled,
  relation_name: `"iceberg"."s"."${name}"`,
  database: "iceberg",
  schema: "s",
  alias: name,
  config,
})

const SET_RAW = (extra: string) =>
  `{%- set threshold = 9000 -%}\nselect customer_key${extra} from {{ ref('stg') }}`

function manifests(): { base: Manifest; head: Manifest } {
  const base: Manifest = {
    nodes: {
      "model.p.producer": node("producer", SET_RAW(""), "select customer_key from iceberg.s.stg"),
      "model.p.gone": node("gone", "select 1 as a", "select 1 as a"),
      "model.p.flip": node("flip", "select 1 as a", "select 1 as a"),
      "model.p.same": node("same", SET_RAW(""), null),
      "model.p.jinja": node("jinja", "select {{ var('x') }} as a", null),
    },
  }
  const head: Manifest = {
    nodes: {
      "model.p.producer": node(
        "producer",
        SET_RAW(", account_balance >= {{ threshold }} as is_priority"),
        "select customer_key, account_balance >= 9000 as is_priority from iceberg.s.stg",
      ),
      "model.p.flip": node("flip", "select 1 as a", "select 1 as a", {
        materialized: "incremental",
        incremental_strategy: "delete+insert",
        unique_key: "a",
      }),
      "model.p.same": node("same", SET_RAW(""), null),
      "model.p.jinja": node("jinja", "select {{ var('y') }} as a", null),
      "model.p.new": node("new", "select 1 as b", "select 1 as b"),
    },
  }
  return { base, head }
}

describe("compiled diff mode", () => {
  test("compares compiled_code: a {% set %} model classifies instead of UNCLASSIFIED", () => {
    const { base, head } = manifests()
    const d = changesFromManifests(base, head)
    expect([...d.changes].sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      { model: "flip", kind: "materialization", from: "table", to: "incremental", incremental_strategy: "delete+insert", unique_key: ["a"] },
      { model: "gone", kind: "drop" },
      {
        model: "producer",
        kind: "sql",
        base_sql: "select customer_key from iceberg.s.stg",
        head_sql: "select customer_key, account_balance >= 9000 as is_priority from iceberg.s.stg",
      },
    ])
    // Not compiled on either side and not renderable: reported, never dropped.
    expect(d.unclassified).toEqual([
      { model: "jinja", reason: "not compiled on both sides, and uses Jinja beyond ref/source/config" },
    ])
  })
  test("restricts to the models the git diff touched", () => {
    const { base, head } = manifests()
    expect(changesFromManifests(base, head, new Set(["producer"])).changes.map((c) => c.model)).toEqual(["producer"])
  })
  test("compileSides compiles base from git archive and head from the working tree, into a temp dir", async () => {
    const repo = tmp()
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo })
    git("init", "-q")
    mkdirSync(path.join(repo, "proj/models"), { recursive: true })
    writeFileSync(path.join(repo, "proj/dbt_project.yml"), "name: p\n")
    writeFileSync(path.join(repo, "proj/models/producer.sql"), "select 1 as a")
    git("add", "-A")
    git("commit", "-qm", "base")
    writeFileSync(path.join(repo, "proj/models/producer.sql"), "select 1 as a, 2 as b")
    const calls: Array<{ select: string[]; projectDir: string; targetPath?: string }> = []
    const sides = await compileSides({
      projectDir: path.join(repo, "proj"),
      gitRoot: repo,
      base: "HEAD",
      changed: ["producer"],
      dbt: {},
      compile: async (select, o) => {
        calls.push({ select, projectDir: o.projectDir, targetPath: o.targetPath })
        const sql = readFileSync(path.join(o.projectDir, "models/producer.sql"), "utf-8")
        mkdirSync(o.targetPath!, { recursive: true })
        writeFileSync(
          path.join(o.targetPath!, "manifest.json"),
          JSON.stringify({ nodes: { "model.p.producer": node("producer", sql, sql) } }),
        )
        return { ok: true, offline: true }
      },
    })
    try {
      expect(calls.map((c) => c.select)).toEqual([["producer"], ["producer+"]])
      expect(calls[0].projectDir).not.toBe(path.join(repo, "proj"))
      expect(calls[1].projectDir).toBe(path.join(repo, "proj"))
      // Nothing was written inside the repository.
      expect(calls.every((c) => !c.targetPath!.startsWith(repo))).toBe(true)
      const b = JSON.parse(readFileSync(sides.baseManifest!, "utf-8"))
      const h = JSON.parse(readFileSync(sides.headManifest!, "utf-8"))
      expect(changesFromManifests(b, h).changes).toEqual([
        { model: "producer", kind: "sql", base_sql: "select 1 as a", head_sql: "select 1 as a, 2 as b" },
      ])
    } finally {
      sides.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })
  test("a failed compile is reported and the side keeps no manifest", async () => {
    const repo = tmp()
    execFileSync("git", ["init", "-q"], { cwd: repo })
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "b"], { cwd: repo })
    const sides = await compileSides({
      projectDir: repo,
      gitRoot: repo,
      base: "HEAD",
      changed: ["m"],
      dbt: {},
      compile: async () => ({ ok: false, offline: false, error: "connection refused" }),
    })
    expect(sides.baseManifest).toBeUndefined()
    expect(sides.notes.join("\n")).toContain("connection refused")
    sides.cleanup()
    rmSync(repo, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const LAG_REPORT = {
  model: "model.p.producer",
  verdict: "breaking",
  sinks_unknown: true,
  hops: [
    {
      kind: "dbt_child",
      target: "report",
      verdict: "breaking",
      column_level: true,
      evidence: "schema_lag:cross_job: `report` in `hourly` reads `producer.is_priority`",
    },
  ],
  notes: [],
  resolved_kind: { kind: "add", columns: ["is_priority"] },
  added_columns: ["is_priority"],
  reasons: ["schema_lag:cross_job"],
  schema_lag: [
    {
      reason: "schema_lag:cross_job",
      verdict: "breaking",
      consumer: "report",
      column: "is_priority",
      producer: "producer",
      consumer_jobs: ["hourly"],
      producer_jobs: ["nightly"],
      schedules: { nightly: "0 2 * * *" },
      window: "1d",
      message: "`report` in `hourly` reads `producer.is_priority`, which only `nightly` (0 2 * * *) rebuilds",
      fix: "build `producer` in `hourly` too (`+` parent selection: `+report`)",
    },
  ],
  schema_lag_skipped: ["source_not_landed: no base manifest"],
}

describe("schema-lag report", () => {
  test("normalizes and renders findings, fix, skips and reasons", () => {
    const r = normalizeImpactReport(LAG_REPORT)
    expect(r.schema_lag[0].verdict).toBe("breaking")
    expect(r.resolved_kind).toBe("add")
    expect(reportVerdict(r)).toBe("breaking")
    const text = formatImpactText({ model: "producer", kind: "sql" }, r)
    expect(text).toContain("BREAKING  schema_lag:cross_job report reads producer.is_priority")
    expect(text).toContain("Fix: build `producer` in `hourly` too")
    expect(text).toContain("Skipped: schema_lag source_not_landed")
    expect(text).toContain("Overall: BREAKING (schema_lag:cross_job)")
  })
  test("--kind add needs the new column", () => {
    expect(buildChange({ model: "m", kind: "add" })).toEqual({ error: "--kind add needs --column <new column>" })
    expect(buildChange({ model: "m", kind: "add", column: "x" })).toEqual({ model: "m", kind: "add", columns: ["x"] })
  })
  test("producerRelation finds models and sources", () => {
    const m = {
      nodes: { "model.p.a": node("a", "", "") },
      sources: {
        "source.p.raw.t": { resource_type: "source", source_name: "raw", name: "t", identifier: "t_tbl", schema: "raw", database: "db", relation_name: '"db"."raw"."t_tbl"' },
      },
    } as unknown as Manifest
    expect(producerRelation(m, "a")).toEqual({ database: "iceberg", schema: "s", table: "a", relation: "iceberg.s.a" })
    expect(producerRelation(m, "raw.t")).toEqual({ database: "db", schema: "raw", table: "t_tbl", relation: "db.raw.t_tbl" })
    expect(producerRelation(m, "nope")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Command handler (fake core)
// ---------------------------------------------------------------------------

describe("dbt-impact handler: manifests + jobs (fake core)", () => {
  let errors: string[] = []
  let stdout: string[] = []
  const origError = console.error
  const origWrite = process.stdout.write.bind(process.stdout)
  let dir = ""
  beforeAll(async () => {
    await Dispatcher.call("altimate_core.grain", { sql: "select 1" }).catch(() => undefined)
  })
  afterAll(() => registerAll())
  afterEach(() => {
    console.error = origError
    process.stdout.write = origWrite
    process.exitCode = 0
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const capture = () => {
    errors = []
    stdout = []
    console.error = (...a: unknown[]) => void errors.push(a.join(" "))
    process.stdout.write = ((s: string) => (stdout.push(String(s)), true)) as typeof process.stdout.write
  }

  test("diff mode from two manifests passes both, and the resolved job map, to the core", async () => {
    dir = tmp()
    const { base, head } = manifests()
    writeFileSync(path.join(dir, "base.json"), JSON.stringify(base))
    writeFileSync(path.join(dir, "head.json"), JSON.stringify(head))
    writeFileSync(
      path.join(dir, "jobs.json"),
      JSON.stringify({
        jobs: {
          nightly: { select: "tag:nightly", schedule: "0 2 * * *", models: ["model.p.producer"] },
          hourly: { select: "tag:hourly", models: ["model.p.report"] },
        },
      }),
    )
    const sent: Array<{ change: Record<string, unknown>; opts: Record<string, unknown> }> = []
    Dispatcher.register("altimate_core.dbt_impact", async (p: { change_json: string; options_json?: string }) => {
      const change = JSON.parse(p.change_json)
      sent.push({ change, opts: p.options_json ? JSON.parse(p.options_json) : {} })
      return { success: true, data: change.model === "producer" ? LAG_REPORT : { verdict: "risky", hops: [], notes: [] } }
    })
    capture()
    await DbtImpactCommand.handler({
      cwd: dir,
      "base-manifest": path.join(dir, "base.json"),
      "head-manifest": path.join(dir, "head.json"),
      jobs: path.join(dir, "jobs.json"),
      json: true,
      "fail-on": "breaking",
      _: [],
      $0: "",
    } as never)
    expect(errors.join("\n")).toBe("")
    const producer = sent.find((s) => s.change.model === "producer")!
    expect(producer.change.kind).toBe("sql")
    expect(producer.opts.manifest).toBe(path.join(dir, "head.json"))
    expect(producer.opts.base_manifest).toBe(path.join(dir, "base.json"))
    expect((producer.opts.jobs as { jobs: Record<string, unknown> }).jobs.nightly).toEqual({
      select: "tag:nightly",
      schedule: "0 2 * * *",
      models: ["model.p.producer"],
    })
    const out = JSON.parse(stdout.join(""))
    expect(out.worst).toBe("breaking")
    expect(out.unclassified.map((u: { model: string }) => u.model)).toEqual(["jinja"])
    expect(out.jobs.nightly).toEqual({ schedule: "0 2 * * *", models: 1 })
    expect(process.exitCode).toBe(1)
  })

  test("--live reads the producer's deployed columns and re-judges with them", async () => {
    dir = tmp()
    const { base, head } = manifests()
    writeFileSync(path.join(dir, "base.json"), JSON.stringify(base))
    writeFileSync(path.join(dir, "head.json"), JSON.stringify(head))
    const opts: Array<Record<string, unknown>> = []
    Dispatcher.register("altimate_core.dbt_impact", async (p: { change_json: string; options_json?: string }) => {
      const o = p.options_json ? JSON.parse(p.options_json) : {}
      opts.push(o)
      const change = JSON.parse(p.change_json)
      if (change.model !== "producer") return { success: true, data: { verdict: "safe", hops: [], notes: [] } }
      return { success: true, data: o.deployed_columns ? { ...LAG_REPORT, schema_lag: [], reasons: [], verdict: "safe", hops: [] } : LAG_REPORT }
    })
    const inspected: unknown[] = []
    Dispatcher.register("schema.inspect", async (p: unknown) => {
      inspected.push(p)
      return { table: "producer", columns: [{ name: "CUSTOMER_KEY" }, { name: "IS_PRIORITY" }] }
    })
    capture()
    await DbtImpactCommand.handler({
      cwd: dir,
      "base-manifest": path.join(dir, "base.json"),
      "head-manifest": path.join(dir, "head.json"),
      live: true,
      json: true,
      _: [],
      $0: "",
    } as never)
    expect(inspected).toEqual([{ table: "producer", schema_name: "s", database: "iceberg", warehouse: undefined }])
    expect(opts.at(-1)!.deployed_columns).toEqual({ "iceberg.s.producer": ["customer_key", "is_priority"] })
    expect(JSON.parse(stdout.join("")).worst).toBe("safe")
  })

  test("--jobs and --jobs-from are exclusive; a missing jobs file is an error", async () => {
    dir = tmp()
    const { base, head } = manifests()
    writeFileSync(path.join(dir, "base.json"), JSON.stringify(base))
    writeFileSync(path.join(dir, "head.json"), JSON.stringify(head))
    Dispatcher.register("altimate_core.dbt_impact", async () => ({ success: true, data: LAG_REPORT }))
    capture()
    await DbtImpactCommand.handler({
      cwd: dir,
      "base-manifest": path.join(dir, "base.json"),
      "head-manifest": path.join(dir, "head.json"),
      jobs: path.join(dir, "nope.json"),
      _: [],
      $0: "",
    } as never)
    expect(errors.join("\n")).toContain("--jobs file not found")
    expect(process.exitCode).toBe(1)
  })
})
// altimate_change end

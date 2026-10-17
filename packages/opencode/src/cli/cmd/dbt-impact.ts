// altimate_change start — dbt-impact: blast radius of a model/column change,
// per hop, past the dbt graph (loaders, served tables) when a sink map is given.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { existsSync, mkdtempSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { collectChangedFiles, gitRepoRoot, makeContentResolver } from "../../altimate/review/git"
import { findModel, loadManifest, type Manifest } from "./dbt-mart-helpers"
import {
  CHANGE_KINDS,
  type ChangeKind,
  type DbtChange,
  type ImpactReport,
  type ImpactVerdict,
  VERDICT_RANK,
  buildChange,
  changesForFile,
  formatImpactText,
  normalizeImpactReport,
  reportVerdict,
} from "./dbt-impact-helpers"
import { changesFromManifests, compileSides } from "./dbt-impact-compiled"
import { type JobMap, jobsFromSelectors, readJobMap, resolveJobMap } from "./dbt-impact-jobs"

/**
 * `altimate dbt-impact --model X [--column c] [--kind drop|…]` — what breaks
 * downstream if X (or X.c) changes this way, hop by hop, with a verdict per
 * consumer. `--base/--head` derives the changes from a git diff instead.
 */
export const DbtImpactCommand = cmd({
  command: "dbt-impact",
  describe: "show what breaks downstream (dbt models, loaders, served tables) if a model or column changes",
  builder: (yargs: Argv) =>
    yargs
      .option("model", { describe: "model name (or unique_id)", type: "string" })
      .option("column", { describe: "column of --model (--kind add: the new column)", type: "string" })
      .option("kind", { describe: "kind of change", choices: CHANGE_KINDS, default: "drop" as ChangeKind })
      .option("new-name", { describe: "--kind rename: the new column name", type: "string" })
      .option("to-type", { describe: "--kind retype: the new type", type: "string" })
      .option("from-type", { describe: "--kind retype: the current type", type: "string" })
      .option("to", { describe: "--kind materialization: the new materialization", type: "string" })
      .option("strategy", {
        describe: "--kind materialization: the new incremental_strategy (append, merge, delete+insert, …; default append)",
        type: "string",
      })
      .option("unique-key", {
        describe: "--kind materialization: the new unique_key column(s); default: the model's current one",
        type: "string",
        array: true,
      })
      .option("exposure-sinks", {
        describe:
          "without --sinks, derive the sink map from exposures' meta.sink (--no-exposure-sinks: loaders unknown). " +
          "That map is partial: a mart without an exposure has unknown loaders unless the dbt var sink_map_complete is true",
        type: "boolean",
        default: true,
      })
      .option("base", { describe: "diff mode: base git ref", type: "string" })
      .option("head", { describe: "diff mode: head git ref (default: working tree)", type: "string" })
      .option("base-manifest", { describe: "diff mode: compiled base manifest.json (skips compiling base)", type: "string" })
      .option("head-manifest", { describe: "diff mode: compiled head manifest.json (skips compiling head)", type: "string" })
      .option("compile", {
        describe: "diff mode: compile both sides with dbt (--no-compile: naive Jinja render of the raw SQL)",
        type: "boolean",
        default: true,
      })
      .option("jobs", {
        describe: 'job map (JSON/YAML): {"jobs": {name: {"select", "exclude", "schedule"}}}, resolved with dbt ls',
        type: "string",
      })
      .option("jobs-from", {
        describe: "derive the job map: selectors = one job per selectors.yml selector (+ schedules.json cron)",
        choices: ["selectors"] as const,
      })
      .option("live", {
        describe: "read deployed columns of lagging producers / sources over the configured warehouse connection",
        type: "boolean",
        default: false,
      })
      .option("warehouse", { describe: "--live: warehouse connection name (default: the first configured)", type: "string" })
      .option("dbt-bin", { describe: "dbt executable (default $ALTIMATE_DBT_BIN, else dbt)", type: "string" })
      .option("profiles-dir", { describe: "dbt profiles dir for compile / ls", type: "string" })
      .option("dbt-target", { describe: "dbt target for compile / ls", type: "string" })
      .option("sinks", { describe: "sink map JSON: loaders / served tables that read each mart", type: "string" })
      .option("target-ddl", {
        describe: "backend CREATE TABLE file(s) (Postgres / ClickHouse) giving served column types; repeatable",
        type: "string",
        array: true,
      })
      .option("cwd", { describe: "dbt project directory (default: current dir)", type: "string" })
      .option("manifest", { describe: "path to dbt manifest.json", type: "string" })
      .option("fail-on", {
        describe: "exit 1 when the worst verdict reaches this level",
        choices: ["none", "risky", "breaking"] as const,
        default: "none" as const,
      })
      .option("json", { describe: "emit the full result as JSON", type: "boolean", default: false })
      .check((a) => {
        const manifests = !!(a["base-manifest"] && a["head-manifest"])
        if (!a.model && !a.base && !manifests)
          throw new Error("pass --model X, or --base <ref> (or --base-manifest + --head-manifest) for diff mode")
        if (a.model && (a.base || manifests)) throw new Error("--model and diff mode are mutually exclusive")
        if (a.head && !a.base) throw new Error("--head needs --base")
        if (!!a["base-manifest"] !== !!a["head-manifest"]) throw new Error("--base-manifest and --head-manifest go together")
        if (a.jobs && a["jobs-from"]) throw new Error("--jobs and --jobs-from are mutually exclusive")
        return true
      }),

  handler: async (args: ImpactArgs) => {
    const projectDir = path.resolve(args.cwd ?? process.cwd())
    const dbt = { dbtBin: args["dbt-bin"], profilesDir: args["profiles-dir"], target: args["dbt-target"] }
    const options: Record<string, unknown> = {}
    if (args.sinks) {
      const abs = path.resolve(args.sinks)
      if (!existsSync(abs) || !statSync(abs).isFile()) return fatal(`--sinks file not found: ${abs}`)
      options.sinks = abs
    }
    // Without --sinks the engine derives the sink map from exposures' meta.sink.
    if (args["exposure-sinks"] === false) options.sinks_from_exposures = false
    // Served column types let a narrowing be judged against what the target
    // already stores, instead of assuming every narrowing breaks.
    if (args["target-ddl"]?.length) {
      const files = args["target-ddl"].map((p) => path.resolve(p))
      const missing = files.find((f) => !existsSync(f) || !statSync(f).isFile())
      if (missing) return fatal(`--target-ddl file not found: ${missing}`)
      options.target_ddl = files
    }

    // 1. The changes to analyse.
    let changes: DbtChange[] = []
    let unclassified: Array<{ model: string; reason: string }> = []
    const notes: string[] = []
    let headManifest: Manifest | undefined
    let headDir = projectDir
    let cleanup = () => {}
    if (args.model) {
      const loaded = loadManifest(projectDir, args.manifest)
      if (!loaded.ok) return fatal(loaded.error)
      headManifest = loaded.manifest
      if (args.manifest) options.manifest = loaded.path
      const node = findModel(loaded.manifest, args.model)
      if (!node) return fatal(`model not found (or ambiguous) in the manifest: ${args.model}`)
      const change = buildChange({
        model: node.name ?? args.model,
        column: args.column,
        kind: args.kind ?? "drop",
        newName: args["new-name"],
        toType: args["to-type"],
        fromType: args["from-type"],
        to: args.to,
        strategy: args.strategy,
        uniqueKey: args["unique-key"],
      })
      if ("error" in change) return fatal(change.error)
      changes = [change]
    } else if (args["base-manifest"] && args["head-manifest"]) {
      const b = loadManifest(projectDir, args["base-manifest"])
      const h = loadManifest(projectDir, args["head-manifest"])
      if (!b.ok) return fatal(b.error)
      if (!h.ok) return fatal(h.error)
      headManifest = h.manifest
      options.manifest = h.path
      options.base_manifest = b.path
      ;({ changes, unclassified } = changesFromManifests(b.manifest, h.manifest))
    } else {
      const files = await changedModelFiles(projectDir, args.base!, args.head)
      if ("error" in files) return fatal(files.error)
      if (args.compile === false || !files.models.length) {
        const derived = await changesFromDiffNaive(files, args.base!, args.head)
        changes = derived.changes
        unclassified = derived.unclassified
      } else {
        const sides = await compileSides({
          projectDir,
          gitRoot: files.root,
          base: args.base!,
          head: args.head,
          changed: files.models,
          dbt,
        })
        cleanup = sides.cleanup
        notes.push(...sides.notes)
        headDir = sides.headDir
        const b = sides.baseManifest ? loadManifest(projectDir, sides.baseManifest) : undefined
        const h = sides.headManifest ? loadManifest(projectDir, sides.headManifest) : undefined
        if (b?.ok && h?.ok) {
          headManifest = h.manifest
          options.manifest = h.path
          options.base_manifest = b.path
          ;({ changes, unclassified } = changesFromManifests(b.manifest, h.manifest, new Set(files.models)))
        } else {
          notes.push("no compiled manifests: falling back to the naive render of the raw SQL")
          const derived = await changesFromDiffNaive(files, args.base!, args.head)
          changes = derived.changes
          unclassified = derived.unclassified
        }
      }
    }

    try {
      // 2. Which job builds what (cross-job schema lag).
      let jobs: JobMap | undefined
      if (args.jobs || args["jobs-from"]) {
        const map = args.jobs ? readJobMap(args.jobs) : jobsFromSelectors(headDir)
        if ("error" in map) return fatal(map.error)
        const lsTmp = mkdtempSync(path.join(tmpdir(), "dbt-impact-ls-"))
        try {
          const profilesDir =
            dbt.profilesDir ?? (existsSync(path.join(projectDir, "profiles.yml")) ? projectDir : undefined)
          const r = await resolveJobMap(map, {
            projectDir: headDir,
            ...dbt,
            profilesDir,
            targetPath: path.join(lsTmp, "target"),
            logPath: path.join(lsTmp, "logs"),
          })
          jobs = r.map
          notes.push(...r.errors)
        } finally {
          rmSync(lsTmp, { recursive: true, force: true })
        }
        options.jobs = jobs
      }

      // 3. Impact per change.
      const analyse = async (opts: Record<string, unknown>) => {
        const out: Array<{ change: DbtChange; report: ImpactReport }> = []
        for (const change of changes) {
          const res = await Dispatcher.call("altimate_core.dbt_impact", {
            project_dir: projectDir,
            change_json: JSON.stringify(change),
            options_json: Object.keys(opts).length ? JSON.stringify(opts) : undefined,
          }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
          if (!res.success) return { error: res.error ?? "altimate_core.dbt_impact failed" }
          out.push({ change, report: normalizeImpactReport(res.data) })
        }
        return { results: out }
      }
      let run = await analyse(options)
      if ("error" in run) return fatal(run.error!)
      // 4. --live: read the deployed columns of every lagging producer / source
      // and re-judge with them.
      if (args.live && headManifest) {
        const live = await deployedColumns(run.results, headManifest, args.warehouse)
        notes.push(...live.notes)
        if (Object.keys(live.columns).length) {
          const again = await analyse({ ...options, deployed_columns: live.columns })
          if ("error" in again) return fatal(again.error!)
          run = again
        }
      } else if (args.live) notes.push("--live: no manifest to resolve relation names from; skipped")
      const results = run.results
      const worst = results
        .map((r) => reportVerdict(r.report))
        .reduce<ImpactVerdict>((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), "safe")
      const jobSummary = jobs
        ? Object.fromEntries(Object.entries(jobs.jobs).map(([k, v]) => [k, { schedule: v.schedule, models: v.models?.length ?? 0 }]))
        : undefined

      if (args.json) {
        process.stdout.write(
          JSON.stringify({ version: 1, worst, results, unclassified, notes, jobs: jobSummary }, null, 2) + "\n",
        )
      } else {
        const out: string[] = []
        if (!changes.length) out.push("No impact-relevant model changes in the diff.")
        for (const r of results) out.push(formatImpactText(r.change, r.report), "")
        for (const u of unclassified) out.push(`UNCLASSIFIED ${u.model}: ${u.reason} — run with --model ${u.model} --column <c> --kind <k>`)
        for (const n of notes) out.push(`Note: ${n}`)
        if (results.length > 1) out.push(`Worst across ${results.length} change(s): ${worst.toUpperCase()}`)
        console.error(out.join("\n"))
      }
      const failOn = args["fail-on"] ?? "none"
      if ((failOn === "breaking" && worst === "breaking") || (failOn === "risky" && (worst === "breaking" || worst === "risky")))
        process.exitCode = 1
    } finally {
      cleanup()
    }
  },
})

interface ImpactArgs {
  model?: string
  column?: string
  kind?: ChangeKind
  "new-name"?: string
  "to-type"?: string
  "from-type"?: string
  to?: string
  strategy?: string
  "unique-key"?: string[]
  "exposure-sinks"?: boolean
  base?: string
  head?: string
  "base-manifest"?: string
  "head-manifest"?: string
  compile?: boolean
  jobs?: string
  "jobs-from"?: "selectors"
  live?: boolean
  warehouse?: string
  "dbt-bin"?: string
  "profiles-dir"?: string
  "dbt-target"?: string
  sinks?: string
  "target-ddl"?: string[]
  cwd?: string
  manifest?: string
  "fail-on"?: "none" | "risky" | "breaking"
  json?: boolean
}

interface ChangedModelFiles {
  root: string
  files: Awaited<ReturnType<typeof collectChangedFiles>>
  /** Model names touched by the diff (old and new names of a rename). */
  models: string[]
}

async function changedModelFiles(projectDir: string, base: string, head: string | undefined): Promise<ChangedModelFiles | { error: string }> {
  const root = await gitRepoRoot(projectDir)
  if (!root) return { error: `${projectDir} is not inside a git repository` }
  let files
  try {
    files = await collectChangedFiles({ base, head, cwd: root })
  } catch (e) {
    return { error: `git diff failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  const relProject = path.relative(root, projectDir)
  const models = files.filter(
    (f) => f.path.endsWith(".sql") && (relProject ? f.path.startsWith(relProject + "/") : true) && /(^|\/)models\//.test(f.path),
  )
  const names = new Set<string>()
  for (const f of models) {
    names.add(path.basename(f.path, ".sql"))
    if (f.oldPath) names.add(path.basename(f.oldPath, ".sql"))
  }
  return { root, files: models, models: [...names] }
}

/** The naive diff mode: render raw Jinja just enough (ref/source/config). */
async function changesFromDiffNaive(
  changed: ChangedModelFiles,
  base: string,
  head: string | undefined,
): Promise<{ changes: DbtChange[]; unclassified: Array<{ model: string; reason: string }> }> {
  const { root, files: models } = changed
  const renames = new Map(models.filter((f) => f.oldPath).map((f) => [f.path, f.oldPath!]))
  const read = makeContentResolver({ base, head, cwd: root, gitRoot: root, renames })
  const changes: DbtChange[] = []
  const unclassified: Array<{ model: string; reason: string }> = []
  for (const f of models) {
    const model = path.basename(f.oldPath && f.status === "renamed" ? f.oldPath : f.path, ".sql")
    const r = changesForFile({
      model,
      status: f.status,
      baseRaw: await read(f.path, "old"),
      headRaw: f.status === "deleted" ? undefined : await read(f.path, "new"),
    })
    changes.push(...r.changes)
    unclassified.push(...r.unclassified)
  }
  return { changes, unclassified }
}

/** The relation a schema-lag producer names: a model, or `source_name.table`. */
export function producerRelation(m: Manifest, producer: string): { database?: string; schema?: string; table: string; relation: string } | undefined {
  const all = [...Object.values(m.nodes ?? {}), ...Object.values((m.sources ?? {}) as Record<string, Record<string, unknown>>)]
  const hit = all.find((n) => {
    const r = n as Record<string, unknown>
    if (r.resource_type === "source") return `${r.source_name}.${r.name}` === producer
    return r.resource_type === "model" && r.name === producer
  }) as Record<string, unknown> | undefined
  if (!hit || typeof hit.relation_name !== "string") return undefined
  const table = String(hit.identifier ?? hit.alias ?? hit.name)
  return {
    database: typeof hit.database === "string" ? hit.database : undefined,
    schema: typeof hit.schema === "string" ? hit.schema : undefined,
    table,
    relation: hit.relation_name.replace(/["`]/g, "").toLowerCase(),
  }
}

/** Deployed columns of every producer named by a schema-lag finding, read
 *  over the configured connection (`schema.inspect`). */
async function deployedColumns(
  results: Array<{ report: ImpactReport }>,
  manifest: Manifest,
  warehouse?: string,
): Promise<{ columns: Record<string, string[]>; notes: string[] }> {
  const columns: Record<string, string[]> = {}
  const notes: string[] = []
  const producers = new Set(results.flatMap((r) => r.report.schema_lag.map((f) => f.producer)))
  for (const p of producers) {
    const rel = producerRelation(manifest, p)
    if (!rel) {
      notes.push(`--live: no relation for ${p} in the manifest`)
      continue
    }
    const r = (await Dispatcher.call("schema.inspect", {
      table: rel.table,
      schema_name: rel.schema,
      database: rel.database,
      warehouse,
    }).catch((e: unknown) => ({ error: String(e) }))) as { columns?: Array<{ name: string }>; error?: string }
    if (r.error || !Array.isArray(r.columns)) {
      notes.push(`--live: cannot read ${rel.relation}: ${r.error ?? "no columns returned"}`)
      continue
    }
    columns[rel.relation] = r.columns.map((c) => c.name.toLowerCase())
  }
  if (!producers.size) notes.push("--live: no schema-lag producer to check")
  return { columns, notes }
}

function fatal(msg: string): void {
  console.error(`Error: ${msg}`)
  process.exitCode = 1
}
// altimate_change end

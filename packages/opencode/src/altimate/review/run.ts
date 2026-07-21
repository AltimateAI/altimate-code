import path from "node:path"
import { readFile, stat, access } from "node:fs/promises"
import { loadReviewConfig, resolveRubric } from "./config"
import type { Severity } from "./finding"
import { collectChangedFiles, makeContentResolver, defaultBaseRef, manifestHash } from "./git"
import { makeCompiledResolver, dbtProjectName } from "./compiled"
import { buildCatalogSchemaContext } from "./schema-context"
import { createDispatcherRunner } from "./runner"
import { runReview } from "./orchestrate"
import { runAiReview } from "./ai-review"
import type { ReviewMode, VerdictEnvelope } from "./verdict"
import type { ChangedFile } from "./diff-filter"

/**
 * End-to-end review entry point: load `.altimate/review.yml`, collect the diff,
 * run the deterministic recipe against the Rust core, and return a signed
 * verdict envelope. Used by both the `dbt_pr_review` tool and the
 * `altimate review` CLI command so they can never diverge.
 */

export interface ReviewPullRequestOptions {
  cwd: string
  /** Base ref; defaults to merge-base with origin/main. */
  base?: string
  /** Head ref; omit to diff against the working tree. */
  head?: string
  /** Override the manifest path from config. */
  manifestPath?: string
  /** Override the review mode from config. */
  mode?: ReviewMode
  /** Override the minimum severity to surface. */
  severityThreshold?: Severity
  /** Pre-collected changed files (skips git; used by CI providers). */
  changedFiles?: ChangedFile[]
  /** Resolver for file contents (used when changedFiles is pre-supplied). */
  getContent?: (file: string, side: "old" | "new") => Promise<string | undefined>
  /** Model identifier recorded in the envelope. */
  modelVersion?: string
  coreVersion?: string
  /** Disable the LLM reviewer lane (default: enabled; self-degrades if no model). */
  noAi?: boolean
  /** PR metadata for the AI reviewer's intent check. */
  prTitle?: string
  prBody?: string
  /** G1 — surface the tier classifier's reasons on the verdict envelope. */
  explainTier?: boolean
  /** G2 — [EXPERIMENTAL] bypass the tier classifier with the supplied tier.
   *  Envelope carries `tierForced: true` when used. Debug / bench only. */
  forceTier?: "trivial" | "lite" | "full"
}

/** dbt adapter_type → core SQL dialect. Mostly identity; a few aliases. */
const ADAPTER_DIALECT: Record<string, string> = {
  bigquery: "bigquery",
  snowflake: "snowflake",
  redshift: "redshift",
  postgres: "postgres",
  databricks: "databricks",
  spark: "databricks",
  duckdb: "duckdb",
  trino: "trino",
  athena: "athena",
  mysql: "mysql",
  oracle: "oracle",
  sqlserver: "tsql",
  synapse: "tsql",
  fabric: "fabric",
}

/** Read the dbt manifest's `metadata.adapter_type` and map it to a dialect. */
async function detectDialect(manifestAbs: string): Promise<string | undefined> {
  try {
    const raw = await readFile(manifestAbs, "utf8")
    const adapter = String(JSON.parse(raw)?.metadata?.adapter_type ?? "").toLowerCase()
    return ADAPTER_DIALECT[adapter] ?? (adapter || undefined)
  } catch {
    return undefined
  }
}

/**
 * G3 (Round 18) — walk upward from `cwd` looking for the nearest
 * `dbt_project.yml`; if found, return the adjacent `target/manifest.json`
 * (when it exists). Anchored on `dbt_project.yml` so we never pick up a
 * `target/` from an unrelated tool (e.g. an Airflow project) that happens
 * to live above us on the filesystem.
 *
 * We DO NOT re-run `dbt compile` here — that could touch a real warehouse or
 * consume credentials. The customer is still responsible for compiling; we
 * just find the existing artifact when they didn't pass `--manifest`.
 *
 * Returns undefined when no dbt project is found upward, or when the found
 * project has no compiled manifest.
 */
async function autoDiscoverManifest(cwd: string): Promise<{ path: string; projectRoot: string } | undefined> {
  let dir = path.resolve(cwd)
  const root = path.parse(dir).root
  // Walk up looking for dbt_project.yml so the manifest we auto-discover is
  // demonstrably tied to a dbt project (never `target/manifest.json` from an
  // unrelated cwd, e.g. Airflow's `target/`).
  while (true) {
    for (const fn of ["dbt_project.yml", "dbt_project.yaml"]) {
      try {
        await access(path.join(dir, fn))
        const candidate = path.join(dir, "target", "manifest.json")
        try {
          await access(candidate)
          return { path: candidate, projectRoot: dir }
        } catch {
          return undefined // dbt project found but not compiled — respect that
        }
      } catch {
        /* keep walking */
      }
    }
    if (dir === root) return undefined
    dir = path.dirname(dir)
  }
}

/** Warn to stderr when the manifest looks stale relative to changed files. */
async function warnIfStale(manifestAbs: string, changedPaths: string[], cwd: string): Promise<void> {
  try {
    const manifestMtime = (await stat(manifestAbs)).mtimeMs
    for (const rel of changedPaths) {
      // Only compare against tracked, on-disk model files (schema.yml or SQL)
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
      try {
        const changedMtime = (await stat(abs)).mtimeMs
        if (changedMtime > manifestMtime) {
          process.stderr.write(
            `⚠️  manifest ${manifestAbs} appears stale — ${rel} was modified after the manifest was written. ` +
              `Re-run \`dbt compile\` (or \`dbt build\`) to refresh before reviewing.\n`,
          )
          return
        }
      } catch {
        /* file not on disk (e.g. removed by the change) — skip */
      }
    }
  } catch {
    /* manifest unreadable → detectDialect will have already returned undefined */
  }
}

export async function reviewPullRequest(opts: ReviewPullRequestOptions): Promise<VerdictEnvelope> {
  const config = await loadReviewConfig(opts.cwd)
  if (opts.manifestPath) config.manifestPath = opts.manifestPath
  if (opts.mode) config.mode = opts.mode
  if (opts.severityThreshold) config.severityThreshold = opts.severityThreshold
  const rubric = resolveRubric(config)

  // Only resolve a base ref if we actually need git (to collect changed files
  // or to read old/new content). A caller that supplies BOTH `changedFiles` and
  // `getContent` (e.g. a non-git CI integration) must not be forced through a
  // git lookup that can fail when there's no usable history.
  const needGit = !opts.changedFiles || !opts.getContent
  const base = opts.base ?? (needGit ? await defaultBaseRef(opts.cwd) : "")
  const changedFiles = opts.changedFiles ?? (await collectChangedFiles({ base, head: opts.head, cwd: opts.cwd }))
  // Map renamed files → their old path so getContent resolves the "old" side
  // from where the file lived at `base`.
  const renames = new Map(
    changedFiles.filter((f) => f.status === "renamed" && f.oldPath).map((f) => [f.path, f.oldPath as string]),
  )
  const getContent = opts.getContent ?? makeContentResolver({ base, head: opts.head, cwd: opts.cwd, renames })

  // Resolve the manifest against the PROJECT being reviewed (cwd), not the
  // binary's process.cwd() — otherwise a relative path silently misses when the
  // CLI is invoked from elsewhere, degrading every review to lint-only.
  let manifestAbs = path.isAbsolute(config.manifestPath)
    ? config.manifestPath
    : path.join(opts.cwd, config.manifestPath)
  // The "effective dbt project root" for downstream lookups (dbtProjectName,
  // compiled-SQL resolver). Starts as opts.cwd — G3 auto-discovery updates it
  // when it finds a dbt_project.yml in an ancestor directory, so the compiled
  // resolver and project-name lookups target the discovered project rather
  // than the CLI's working directory (which may be a subdir).
  let dbtRoot = opts.cwd
  // G3 (Round 18) — auto-discovery when the caller didn't pass `--manifest` and
  // the config-relative resolve above doesn't point at an existing file. Walk
  // upward for the dbt project root and use its `target/manifest.json`. Explicit
  // `--manifest` always wins (see run.ts opts.manifestPath override at the top).
  if (!opts.manifestPath) {
    let manifestExists = false
    try {
      await access(manifestAbs)
      manifestExists = true
    } catch {
      /* fall through to auto-discovery */
    }
    if (!manifestExists) {
      const discovered = await autoDiscoverManifest(opts.cwd)
      if (discovered) {
        manifestAbs = discovered.path
        dbtRoot = discovered.projectRoot
        process.stderr.write(
          `ℹ️  auto-discovered dbt manifest at ${discovered.path} ` +
            `(dbt project root: ${discovered.projectRoot}). Pass --manifest to override.\n`,
        )
      }
    }
  }
  // Freshness check: warn (don't fail) when the manifest predates changed files.
  // Skip when we're diffing against the working tree (mtime signal is noisy
  // during active edits) — only warn when the caller explicitly pinned a head
  // ref, which is the CI / bench shape where a stale manifest is a real risk.
  if (opts.head) await warnIfStale(manifestAbs, changedFiles.map((f) => f.path), opts.cwd)

  // Resolve the SQL dialect: explicit config wins; otherwise auto-detect from
  // the dbt manifest's `adapter_type` (so a BigQuery/Redshift project isn't
  // analyzed as the snowflake default — wrong-dialect portability suppression).
  if (!config.dialect) config.dialect = (await detectDialect(manifestAbs)) ?? "snowflake"

  // Prefer dbt's catalog.json (real warehouse columns from `dbt docs generate`)
  // for the schema context — complete columns are what make column-lineage
  // breakage and proven equivalence actually fire (the manifest only has
  // documented columns). Falls back to manifest-derived schema when absent.
  const catalogAbs = path.join(path.dirname(manifestAbs), "catalog.json")
  const catalogSchema = await buildCatalogSchemaContext(catalogAbs)
  const runner = createDispatcherRunner({ manifestPath: manifestAbs, schemaContext: catalogSchema })
  const mhash = await manifestHash(manifestAbs, opts.cwd)

  // Prefer dbt's COMPILED SQL (target/compiled) for the engine lanes — the clean
  // approach (Datafold/Recce/Fusion all render-then-analyze rather than parse Jinja).
  // Use `dbtRoot` (the discovered project root when G3 auto-discovery fired,
  // else opts.cwd) so a subdir invocation still finds `target/compiled/…`
  // next to the discovered manifest instead of falling back to raw Jinja.
  const projectName = await dbtProjectName(dbtRoot)
  const getCompiled = opts.getContent ? undefined : makeCompiledResolver({ cwd: dbtRoot, projectName })

  return runReview({
    changedFiles,
    config,
    rubric,
    mode: config.mode,
    runner,
    getContent,
    getCompiled,
    generatedAt: new Date().toISOString(),
    manifestHash: mhash,
    modelVersion: opts.modelVersion,
    coreVersion: opts.coreVersion,
    aiReview: opts.noAi || config.ai === false ? undefined : runAiReview,
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    explainTier: opts.explainTier,
    forceTier: opts.forceTier,
  })
}

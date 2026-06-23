import path from "node:path"
import { readFile } from "node:fs/promises"
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
  const manifestAbs = path.isAbsolute(config.manifestPath)
    ? config.manifestPath
    : path.join(opts.cwd, config.manifestPath)

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
  const projectName = await dbtProjectName(opts.cwd)
  const getCompiled = opts.getContent ? undefined : makeCompiledResolver({ cwd: opts.cwd, projectName })

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
  })
}

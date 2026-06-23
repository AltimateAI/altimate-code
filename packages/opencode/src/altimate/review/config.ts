import z from "zod"
import path from "node:path"
import { promises as fs } from "node:fs"
import YAML from "yaml"
import { Rubric, DEFAULT_RUBRIC } from "./rubric"
import { ReviewMode } from "./verdict"
import { Severity } from "./finding"

/**
 * Per-repo review configuration, read from `.altimate/review.yml` (the
 * analogue of Cloudflare's AGENTS.md). Lets each team tune the rubric, choose
 * reviewer lanes, and pick comment-vs-gate without forking the product.
 */

export const ReviewConfig = z.object({
  /** comment (default, never blocks) | gate (blocks on REQUEST_CHANGES). */
  mode: ReviewMode.default("comment"),
  /** Restrict to a subset of reviewer lanes; empty = tier defaults. */
  reviewers: z.array(z.string()).default([]),
  /** Minimum severity to surface (drops anything lower). */
  severityThreshold: Severity.default("suggestion"),
  /** Path to the compiled dbt manifest. */
  manifestPath: z.string().default("target/manifest.json"),
  /** SQL dialect for static analysis. Empty = auto-detect from the dbt
   *  manifest's `adapter_type` (set explicitly here to override). */
  dialect: z.string().default(""),
  /** Enable the advisory LLM reviewer lane (needs a configured model). */
  ai: z.boolean().default(true),
  /**
   * Data-diff: actually run base-vs-head against the warehouse (core DataParity)
   * and report row/value deltas. OPT-IN — it costs warehouse compute and needs a
   * configured warehouse connection, so it is OFF by default. Configure
   * credentials via a connection (env `ALTIMATE_CODE_CONN_<NAME>` for CI,
   * `~/.altimate-code/connections.json`, or a dbt `profiles.yml`); see the
   * "Data-diff in CI" section of the docs.
   */
  dataDiff: z
    .object({
      /** Run the data-diff lane (requires a configured warehouse). */
      enabled: z.boolean().default(false),
      /** Connection name to diff against. Empty = the default/first connection. */
      warehouse: z.string().default(""),
    })
    .default({ enabled: false, warehouse: "" }),
  /** Rubric overrides, deep-merged onto DEFAULT_RUBRIC. */
  rubric: Rubric.partial().default({}),
  /** Extra path suffixes to exclude from review. */
  exclude: z.array(z.string()).default([]),
})
export type ReviewConfig = z.infer<typeof ReviewConfig>

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = ReviewConfig.parse({})

/** Deep-merge a partial rubric override onto the default rubric. */
export function resolveRubric(cfg: ReviewConfig): Rubric {
  return Rubric.parse({
    ...DEFAULT_RUBRIC,
    ...cfg.rubric,
    thresholds: { ...DEFAULT_RUBRIC.thresholds, ...(cfg.rubric.thresholds ?? {}) },
    exclusions: {
      ...DEFAULT_RUBRIC.exclusions,
      ...(cfg.rubric.exclusions ?? {}),
      // Config-level `exclude` globs feed the rubric's excludeGlobs.
      excludeGlobs: [
        ...(DEFAULT_RUBRIC.exclusions.excludeGlobs ?? []),
        ...(cfg.rubric.exclusions?.excludeGlobs ?? []),
        ...cfg.exclude,
      ],
    },
  })
}

const CANDIDATE_FILES = [".altimate/review.yml", ".altimate/review.yaml", ".altimate/review.json"]

/** Parse review config from raw text (YAML or JSON). Exposed for testing. */
export function parseReviewConfig(text: string): ReviewConfig {
  const data = YAML.parse(text) ?? {}
  return ReviewConfig.parse(data)
}

/**
 * Load `.altimate/review.{yml,yaml,json}` from a project directory. Returns the
 * defaults when no config file is present. Throws on a malformed/invalid file
 * (fail-fast — a broken governance file should not silently no-op).
 */
export async function loadReviewConfig(dir: string): Promise<ReviewConfig> {
  for (const rel of CANDIDATE_FILES) {
    const full = path.join(dir, rel)
    try {
      const text = await fs.readFile(full, "utf8")
      return parseReviewConfig(text)
    } catch (e: any) {
      if (e?.code === "ENOENT") continue
      throw new Error(`Failed to load ${rel}: ${e?.message ?? e}`)
    }
  }
  // Fresh copy — callers (e.g. the CLI overriding manifestPath) mutate the
  // returned config, and the module-level DEFAULT_REVIEW_CONFIG must not leak
  // those mutations into the next review in the same process.
  return structuredClone(DEFAULT_REVIEW_CONFIG)
}

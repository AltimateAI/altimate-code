import z from "zod"
import path from "node:path"
import { promises as fs } from "node:fs"
import YAML from "yaml"
import { createHash } from "node:crypto"
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
   * Report cross-engine portability advice ("isn't portable across
   * warehouses"). Off by default once the engine is known (from the manifest's
   * adapter or `dialect`), because a project that runs on one engine gains
   * nothing from it. Turn on for packages that support several adapters.
   * Functions missing on the project's own engine are always reported.
   */
  portability: z.boolean().optional(),
  /**
   * Opt-in: report a new column missing from an enforced contract. `dbt build`
   * already fails on it, so this only helps CI that runs `dbt parse`/`compile`
   * without building.
   */
  checkContractColumns: z.boolean().default(false),
  /**
   * Opt-in: explicit column lists outside dbt (loaders, exports) that must
   * track a model's columns. `files` is a repo-relative glob, `pattern` a regex
   * whose first capture group is the list, `model` the model it mirrors
   * (omitted = files that mention the model by name).
   */
  /**
   * Opt-in: vars that select the slice one incremental run processes (e.g.
   * `tenant`, `region`). A `delete+insert`/`merge` model filtered by one of
   * them must include the filtered column in `unique_key`.
   */
  incrementalSliceVars: z.array(z.string()).default([]),
  consumerColumnLists: z
    .array(z.object({ files: z.string(), pattern: z.string(), model: z.string().optional() }))
    .default([]),
  /** Allow `--force-tier` (a debug bypass of the risk classifier). Set false
   *  in gate CI so a run cannot skip checks by forcing a lower tier. */
  allowForceTier: z.boolean().default(true),
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
  /**
   * Path-token categories that promote a change to `full` when a token
   * appears at a path/word boundary. This is business-vertical opinion
   * (billing, PII-adjacent, safety-critical) — hardcoding it into the
   * reviewer core would leak one team's naming convention onto every
   * consumer. Empty by default; teams opt in by naming categories and
   * listing tokens.
   *
   * Example — enable the shipped `finops` preset (billing/cost/etc.):
   *   riskTierPathTokens:
   *     finops: [preset:finops]
   *
   * Or a custom category:
   *   riskTierPathTokens:
   *     pci: [card, pan, cvv]
   *     patient: [phi, mrn, diagnosis]
   *
   * Matching is case-insensitive at path/word/digit boundaries — a token
   * `cost` fires on `mrt_cost_daily.sql` and `mrt_cost2024.sql` but not
   * inside `broadcaster.sql` or `precast_table.sql`. The `preset:<name>`
   * marker expands to the current shipped list at reviewer startup.
   */
  // Tokens must be non-empty. An empty string here compiles into a regex
  // alternative that matches everywhere between two boundary characters
  // (`(?:|foo)` matches the empty string), silently over-promoting paths
  // like `stg__orders.sql` where two boundary chars are adjacent.
  // Cubic-review P2 on PR #1028.
  riskTierPathTokens: z.record(z.string(), z.array(z.string().min(1))).default({}),
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

/** Where the applied policy came from. */
export type PolicySource = "base" | "working_tree" | "default"

export interface ReviewPolicy {
  config: ReviewConfig
  source: PolicySource
  /** Short hash of the applied config (canonical JSON), signed into the envelope. */
  hash: string
  /** Settings the PR changes relative to the applied base policy (not applied). */
  changedInPr: string[]
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  const obj = value as Record<string, unknown>
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  )
}

/** Short, stable hash of a resolved config. */
export function policyHash(config: ReviewConfig): string {
  return createHash("sha256").update(canonical(config)).digest("hex").slice(0, 16)
}

/** Settings that differ between two configs: top-level keys, and `rubric.*` one level down. */
export function policyChanges(base: ReviewConfig, head: ReviewConfig): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]) as Set<keyof ReviewConfig>
  for (const k of [...keys].sort()) {
    if (canonical(base[k]) === canonical(head[k])) continue
    if (k === "rubric") {
      const b = (base.rubric ?? {}) as Record<string, unknown>
      const h = (head.rubric ?? {}) as Record<string, unknown>
      for (const rk of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort())
        if (canonical(b[rk]) !== canonical(h[rk])) out.push(`rubric.${rk}`)
    } else out.push(k)
  }
  return out
}

async function readFirst(read: (rel: string) => Promise<string | undefined>): Promise<string | undefined> {
  for (const rel of CANDIDATE_FILES) {
    const text = await read(rel)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Load the review policy the PR is judged by.
 *
 * With `readBase` (a reader over the merge-base commit), the policy is the
 * BASE branch's `.altimate/review.yml`: a pull request must not be able to
 * relax the rules it is reviewed under (switch `mode` to comment, drop a
 * `blockOn` category, exclude its own paths, disable lanes). The PR's own
 * version is parsed only to list what it would change, which the comment
 * shows; it takes effect once merged. Without `readBase` (no git), the working
 * tree's file applies.
 */
export async function loadReviewPolicy(opts: {
  cwd: string
  readBase?: (rel: string) => Promise<string | undefined>
}): Promise<ReviewPolicy> {
  if (!opts.readBase) {
    const config = await loadReviewConfig(opts.cwd)
    const present = await readFirst((rel) => fs.readFile(path.join(opts.cwd, rel), "utf8").catch(() => undefined))
    return { config, source: present === undefined ? "default" : "working_tree", hash: policyHash(config), changedInPr: [] }
  }
  const baseText = await readFirst(opts.readBase)
  let config: ReviewConfig
  try {
    config = baseText === undefined ? structuredClone(DEFAULT_REVIEW_CONFIG) : parseReviewConfig(baseText)
  } catch (e: any) {
    throw new Error(`Failed to load the base branch's .altimate/review config: ${e?.message ?? e}`)
  }
  const headText = await readFirst((rel) => fs.readFile(path.join(opts.cwd, rel), "utf8").catch(() => undefined))
  let changedInPr: string[] = []
  if (headText !== baseText) {
    try {
      const head = headText === undefined ? structuredClone(DEFAULT_REVIEW_CONFIG) : parseReviewConfig(headText)
      changedInPr = policyChanges(config, head)
    } catch {
      changedInPr = ["(the PR's .altimate/review file does not parse)"]
    }
  }
  return { config, source: baseText === undefined ? "default" : "base", hash: policyHash(config), changedInPr }
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

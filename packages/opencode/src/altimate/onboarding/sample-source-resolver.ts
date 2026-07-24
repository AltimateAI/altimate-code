import fs from "node:fs"
import path from "node:path"

/**
 * Locate the read-only source tree of a starter sample project.
 *
 * The sample is shipped inside the wrapper npm package (see
 * `script/publish.ts::copyAssets` — it copies `sample-projects/` into the
 * wrapper alongside `bin/` and `skills/`). At runtime the resolver hunts
 * across the layouts we ship in:
 *
 *   1. `ALTIMATE_STARTER_SAMPLE_DIR` env override — used by tests and by
 *      users pointing at a hand-curated fork of the sample.
 *   2. Production: the compiled bun single-file exe lives at
 *      `<wrapper-pkg>/bin/altimate-code`, so the sample source is at
 *      `<wrapper-pkg>/sample-projects/<name>/`.
 *   3. `bun run src/index.ts` (dev) or `bun test` — resolves relative to
 *      this file's own dirname, walking up to `packages/opencode/` then
 *      into `sample-projects/`.
 *   4. Some install layouts (npx cache, pnpm content-addressable store) put
 *      the exe two hops away from the wrapper root — try one more level up.
 *
 * Returns the absolute path to the sample source directory, or `undefined`
 * if no candidate contained a `dbt_project.yml`. Callers should surface an
 * actionable error rather than crash — the sample is a nice-to-have on
 * every activation, but the CLI stays usable without it.
 */

export const DEFAULT_SAMPLE_NAME = "jaffle-shop-duckdb"

/** Sentinel in `target/manifest.json` that stands in for the materialized
 *  target path. Substituted at load time by the sample-project consumer. */
export const SAMPLE_ROOT_SENTINEL = "{{SAMPLE_ROOT}}"

/** Sentinel for the parent of the materialized target — a couple of dbt
 *  manifest metadata fields carry the parent. */
export const SAMPLE_ROOT_PARENT_SENTINEL = "{{SAMPLE_ROOT_PARENT}}"

export interface SampleSourceLocation {
  /** Absolute path to the sample source directory. */
  path: string
  /** Which candidate matched — surfaced in logs for debugging install-layout issues. */
  origin: "env" | "wrapper-bin-parent" | "dev-source-tree" | "wrapper-bin-grandparent"
}

export function resolveSampleSource(
  name: string = DEFAULT_SAMPLE_NAME,
): SampleSourceLocation | undefined {
  const envOverride = process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
  if (envOverride) {
    const candidate = path.join(envOverride, name)
    if (hasSampleShape(candidate)) return { path: path.resolve(candidate), origin: "env" }
  }

  const execDir = path.dirname(process.execPath)
  // Handles: this file's dirname, which after Bun compile lives inside the
  // baked filesystem — falls back to __dirname when unavailable.
  const selfDir = import.meta.dirname ?? (typeof __dirname === "string" ? __dirname : "")

  const candidates: Array<{ path: string; origin: SampleSourceLocation["origin"] }> = [
    { path: path.join(execDir, "..", "sample-projects", name), origin: "wrapper-bin-parent" },
    // Dev / test: <repo>/packages/opencode/src/altimate/onboarding/*.ts
    // → 4 hops up to packages/opencode/, then into sample-projects/.
    {
      path: path.join(selfDir, "..", "..", "..", "..", "sample-projects", name),
      origin: "dev-source-tree",
    },
    {
      path: path.join(execDir, "..", "..", "sample-projects", name),
      origin: "wrapper-bin-grandparent",
    },
  ]

  for (const c of candidates) {
    if (hasSampleShape(c.path)) return { path: path.resolve(c.path), origin: c.origin }
  }
  return undefined
}

function hasSampleShape(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, "dbt_project.yml"))
  } catch {
    return false
  }
}

/**
 * Load the shipped `target/manifest.json` from the sample source, rehydrating
 * the SAMPLE_ROOT sentinels with the user's materialized target path. Static
 * workflows (/discover, /review) read this without needing dbt installed on
 * the user's machine.
 *
 * Throws if the sample source is missing or the manifest is malformed —
 * callers should catch and fall back to an actionable message.
 */
export function loadShippedManifest(
  sampleSource: string,
  materializedTarget: string,
): Record<string, unknown> {
  const manifestPath = path.join(sampleSource, "target", "manifest.json")
  const raw = fs.readFileSync(manifestPath, "utf8")
  const rehydrated = raw
    .split(SAMPLE_ROOT_SENTINEL)
    .join(materializedTarget)
    .split(SAMPLE_ROOT_PARENT_SENTINEL)
    .join(path.dirname(materializedTarget))
  return JSON.parse(rehydrated) as Record<string, unknown>
}

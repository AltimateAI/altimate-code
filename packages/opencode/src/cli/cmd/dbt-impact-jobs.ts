// altimate_change start — dbt-impact job maps: which job builds which models,
// for the cross-job schema-lag check. One neutral format, adapters into it,
// and resolution of each job's selection with `dbt ls` (no warehouse).
import { existsSync, readFileSync } from "fs"
import path from "path"
import YAML from "yaml"
import { dbtLs, type DbtOfflineOptions } from "../../altimate/native/dbt/runner"

/** One scheduled dbt invocation. `models` is the resolved selection
 *  (`unique_id`s); the engine ignores a job without it. */
export interface JobDef {
  select?: string
  exclude?: string
  /** A `selectors.yml` selector, when the job runs `--selector`. */
  selector?: string
  /** Cron expression, when known. */
  schedule?: string
  models?: string[]
}

/** `{"jobs": {name: {select, exclude, schedule}}}` */
export interface JobMap {
  jobs: Record<string, JobDef>
}

const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v
  if (Array.isArray(v)) return v.map(String).join(" ")
  return undefined
}

/** Parse a job map (JSON or YAML). Any document with a top-level `jobs` map
 *  works, so a benchmark `case.yaml` can be passed as is. */
export function parseJobMap(text: string, source = "job map"): JobMap | { error: string } {
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch (e) {
    return { error: `${source}: not JSON or YAML (${e instanceof Error ? e.message : String(e)})` }
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs))
    return { error: `${source}: expected {"jobs": {name: {"select", "exclude", "schedule"}}}` }
  const out: JobMap = { jobs: {} }
  for (const [name, raw] of Object.entries(jobs as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") return { error: `${source}: job ${name} is not an object` }
    const j = raw as Record<string, unknown>
    const def: JobDef = {}
    const select = str(j.select)
    const exclude = str(j.exclude)
    const selector = str(j.selector)
    const schedule = str(j.schedule ?? j.cron)
    if (select?.trim()) def.select = select.trim()
    if (exclude?.trim()) def.exclude = exclude.trim()
    if (selector?.trim()) def.selector = selector.trim()
    if (schedule?.trim()) def.schedule = schedule.trim()
    if (Array.isArray(j.models)) def.models = j.models.map(String)
    if (!def.select && !def.selector && !def.models)
      return { error: `${source}: job ${name} needs "select", "selector" or "models"` }
    out.jobs[name] = def
  }
  if (!Object.keys(out.jobs).length) return { error: `${source}: no jobs` }
  return out
}

/** Read a `--jobs` file. */
export function readJobMap(file: string): JobMap | { error: string } {
  const abs = path.resolve(file)
  if (!existsSync(abs)) return { error: `--jobs file not found: ${abs}` }
  return parseJobMap(readFileSync(abs, "utf-8"), abs)
}

/**
 * Adapter: one job per selector in the project's `selectors.yml`. Schedules
 * come from a `schedules.json` next to it when present (`{selector: cron}` or
 * `{selector: {cron}}`); otherwise they are unknown.
 */
export function jobsFromSelectors(projectDir: string): JobMap | { error: string } {
  const file = ["selectors.yml", "selectors.yaml"].map((f) => path.join(projectDir, f)).find((f) => existsSync(f))
  if (!file) return { error: `--jobs-from selectors: no selectors.yml in ${projectDir}` }
  let doc: { selectors?: Array<{ name?: unknown }> }
  try {
    doc = YAML.parse(readFileSync(file, "utf-8")) ?? {}
  } catch (e) {
    return { error: `${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const names = (doc.selectors ?? []).map((s) => s?.name).filter((n): n is string => typeof n === "string")
  if (!names.length) return { error: `${file}: no selectors` }
  const schedules = readSchedules(projectDir)
  const out: JobMap = { jobs: {} }
  for (const n of names) {
    out.jobs[n] = { selector: n }
    if (schedules[n]) out.jobs[n].schedule = schedules[n]
  }
  return out
}

function readSchedules(projectDir: string): Record<string, string> {
  const file = path.join(projectDir, "schedules.json")
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      const cron = typeof v === "string" ? v : (v as { cron?: unknown } | null)?.cron
      if (typeof cron === "string") out[k] = cron
    }
    return out
  } catch {
    return {}
  }
}

export type LsFn = typeof dbtLs

/** Resolve every job without `models` with `dbt ls`. A job that fails to
 *  resolve keeps no models (the engine then ignores it) and is reported. */
export async function resolveJobMap(
  map: JobMap,
  opts: DbtOfflineOptions,
  ls: LsFn = dbtLs,
): Promise<{ map: JobMap; errors: string[] }> {
  const errors: string[] = []
  const out: JobMap = { jobs: {} }
  for (const [name, def] of Object.entries(map.jobs)) {
    if (def.models) {
      out.jobs[name] = def
      continue
    }
    const r = await ls({ select: def.select, exclude: def.exclude, selector: def.selector }, opts)
    if (r.ok) out.jobs[name] = { ...def, models: r.ids }
    else {
      errors.push(`job ${name}: dbt ls failed: ${r.error}`)
      out.jobs[name] = def
    }
  }
  return { map: out, errors }
}
// altimate_change end

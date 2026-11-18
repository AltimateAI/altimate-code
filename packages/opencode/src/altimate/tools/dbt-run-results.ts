import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"
import { isFailedRunStatus, readRunResults, type RunResultsArtifact } from "../validators/validator-utils"

/** A message longer than this is cut: a build of thousands of nodes must stay readable and small. */
const MAX_MESSAGE = 2000
/** An id, name, status or command longer than this is cut: the artifact decides how long they are, the answer must not follow. */
const MAX_IDENTIFIER = 300
/** The rows one answer carries: a plugin reads at most 4 MiB of it, so a bigger build is counted, not listed. */
const MAX_ROWS = 200

export interface DbtRunResultRow {
  uniqueId: string
  name: string
  status: string
  executionTimeSec: number | null
  message: string | null
}

export interface DbtRunResultsView {
  found: boolean
  /** The dbt project folder the artifact was read from. */
  projectDir: string | null
  invocationId: string | null
  command: string | null
  elapsedSec: number | null
  /** The artifact's modification time, ISO 8601. */
  completedAt: string | null
  /** Every node dbt reported; `results` holds at most MAX_ROWS of them, the failures first. */
  total: number
  passed: number
  failed: number
  skipped: number
  results: DbtRunResultRow[]
}

const NONE: DbtRunResultsView = {
  found: false,
  projectDir: null,
  invocationId: null,
  command: null,
  elapsedSec: null,
  completedAt: null,
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  results: [],
}

/** A test's unique id ends in a hash (`test.shop.not_null_orders_id.f3a1c`): its name is the part before it. */
function displayName(uniqueId: string, name: string): string {
  const parts = uniqueId.split(".")
  return parts[0] === "test" && parts.length === 4 ? (parts[2] ?? name).toLowerCase() : name
}

/** Statuses of a node dbt did not run. */
const NOT_RUN = new Set(["skipped", "no-op"])

function cut(text: string | null, max = MAX_MESSAGE): string | null {
  if (text === null) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The fields `readRunResults` does not carry, from the same file version it parsed (null when the file changed since). */
async function extraFields(
  file: string,
  mtimeMs: number,
): Promise<{ invocationId: string | null; elapsedSec: number | null; times: Map<string, number> } | null> {
  try {
    const before = await fs.stat(file)
    if (before.mtimeMs !== mtimeMs) return null
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      metadata?: { invocation_id?: unknown }
      elapsed_time?: unknown
      results?: unknown
    }
    const after = await fs.stat(file)
    if (after.mtimeMs !== mtimeMs || after.size !== before.size || after.ino !== before.ino) return null
    const times = new Map<string, number>()
    if (Array.isArray(parsed.results)) {
      for (const r of parsed.results as Array<Record<string, unknown>>) {
        if (r && typeof r["unique_id"] === "string" && typeof r["execution_time"] === "number" && Number.isFinite(r["execution_time"]))
          times.set(r["unique_id"], r["execution_time"])
      }
    }
    const id = parsed.metadata?.invocation_id
    const elapsed = typeof parsed.elapsed_time === "number" && Number.isFinite(parsed.elapsed_time) ? parsed.elapsed_time : null
    return { invocationId: typeof id === "string" && id ? id : null, elapsedSec: elapsed, times }
  } catch {
    return null
  }
}

/**
 * The artifact of a run that wrote to a folder of its own (`--target-path`): `readRunResults` only knows the project's configured
 * folder, so a folder the caller names is read here, with the same fields and the same rule that a file without `results` is no artifact.
 */
async function readRunResultsIn(file: string): Promise<RunResultsArtifact | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return null
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { results?: unknown; args?: unknown }
    if (!Array.isArray(parsed.results)) return null
    const which = typeof parsed.args === "object" && parsed.args !== null ? (parsed.args as Record<string, unknown>)["which"] : undefined
    const results: RunResultsArtifact["results"] = []
    for (const row of parsed.results as unknown[]) {
      if (typeof row !== "object" || row === null) continue
      const r = row as Record<string, unknown>
      const uniqueId = typeof r["unique_id"] === "string" ? r["unique_id"] : ""
      if (!uniqueId) continue
      const parts = uniqueId.split(".")
      const last = (parts[parts.length - 1] ?? "").toLowerCase()
      const versioned = parts.length > 3 && /^v\d+$/.test(last)
      results.push({
        uniqueId,
        name: versioned ? (parts[parts.length - 2] ?? "").toLowerCase() : last,
        version: versioned ? last : null,
        status: typeof r["status"] === "string" ? r["status"].toLowerCase() : "",
        message: typeof r["message"] === "string" ? r["message"] : null,
      })
    }
    return { path: file, mtimeMs: stat.mtimeMs, results, command: (typeof which === "string" ? which.trim().toLowerCase() : "") || null }
  } catch {
    return null
  }
}

/**
 * The last dbt run of a project: `readRunResults` gives the path, the command and each row's status and
 * message; the invocation id, elapsed time and execution times are read from the same file version.
 */
export async function readRunView(dbtRoot: string, targetPath?: string): Promise<DbtRunResultsView> {
  const named = targetPath?.trim()
  const artifact = named
    ? await readRunResultsIn(path.join(path.isAbsolute(named) ? named : path.join(dbtRoot, named), "run_results.json"))
    : await readRunResults(dbtRoot)
  if (!artifact) return NONE
  const extra = await extraFields(artifact.path, artifact.mtimeMs)
  if (!extra) return NONE
  const all = artifact.results.map(
    (node): DbtRunResultRow => ({
      uniqueId: cut(node.uniqueId, MAX_IDENTIFIER) ?? "",
      name: cut(displayName(node.uniqueId, node.name), MAX_IDENTIFIER) ?? "",
      status: cut(node.status, MAX_IDENTIFIER) ?? "",
      executionTimeSec: extra.times.get(node.uniqueId) ?? null,
      message: cut(node.message),
    }),
  )
  const failed = all.filter((row) => isFailedRunStatus(row.status) && !NOT_RUN.has(row.status))
  const skipped = all.filter((row) => NOT_RUN.has(row.status)).length
  const failing = new Set(failed)
  // The failures first, then the rest in the file's order, whatever the size: a reader that stops early still sees them.
  const listed = [...failed, ...all.filter((row) => !failing.has(row))].slice(0, MAX_ROWS)
  return {
    found: true,
    projectDir: dbtRoot,
    invocationId: cut(extra.invocationId, MAX_IDENTIFIER),
    command: cut(artifact.command, MAX_IDENTIFIER),
    elapsedSec: extra.elapsedSec,
    completedAt: new Date(artifact.mtimeMs).toISOString(),
    total: all.length,
    passed: all.length - failed.length - skipped,
    failed: failed.length,
    skipped,
    results: listed,
  }
}

export const DbtRunResultsTool = Tool.define("dbt_run_results", {
  description:
    "Read the last dbt run of a project from its target/run_results.json (or the folder `target_path` names): the invocation id, the dbt command, the elapsed seconds, when it finished, the counts, and one row per node (the failures first, at most 200) with its status, execution seconds and message. Read-only; runs nothing. A compile or parse writes success rows without building anything, so look at `command`.",
  parameters: z.object({
    project_dir: z
      .string()
      .optional()
      .describe("A folder in the dbt project (its dbt_project.yml is looked for there and above; default: the project the session's directory is in, else the one the dbt adapter is configured for)"),
    target_path: z
      .string()
      .optional()
      .describe("The folder the dbt run wrote its artifacts to when it was not the project's own target folder (a relative one is from the project)"),
  }),
  async execute(args) {
    const root = args.project_dir ? await projectAbove(path.resolve(projectRoot(), args.project_dir)) : await defaultRoot()
    const view = await readRunView(root, args.target_path)
    if (!view.found) {
      return {
        title: "dbt run results: none",
        metadata: { ...view },
        output: `No readable run_results.json for the dbt project at ${root}${args.target_path ? ` (in ${args.target_path})` : ""}: no dbt command has written one there yet, or the file is not a run artifact.`,
      }
    }
    const command = view.command ? `dbt ${view.command}` : "dbt (unknown command)"
    return {
      title: `${command}: ${view.passed}/${view.total} ok`,
      metadata: { ...view },
      output: [
        `${command} · invocation ${view.invocationId ?? "unknown"} · ${view.elapsedSec ?? "?"}s · ${view.completedAt}`,
        ...view.results.map(
          (row) => `${row.status} ${row.name} ${row.executionTimeSec ?? "-"}s${row.message ? ` · ${row.message}` : ""}`,
        ),
        ...(view.total > view.results.length ? [`… and ${view.total - view.results.length} more nodes not listed`] : []),
      ].join("\n"),
    }
  },
})

/** The dbt project `dir` is in: the closest folder at or above it holding dbt_project.yml, else `dir`. */
async function projectAbove(dir: string): Promise<string> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  return findProjectRoot(dir) ?? dir
}

/** The dbt project the session's directory is in, else the one the dbt adapter is configured for (as the other dbt tools choose). */
async function defaultRoot(): Promise<string> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const here = findProjectRoot(projectRoot())
  if (here) return here
  const { getDbtProjectRoot } = await import("../native/connections/register")
  return (await getDbtProjectRoot()) ?? projectRoot()
}

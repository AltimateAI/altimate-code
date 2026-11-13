import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"
import { isFailedRunStatus, readRunResults } from "../validators/validator-utils"

/** A message longer than this is cut: a build of thousands of nodes must stay readable and small. */
const MAX_MESSAGE = 2000
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

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

function cut(text: string | null): string | null {
  if (text === null) return null
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * The last dbt run of a project: `readRunResults` gives the artifact's path, its command and its rows;
 * the invocation id, the elapsed time and each row's execution time are read from the same file here,
 * because the validators that share `readRunResults` have no use for them. Another dbt command may
 * rewrite the file between the two reads: the second counts only when the file is the same one (same
 * modification time and same rows), else both are read again, and a file that keeps changing gives its
 * rows without an identity rather than another run's.
 */
export async function readRunView(dbtRoot: string): Promise<DbtRunResultsView> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const artifact = await readRunResults(dbtRoot)
    if (!artifact) return NONE
    let raw: Record<string, unknown> = {}
    let same = false
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(artifact.path, "utf8"))
      if (isRecord(parsed)) raw = parsed
      same = (await fs.stat(artifact.path)).mtimeMs === artifact.mtimeMs
    } catch {
      // The file went away after it was parsed: the rows are still good, the timings are not known.
    }
    // `readRunResults` keeps the rows that are objects with a unique_id; the same rows, in the same order, here.
    const rows = (Array.isArray(raw["results"]) ? raw["results"] : []).filter(
      (row): row is Record<string, unknown> => isRecord(row) && typeof row["unique_id"] === "string" && !!row["unique_id"],
    )
    same = same && rows.length === artifact.results.length && rows.every((row, at) => row["unique_id"] === artifact.results[at]?.uniqueId)
    if (!same && attempt < 2) continue
    const meta = isRecord(raw["metadata"]) ? raw["metadata"] : {}
    const invocation = same && typeof meta["invocation_id"] === "string" && meta["invocation_id"] ? meta["invocation_id"] : null
    const all = artifact.results.map((node, at): DbtRunResultRow => ({
      uniqueId: node.uniqueId,
      name: displayName(node.uniqueId, node.name),
      status: node.status,
      executionTimeSec: same ? num(rows[at]?.["execution_time"]) : null,
      message: cut(node.message),
    }))
    const failed = all.filter((row) => isFailedRunStatus(row.status) && !NOT_RUN.has(row.status))
    const skipped = all.filter((row) => NOT_RUN.has(row.status)).length
    const failing = new Set(failed)
    // The failures first, then the rest in the file's order, whatever the size: a reader that stops early still sees them.
    const listed = [...failed, ...all.filter((row) => !failing.has(row))].slice(0, MAX_ROWS)
    return {
      found: true,
      projectDir: dbtRoot,
      invocationId: invocation,
      command: artifact.command,
      elapsedSec: same ? num(raw["elapsed_time"]) : null,
      completedAt: new Date(artifact.mtimeMs).toISOString(),
      total: all.length,
      passed: all.length - failed.length - skipped,
      failed: failed.length,
      skipped,
      results: listed,
    }
  }
  return NONE
}

export const DbtRunResultsTool = Tool.define("dbt_run_results", {
  description:
    "Read the last dbt run of a project from its target/run_results.json: the invocation id, the dbt command, the elapsed seconds, when it finished, the counts, and one row per node (the failures first, at most 200) with its status, execution seconds and message. Read-only; runs nothing. A compile or parse writes success rows without building anything, so look at `command`.",
  parameters: z.object({
    project_dir: z
      .string()
      .optional()
      .describe("A folder in the dbt project (its dbt_project.yml is looked for there and above; default: the project the dbt adapter is configured for, else the session's directory's)"),
  }),
  async execute(args) {
    const root = args.project_dir ? await projectAbove(path.resolve(projectRoot(), args.project_dir)) : await defaultRoot()
    const view = await readRunView(root)
    if (!view.found) {
      return {
        title: "dbt run results: none",
        metadata: { ...view },
        output: `No readable run_results.json for the dbt project at ${root}: no dbt command has written one there yet, or the file is not a run artifact.`,
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

/** The project the dbt adapter is configured for, else the one the session's directory is in. */
async function defaultRoot(): Promise<string> {
  const { getDbtProjectRoot } = await import("../native/connections/register")
  const configured = await getDbtProjectRoot()
  if (configured) return configured
  return projectAbove(projectRoot())
}

import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"
import { isFailedRunStatus, readRunResults } from "../validators/validator-utils"

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

/**
 * The last dbt run of a project, from one read of its run_results.json: `readRunResults` gives the path,
 * the command, the invocation id, the elapsed time and each row's status, execution time and message,
 * so every field belongs to the same file. `targetPath` names the folder a run with `--target-path`
 * wrote to.
 */
export async function readRunView(dbtRoot: string, targetPath?: string): Promise<DbtRunResultsView> {
  const artifact = await readRunResults(dbtRoot, targetPath)
  if (!artifact) return NONE
  const all = artifact.results.map(
    (node): DbtRunResultRow => ({
      uniqueId: cut(node.uniqueId, MAX_IDENTIFIER) ?? "",
      name: cut(displayName(node.uniqueId, node.name), MAX_IDENTIFIER) ?? "",
      status: cut(node.status, MAX_IDENTIFIER) ?? "",
      executionTimeSec: node.executionTimeSec,
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
    invocationId: cut(artifact.invocationId, MAX_IDENTIFIER),
    command: cut(artifact.command, MAX_IDENTIFIER),
    elapsedSec: artifact.elapsedSec,
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

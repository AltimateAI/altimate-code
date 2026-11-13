import fs from "node:fs/promises"
import z from "zod"
import { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"
import { readRunResults } from "../validators/validator-utils"

/** A message longer than this is cut: a build of thousands of nodes must stay readable and small. */
const MAX_MESSAGE = 2000

export interface DbtRunResultRow {
  uniqueId: string
  name: string
  status: string
  executionTimeSec: number | null
  message: string | null
}

export interface DbtRunResultsView {
  found: boolean
  invocationId: string | null
  command: string | null
  elapsedSec: number | null
  /** The artifact's modification time, ISO 8601. */
  completedAt: string | null
  results: DbtRunResultRow[]
}

const NONE: DbtRunResultsView = {
  found: false,
  invocationId: null,
  command: null,
  elapsedSec: null,
  completedAt: null,
  results: [],
}

/** A test's unique id ends in a hash (`test.shop.not_null_orders_id.f3a1c`): its name is the part before it. */
function displayName(uniqueId: string, name: string): string {
  const parts = uniqueId.split(".")
  return parts[0] === "test" && parts.length === 4 ? (parts[2] ?? name) : name
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

function cut(text: string | null): string | null {
  if (text === null) return null
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
}

/**
 * The last dbt run of a project: `readRunResults` gives the artifact's path, its command and its rows;
 * the invocation id, the elapsed time and each row's execution time are read from the same file here,
 * because the validators that share `readRunResults` have no use for them.
 */
export async function readRunView(dbtRoot: string): Promise<DbtRunResultsView> {
  const artifact = await readRunResults(dbtRoot)
  if (!artifact) return NONE
  let raw: { metadata?: unknown; elapsed_time?: unknown; results?: unknown } = {}
  try {
    raw = JSON.parse(await fs.readFile(artifact.path, "utf8"))
  } catch {
    // The file changed or went away after it was parsed: the rows are still good, the timings are not known.
  }
  const meta = typeof raw.metadata === "object" && raw.metadata !== null ? (raw.metadata as Record<string, unknown>) : {}
  const invocation = typeof meta["invocation_id"] === "string" && meta["invocation_id"] ? meta["invocation_id"] : null
  // `readRunResults` keeps the rows that are objects with a unique_id; the same rows, in the same order, here.
  const rows = (Array.isArray(raw.results) ? raw.results : []).filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && typeof (row as Record<string, unknown>)["unique_id"] === "string" && !!(row as Record<string, unknown>)["unique_id"],
  )
  return {
    found: true,
    invocationId: invocation,
    command: artifact.command,
    elapsedSec: num(raw.elapsed_time),
    completedAt: new Date(artifact.mtimeMs).toISOString(),
    results: artifact.results.map((node, at) => ({
      uniqueId: node.uniqueId,
      name: displayName(node.uniqueId, node.name),
      status: node.status,
      executionTimeSec: rows[at]?.["unique_id"] === node.uniqueId ? num(rows[at]?.["execution_time"]) : null,
      message: cut(node.message),
    })),
  }
}

export const DbtRunResultsTool = Tool.define("dbt_run_results", {
  description:
    "Read the last dbt run of a project from its target/run_results.json: the invocation id, the dbt command, the elapsed seconds, when it finished, and one row per node with its status, execution seconds and message. Read-only; runs nothing. A compile or parse writes success rows without building anything, so look at `command`.",
  parameters: z.object({
    project_dir: z
      .string()
      .optional()
      .describe("The dbt project folder (default: the project the session's directory is in)"),
  }),
  async execute(args) {
    const root = args.project_dir ?? (await defaultRoot())
    const view = await readRunView(root)
    if (!view.found) {
      return {
        title: "dbt run results: none",
        metadata: { ...view },
        output: `No run_results.json under ${root}: no dbt command has written one there yet.`,
      }
    }
    const failed = view.results.filter((row) => !["success", "pass", "warn"].includes(row.status))
    return {
      title: `dbt ${view.command ?? "run"}: ${view.results.length - failed.length}/${view.results.length} ok`,
      metadata: { ...view },
      output: [
        `dbt ${view.command ?? "(unknown command)"} · invocation ${view.invocationId ?? "unknown"} · ${view.elapsedSec ?? "?"}s · ${view.completedAt}`,
        ...view.results.map(
          (row) => `${row.status} ${row.name} ${row.executionTimeSec ?? "-"}s${row.message ? ` · ${row.message}` : ""}`,
        ),
      ].join("\n"),
    }
  },
})

async function defaultRoot(): Promise<string> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const base = projectRoot()
  return findProjectRoot(base) ?? base
}

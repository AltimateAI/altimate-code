// altimate_change - new file
//
// Reports a headless `run` to the workspace it is linked to, so the backend can count it against
// the plan's monthly runs. Interactive sessions never report. A backend that does not serve the
// endpoint yet, or is unreachable, never blocks the run; only a runs-limit refusal does.
import { randomUUID } from "crypto"
import { Log } from "@/util/log"
import { PlanLimitError, WorkspaceApi } from "./api-client"
import { resolveBinding } from "./state"

const log = Log.create({ service: "workspace-run-report" })

export type RunKind = "headless" | "ci" | "scheduled"

/** Every `run` is a non-interactive job. GitHub's own `schedule` trigger marks a scheduled one, any
 * other CI environment a CI check, and everything else a headless run. */
export function detectRunKind(env: Record<string, string | undefined> = process.env): RunKind {
  if (env["GITHUB_EVENT_NAME"] === "schedule") return "scheduled"
  const ci = env["CI"]?.trim()
  if (ci && ci !== "0" && ci.toLowerCase() !== "false") return "ci"
  return "headless"
}

let runId: string | undefined

/** One id for the whole process, so reporting the same run twice counts it once. */
export function clientRunId(): string {
  return (runId ??= randomUUID())
}

export function resetClientRunId() {
  runId = undefined
}

export type RunReportDeps = {
  kind: RunKind
  directory: string
  lookup: (directory: string) => Promise<{ datamateId: number } | null>
  report: typeof WorkspaceApi.reportRun
}

export type RunReportResult = { status: "skipped" | "reported" | "ignored" } | { status: "blocked"; error: PlanLimitError }

export async function reportHeadlessRun(deps?: Partial<RunReportDeps>): Promise<RunReportResult> {
  const kind = deps?.kind ?? detectRunKind()
  const directory = deps?.directory ?? process.cwd()
  const lookup = deps?.lookup ?? resolveBinding
  const report = deps?.report ?? WorkspaceApi.reportRun
  try {
    const binding = await lookup(directory)
    if (!binding) return { status: "skipped" }
    await report({ client_run_id: clientRunId(), kind, datamate_id: binding.datamateId })
    return { status: "reported" }
  } catch (err) {
    if (err instanceof PlanLimitError && err.limitKey === "runs") return { status: "blocked", error: err }
    log.debug("run report skipped", { err: String(err) })
    return { status: "ignored" }
  }
}

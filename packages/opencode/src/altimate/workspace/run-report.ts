// altimate_change - new file
//
// Reports a headless `run` to the workspace it is linked to, so the backend can count it against
// the plan's monthly runs. Interactive sessions never report. A backend that does not serve the
// endpoint yet, or is unreachable, never blocks the run; only a runs-limit refusal does.
import { randomUUID } from "crypto"
import { Log } from "@/util/log"
import { PlanLimitError, WorkspaceApi } from "./api-client"
import { resolveProjectIdentifier } from "./detect"

const log = Log.create({ service: "workspace-run-report" })

export type RunKind = "headless" | "ci" | "scheduled"

const TRUTHY = /^(1|true|yes)$/i

export function detectRunKind(
  env: Record<string, string | undefined> = process.env,
  tty: { stdin?: boolean; stdout?: boolean } = { stdin: process.stdin?.isTTY, stdout: process.stdout?.isTTY },
): RunKind | undefined {
  if (env["ALTIMATE_RUN_KIND"]?.trim().toLowerCase() === "scheduled" || TRUTHY.test(env["ALTIMATE_SCHEDULED_RUN"] ?? ""))
    return "scheduled"
  const ci = env["CI"]?.trim()
  if (ci && ci !== "0" && ci.toLowerCase() !== "false") return "ci"
  if (!tty.stdin || !tty.stdout) return "headless"
  return undefined
}

let runId: string | undefined

/** One id for the whole process, so a retry of the report cannot count the run twice. */
export function clientRunId(): string {
  return (runId ??= randomUUID())
}

export function resetClientRunId() {
  runId = undefined
}

export type RunReportDeps = {
  kind: RunKind | undefined
  directory: string
  lookup: typeof WorkspaceApi.getBindingForProject
  report: typeof WorkspaceApi.reportRun
}

export type RunReportResult = { status: "skipped" | "reported" | "ignored" } | { status: "blocked"; error: PlanLimitError }

export async function reportHeadlessRun(deps?: Partial<RunReportDeps>): Promise<RunReportResult> {
  const kind = deps && "kind" in deps ? deps.kind : detectRunKind()
  if (!kind) return { status: "skipped" }
  const directory = deps?.directory ?? process.cwd()
  const lookup = deps?.lookup ?? WorkspaceApi.getBindingForProject
  const report = deps?.report ?? WorkspaceApi.reportRun
  try {
    const binding = await lookup(resolveProjectIdentifier(directory))
    if (!binding) return { status: "skipped" }
    const datamateId = binding.datamate?.id
    await report({
      client_run_id: clientRunId(),
      kind,
      ...(typeof datamateId === "number" ? { datamate_id: datamateId } : {}),
    })
    return { status: "reported" }
  } catch (err) {
    if (err instanceof PlanLimitError && err.limitKey === "runs") return { status: "blocked", error: err }
    log.debug("run report skipped", { err: String(err) })
    return { status: "ignored" }
  }
}

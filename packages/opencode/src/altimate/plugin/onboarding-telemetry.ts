// altimate_change start — activation-funnel telemetry, as a plugin.
//
// The three activation events are DERIVED. The activation menu is not UI: it is text the model
// writes from src/command/template/onboard-connect.txt, and the user picks a job by replying in
// free text. Nothing in the codebase observes either moment. What is deterministic is which
// command started the session and which tool ran next, so that is what this infers from — and
// the events are documented as lower bounds rather than exact counts.
//
// Implemented as a plugin rather than as edits inside session/prompt.ts because the hooks
// already exist (`command.execute.before`, `tool.execute.after`) and carry everything needed.
// This keeps the inference logic in one fork-owned file instead of scattering it across the
// session loop.
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as OnboardingTelemetry from "../telemetry/onboarding"

const ONBOARD_CONNECT = "onboard-connect"

/** Tool/skill → the spec's activation job enum. */
type ActivationJob = "sample_duck_db" | "breaks_downstream" | "sql_review" | "cost" | "something_else"

const JOB_BY_TOOL: Record<string, ActivationJob> = {
  sample_setup: "sample_duck_db",
}

const JOB_BY_SKILL: Record<string, ActivationJob> = {
  "dbt-analyze": "breaks_downstream",
  "sql-review": "sql_review",
  "cost-report": "cost",
}

/**
 * Which activation job, if any, a tool call represents. Skills arrive as the generic `skill`
 * tool with the skill name in `args.name`, so both shapes have to be checked.
 *
 * Returns undefined for the many tools that are not jobs (reads, writes, project_scan itself).
 * Note that `something_else` — the "just let me chat" branch — has no tool signature at all and
 * therefore can never be detected here; that branch is systematically missing from these counts.
 */
function jobForTool(tool: string, args: unknown): ActivationJob | undefined {
  if (tool === "skill") {
    const name = (args as { name?: unknown } | undefined)?.name
    if (typeof name === "string") return JOB_BY_SKILL[name]
    return undefined
  }
  return JOB_BY_TOOL[tool]
}

/**
 * Total warehouse connections a project_scan found, from its `metadata.connections` breakdown
 * (`{existing, new_dbt, new_docker, new_env}` — there is no pre-summed total). All four count:
 * a user whose only warehouse was discovered from a dbt profile, a docker compose file, or env
 * vars still has a warehouse, and reporting `no_data` for them would send them down the
 * sample-project branch of the activation menu.
 */
function countScanConnections(metadata: unknown): number {
  const connections = (metadata as { connections?: Record<string, unknown> } | undefined)?.connections
  if (!connections) return 0
  return ["existing", "new_dbt", "new_docker", "new_env"].reduce((total, key) => {
    const value = connections[key]
    return total + (typeof value === "number" ? value : 0)
  }, 0)
}

/** A tool result is a real completion only if the tool did not report its own failure. */
function succeeded(output: { metadata?: unknown }): boolean {
  const success = (output.metadata as { success?: unknown } | undefined)?.success
  // Most tools report no `success` field at all; absence means "did not fail".
  return success !== false
}

export async function OnboardingTelemetryPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "command.execute.before": async (input) => {
      // Any slash command means the next user message was not typed by the user — needed so
      // `first_prompt_sent` measures a real first prompt rather than the scan gate's hidden
      // `/onboard-connect` submission.
      OnboardingTelemetry.noteCommandSubmission(input.sessionID)

      if (input.command !== ONBOARD_CONNECT) return
      OnboardingTelemetry.markOnboardingSession(input.sessionID)

      // `skip` renders the menu immediately, with no scan to wait for, so the variant is known
      // now. The `scan` branch cannot be resolved here — the menu follows the scan, and the
      // variant depends on what the scan finds — so it is emitted from the scan result below.
      if (input.arguments?.trim() === "skip" && OnboardingTelemetry.claimActivationMenu(input.sessionID)) {
        void OnboardingTelemetry.emit({ type: "activation_menu_shown", variant: "no_data" })
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!OnboardingTelemetry.isOnboardingSession(input.sessionID)) return

      // The scan branch: the menu is rendered right after project_scan returns, and the variant
      // is whatever the scan found. This is the closest deterministic proxy for the menu
      // actually being shown — closer than the command dispatch, which happens before the agent
      // has done anything and would over-count sessions that error out first.
      if (input.tool === "project_scan" && OnboardingTelemetry.claimActivationMenu(input.sessionID)) {
        void OnboardingTelemetry.emit({
          type: "activation_menu_shown",
          variant: countScanConnections(output.metadata) > 0 ? "warehouse" : "no_data",
        })
        return
      }

      const job = jobForTool(input.tool, input.args)
      if (!job) return

      // Selection is inferred from the job starting, so both events land on completion of the
      // first job-shaped tool call. A job that starts and then fails still counts as selected.
      if (OnboardingTelemetry.claimActivationJobSelected(input.sessionID)) {
        void OnboardingTelemetry.emit({ type: "activation_job_selected", job })
      }
      if (succeeded(output) && OnboardingTelemetry.claimFirstJobCompleted(input.sessionID)) {
        void OnboardingTelemetry.emit({ type: "first_job_completed", job })
      }
    },
  }
}
// altimate_change end

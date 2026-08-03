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

/**
 * Whether a completed tool call is evidence the JOB finished, not merely that a tool returned.
 *
 * This distinction is the whole reason `first_job_completed` is narrower than
 * `activation_job_selected`. `sample_setup` genuinely does the work and reports `metadata.success`.
 * The `skill` tool does not: it loads an instruction bundle and returns, after which the agent
 * does the actual analysis with other tools. Treating a successful skill load as job completion
 * would report "downstream impact analysis complete" the moment the instructions were read.
 *
 * There is no reliable signal for when a skill-driven job finishes, so those jobs are absent from
 * `first_job_completed` rather than wrong in it.
 */
function isJobCompletion(tool: string, output: { metadata?: unknown }): boolean {
  if (tool !== "sample_setup") return false
  // Require an explicit true. `!== false` counted missing or malformed metadata as success, so a
  // tool that returned nothing usable was recorded as a completed activation job.
  return (output.metadata as { success?: unknown } | undefined)?.success === true
}

export async function OnboardingTelemetryPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "command.execute.before": async (input) => {
      // Mark the session BEFORE flagging the submission: noteCommandSubmission only touches
      // sessions already tracked (so ordinary slash commands cannot churn the capped map), and
      // /onboard-connect is the command that creates the record in the first place.
      if (input.command === ONBOARD_CONNECT) OnboardingTelemetry.markOnboardingSession(input.sessionID)

      // Any slash command means the next user message was not typed by the user — needed so
      // `first_prompt_sent` measures a real first prompt rather than the scan gate's hidden
      // `/onboard-connect` submission.
      OnboardingTelemetry.noteCommandSubmission(input.sessionID)

      if (input.command !== ONBOARD_CONNECT) return

      // `skip` renders the menu immediately, with no scan to wait for, so the variant is known
      // now. The `scan` branch cannot be resolved here — the menu follows the scan, and the
      // variant depends on what the scan finds — so it is emitted from the scan result below.
      if (input.arguments?.trim() === "skip" && OnboardingTelemetry.claimActivationMenu(input.sessionID)) {
        void OnboardingTelemetry.emit({ type: "activation_menu_shown", variant: "no_data" }, input.sessionID)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!OnboardingTelemetry.isOnboardingSession(input.sessionID)) return
      // Selection lands on the first job-shaped tool call, and it is claimed HERE rather than in
      // tool.execute.after because the docs promise that a job which started and then failed
      // still counts as selected — the user did choose it. Claiming it after the tool returned
      // dropped exactly those cases (skill lookup, permission denial, execution error), which are
      // the ones a funnel most needs to see. Completion detection stays in .after.
      const job = jobForTool(input.tool, output.args)
      if (!job) return
      if (OnboardingTelemetry.claimActivationJobSelected(input.sessionID, job)) {
        void OnboardingTelemetry.emit({ type: "activation_job_selected", job }, input.sessionID)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!OnboardingTelemetry.isOnboardingSession(input.sessionID)) return

      // The scan branch: the menu is rendered right after project_scan returns, and the variant
      // is whatever the scan found. This is the closest deterministic proxy for the menu
      // actually being shown — closer than the command dispatch, which happens before the agent
      // has done anything and would over-count sessions that error out first.
      if (input.tool === "project_scan" && OnboardingTelemetry.claimActivationMenu(input.sessionID)) {
        void OnboardingTelemetry.emit(
          {
            type: "activation_menu_shown",
            // `no_data` tracks the template's own menu variant, which keys on whether a warehouse
            // connection exists. A dbt project with no warehouse gets the no-data menu too.
            variant: countScanConnections(output.metadata) > 0 ? "warehouse" : "no_data",
          },
          input.sessionID,
        )
        return
      }

      const job = jobForTool(input.tool, input.args)
      if (!job) return

      // Only complete the job that was actually selected. Skill-driven jobs stay without a
      // completion event, as the docs already state.
      if (
        isJobCompletion(input.tool, output) &&
        OnboardingTelemetry.isSelectedJob(input.sessionID, job) &&
        OnboardingTelemetry.claimFirstJobCompleted(input.sessionID)
      ) {
        void OnboardingTelemetry.emit({ type: "first_job_completed", job }, input.sessionID)
      }
    },
  }
}
// altimate_change end

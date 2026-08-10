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
// altimate_change start — WorkspaceLink Path B trigger (docs/workspace-plan/CONTRACT.md §3)
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Filesystem } from "@/util/filesystem"
import { detectGit } from "../tools/project-scan"
import { writeScanCache } from "../workspace-link/scan-cache"
import { readBinding } from "../workspace-link/state"
// altimate_change end

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

// altimate_change start — WorkspaceLink Path B trigger (docs/workspace-plan/CONTRACT.md §3).
// Fires from the SAME tool.execute.after hook already used for `environment_scan_completed`
// telemetry below — no new tool-call plumbing. Two things happen, gated on
// Flag.ALTIMATE_WORKSPACE_LINK (when off: neither runs, onboarding is unchanged):
//   (a) write/refresh the `workspace_link_scan_cache` row for the current project, so the
//       Path B dialog and the on-demand `altimate link` command can build a consent payload
//       without re-scanning;
//   (b) publish TuiEvent.WorkspaceLinkOffer so the TUI can open the deterministic native Y/N
//       dialog — reusing the exact same server->TUI event-bridge mechanism the pre-existing
//       tui.toast.show/tui.command.execute events already use (see server/routes/tui.ts's
//       `publishTui` helper, mirrored here since this is a plugin, not an httpapi handler).
//
// `output.metadata` (the project_scan tool's return shape) omits git remote/branch — DISCOVERY.md
// §2 flags this as a known gap in the tool's own metadata. Rather than re-implement dbt-manifest
// parsing here, this re-runs ONLY the cheap detectGit() detector (already run once inside the
// scan that just completed) to recover the remote/branch for the cache row; adapter/source_count/
// test_count stay null for the same reason detect.ts's buildProjectHint leaves them null.
function projectScanMetadataToCache(metadata: unknown) {
  const dbt = (metadata as { dbt?: { name?: string; modelCount?: number } } | undefined)?.dbt
  const connections = (metadata as { connections?: Record<string, number> } | undefined)?.connections
  const hasWarehouse = connections
    ? (["existing", "new_dbt", "new_docker", "new_env"] as const).some((key) => (connections[key] ?? 0) > 0)
    : false
  return { name: dbt?.name ?? null, modelCount: dbt?.modelCount ?? null, hasWarehouse }
}

/** checkpoint 8i: a directory already bound (via THIS path's own approval, checkpoint 8h's
 * poll-handler fix, or the launch-time resolve.ts flow for an already-onboarded user) must never
 * be re-offered — a re-scan mid-session should refresh the cache (the comment at this function's
 * call site is about THAT, not about re-offering a project that already has a real binding). Keyed
 * on the same resolved directory `resolve.ts` uses, via `readBinding` — the one shared source of
 * truth for "is this directory linked" regardless of which of the two consent flows created it. */
export async function offerWorkspaceLink(directory: string, projectId: string, metadata: unknown) {
  if (await readBinding(Filesystem.resolve(directory))) return
  const git = await detectGit()
  const { name, modelCount, hasWarehouse } = projectScanMetadataToCache(metadata)
  const gitRemote = git.isRepo ? git.remoteUrl ?? null : null
  const gitBranch = git.isRepo ? git.branch ?? null : null

  writeScanCache(projectId, {
    // altimate_change — checkpoint 8k bug fix: `name` was computed right above (from the scan's
    // own dbt detection) and used for the dialog's displayed summary below, but never actually
    // reached the cache — the ACTUAL createDevice call later reads from this cache
    // (handlers/workspace-link.ts's resolveHint), not from this event payload, so the workspace
    // that got created used whatever resolveHint's cached branch fell back to (usually nothing),
    // while the consent card the user saw showed the real name. Two surfaces disagreeing about
    // the same staged data — exactly the CONTRACT.md §2 "consent displayed == payload persisted"
    // invariant this was quietly violating.
    name,
    adapter: null,
    modelCount,
    sourceCount: null,
    testCount: null,
    gitRemote,
    gitBranch,
    hasWarehouse,
  })

  await AppRuntime.runPromise(
    EventV2Bridge.Service.use((events) =>
      events.publish(TuiEvent.WorkspaceLinkOffer, {
        // altimate_change — consent-card parity with BRIEF.md's itemized block (project first).
        name,
        adapter: null,
        gitRemote,
        modelCount,
        hasWarehouse,
      }),
    ),
  )
}
// altimate_change end

export async function OnboardingTelemetryPlugin(pluginInput: PluginInput): Promise<Hooks> {
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

      // altimate_change — WorkspaceLink Path B trigger: runs on every project_scan completion in
      // an onboarding session, independent of the claimActivationMenu latch below (a re-scan
      // should refresh the cache and re-offer, not silently no-op the second time).
      if (input.tool === "project_scan" && Flag.ALTIMATE_WORKSPACE_LINK) {
        void offerWorkspaceLink(pluginInput.directory, pluginInput.project.id, output.metadata).catch((err) => {
          console.error("[altimate] workspace-link scan offer failed:", err instanceof Error ? err.message : err)
        })
      }

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

// altimate_change — checkpoint 8d. The launch-time --workspace resolution + drift check.
// Called once from cli/cmd/tui.ts, on the main thread, before the TUI worker starts — every
// prompt here is native @clack/prompts (via cli/effect/prompt.ts), never LLM-generated text,
// same rule CONTRACT.md already applies to Path B's own consent dialog. Never runs more than
// once per process, so "continue without a workspace" being remembered "for the session only"
// falls out for free — there is no second call in the same session to remember it against.
//
// Same-directory-only for v1 (RETURN-LEG.md decision 4): a workspace name is only ever resolved
// against THIS directory's own binding, never a backend-wide name search. An unresolvable name
// is an honest, printed error — never a silent fallback to some other workspace, never a fuzzy/
// partial match.
import { Effect, Option } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { UI } from "@/cli/ui"
import * as Prompt from "@/cli/effect/prompt"
import { Auth } from "@/auth"
import { AltimateApi } from "@/altimate/api/client"
import { buildProjectHint } from "./detect"
import { readBinding, recordApproved, type WorkspaceLinkBinding } from "./state"
import { runWorkspaceLinkFlow, persistApprovedBinding } from "./flow"
import { setResolvedWorkspace } from "./session-context"
import { WorkspaceBackendApi } from "./workspace-backend-client"
import type { WorkspaceLinkProjectHint } from "./types"

/** Best-effort proxy for "has this user already been through onboarding", checked on the main
 * thread before the worker starts — the TUI's own authoritative signal (connected() /
 * setupComplete() in packages/tui/src/component/altimate-onboarding.tsx) needs the worker's
 * provider sync and genuinely does not exist yet at this point in the launch. Neither check here
 * is perfect (env-var-only API keys, or a config-declared provider with no stored credential,
 * both read as "not onboarded") — the cost of a false negative is one extra prompt on an
 * already-onboarded machine, not a correctness problem on either side of it. Exported for
 * testing; also gates the fix below (checkpoint 8i finding: this prompt was firing before
 * onboarding's own model-selection step, preempting the designed post-scan Path B placement —
 * docs/workspace-plan/CONTRACT.md §3 — whose consent card carries the real scan summary this
 * one can't).
 */
export async function isLikelyOnboarded(): Promise<boolean> {
  if (await AltimateApi.isConfigured().catch(() => false)) return true
  const all = await Auth.all().catch(() => ({}) as Record<string, unknown>)
  return Object.keys(all).length > 0
}

export function nameMatches(name: string, binding: WorkspaceLinkBinding): boolean {
  const needle = name.trim().toLowerCase()
  return binding.workspaceName.toLowerCase() === needle || binding.workspaceSlug.toLowerCase() === needle
}

/** Drift is decided on (remote, dbt project name) TOGETHER, never remote alone (a monorepo can
 * have several dbt projects sharing one git remote — a remote-only check would miss a real
 * project swap within the same repo). A detector coming back null/undefined is "no signal", not
 * "drift" — we only flag drift when we have a POSITIVE detected value that disagrees with what
 * was stored. Branch is never part of this comparison at all — branch switches are not drift. */
export function hasDrifted(hint: WorkspaceLinkProjectHint, binding: WorkspaceLinkBinding): boolean {
  const remoteDrift = hint.remote != null && hint.remote !== binding.detectedRemote
  const nameDrift = hint.name != null && hint.name !== binding.detectedProjectName
  return remoteDrift || nameDrift
}

async function promptUnbound(hint: WorkspaceLinkProjectHint): Promise<"create" | "link" | "skip"> {
  const choice = await Effect.runPromise(
    Prompt.select<"create" | "link" | "skip">({
      message: `Detected a dbt project ("${hint.name}") — this directory isn't linked to a workspace yet.`,
      options: [
        { value: "create", label: "Create a new workspace" },
        { value: "link", label: "Link to an existing workspace" },
        { value: "skip", label: "Continue without a workspace" },
      ],
      initialValue: "create",
    }),
  )
  return Option.getOrElse(choice, () => "skip" as const)
}

async function promptDrift(binding: WorkspaceLinkBinding, hint: WorkspaceLinkProjectHint): Promise<"keep" | "create" | "skip"> {
  const was = binding.detectedRemote ?? binding.detectedProjectName ?? "(nothing detected at link time)"
  const now = hint.remote ?? hint.name ?? "(nothing detected now)"
  const choice = await Effect.runPromise(
    Prompt.select<"keep" | "create" | "skip">({
      message:
        `This directory's project looks different from workspace "${binding.workspaceName}"'s linked details ` +
        `(was: ${was}; now: ${now}).`,
      options: [
        { value: "keep", label: `Keep "${binding.workspaceName}" and update its details` },
        { value: "create", label: "Create a new workspace for this project" },
        { value: "skip", label: "Continue without a workspace this time" },
      ],
      initialValue: "keep",
    }),
  )
  return Option.getOrElse(choice, () => "skip" as const)
}

async function createOrLink(directory: string, hint: WorkspaceLinkProjectHint): Promise<void> {
  const outcome = await Effect.runPromise(runWorkspaceLinkFlow(hint))
  if (!outcome) {
    UI.println("Nothing was shared — no workspace was created.")
    return
  }
  const { linkId, result } = outcome
  if (result.status !== "approved") return // declined/expired — runWorkspaceLinkFlow already printed the outcome
  await persistApprovedBinding(directory, hint, linkId, result)
  setResolvedWorkspace({ workspaceId: result.workspace.id, token: result.workspace.token })
  UI.println(`Attached to workspace ${result.workspace.name}.`)
}

export async function resolveWorkspaceForLaunch(directory: string, explicitName: string | undefined): Promise<void> {
  if (!Flag.ALTIMATE_WORKSPACE_LINK) return

  const binding = await readBinding(directory)

  if (explicitName !== undefined) {
    // Explicit flag always wins — it suppresses every interactive prompt below (the user
    // already told us what they want, so there is nothing left to ask). It resolves ONLY
    // against this directory's own binding (same-directory-only, decision 4) — there is no
    // backend-wide name search to fall back to.
    if (!binding) {
      UI.error(`No workspace is linked in this directory. Run \`altimate link\` first, or drop --workspace to continue without one.`)
      return
    }
    if (!nameMatches(explicitName, binding)) {
      UI.println(
        `Note: --workspace ${explicitName} was requested, but this directory is linked to "${binding.workspaceName}" — attaching to "${binding.workspaceName}" since that's what's linked here.`,
      )
    }
    setResolvedWorkspace({ workspaceId: binding.workspaceId, token: binding.token })
    UI.println(`Attached to workspace ${binding.workspaceName}.`)
    return
  }

  const hint = await buildProjectHint(directory)

  if (!binding) {
    if (!hint.name) return // nothing detected, nothing to ask about — stay silent
    // First-run onboarding hasn't reached the post-scan Path B dialog yet — defer to it rather
    // than showing this cheaper, detect.ts-only consent card (adapter/models always "(unknown)"
    // here) first. Already-onboarded users hitting an unbound project are unaffected: there is
    // no post-scan dialog for them (it only fires inside an onboarding session — see
    // onboarding-telemetry.ts's isOnboardingSession gate), so this prompt is their only offer.
    if (!(await isLikelyOnboarded())) return
    const choice = await promptUnbound(hint)
    if (choice === "skip") return
    // "link to existing" and "create" both run the same device flow today — the /link page
    // itself has no "attach to an existing workspace" choice on its consent card yet
    // (approveWithNewWorkspace always creates new); building that is a later checkpoint's job,
    // not this one's. Tracked as a known gap, not silently glossed over.
    await createOrLink(directory, hint)
    return
  }

  if (!hasDrifted(hint, binding)) {
    setResolvedWorkspace({ workspaceId: binding.workspaceId, token: binding.token })
    UI.println(`Attached to workspace ${binding.workspaceName}.`)
    return
  }

  const choice = await promptDrift(binding, hint)
  if (choice === "skip") return // binding on disk is left exactly as-is — never re-bind silently
  if (choice === "create") {
    await createOrLink(directory, hint) // overwrites this directory's binding with a fresh one
    return
  }

  // "keep and update": the binding's detected fields move to match reality, and the server-side
  // workspace record's repo_remote is patched too, so the Overview tab agrees with what's
  // actually on disk. The PATCH is best-effort — a failed network call must never block launch,
  // and the local binding update (what actually matters for the NEXT launch's drift check)
  // happens either way.
  await recordApproved(directory, {
    linkId: binding.linkId,
    workspaceId: binding.workspaceId,
    workspaceName: binding.workspaceName,
    workspaceSlug: binding.workspaceSlug,
    manageUrl: binding.manageUrl,
    approvedBy: binding.approvedBy,
    linkedAt: binding.linkedAt,
    token: binding.token,
    detectedRemote: hint.remote ?? binding.detectedRemote,
    detectedProjectName: hint.name ?? binding.detectedProjectName,
  }).catch(() => {})
  await WorkspaceBackendApi.patchWorkspaceRemote(binding.workspaceId, binding.token, hint.remote ?? binding.detectedRemote).catch((err) => {
    UI.println(`Note: updated the local binding, but could not update the workspace's remote on the backend: ${err instanceof Error ? err.message : String(err)}`)
  })
  setResolvedWorkspace({ workspaceId: binding.workspaceId, token: binding.token })
  UI.println(`Updated workspace "${binding.workspaceName}" to reflect the current project details.`)
}

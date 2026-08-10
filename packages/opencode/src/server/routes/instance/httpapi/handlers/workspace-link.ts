// altimate_change — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §3, Path B).
// See groups/workspace-link.ts for why this route group exists at all.
import * as InstanceState from "@/effect/instance-state"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { buildProjectHint } from "@/altimate/workspace-link/detect"
import {
  WorkspaceLinkApi as WorkspaceLinkClient,
  WorkspaceLinkNotConfiguredError,
  WorkspaceLinkRequestError,
} from "@/altimate/workspace-link/api-client"
import { persistApprovedBinding } from "@/altimate/workspace-link/flow"
import { readFreshScanCache } from "@/altimate/workspace-link/scan-cache"
import type { WorkspaceLinkPollResponse, WorkspaceLinkProjectHint } from "@/altimate/workspace-link/types"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiWorkspaceLinkError, type WorkspaceLinkPollPayload } from "../groups/workspace-link"

interface HintableInstance {
  directory: string
  project: { id: string; name?: string | null }
}

/** Shared between createDevice (needs the hint to send) and persistIfApproved below (needs it
 * to record what was detected, mirroring resolve.ts's own detectedRemote/detectedProjectName —
 * the drift check's stable reference point). Prefers the scan cache (fast, no subprocess
 * spawns) when fresh; otherwise falls back to the same cheap non-LLM detectors Path A's
 * hint-building uses. */
async function resolveHint(instance: HintableInstance): Promise<WorkspaceLinkProjectHint> {
  const cached = readFreshScanCache(instance.project.id)
  if (cached) {
    // altimate_change — checkpoint 8k bug fix: this used to read only instance.project.name,
    // which is usually unset — the scan's own detected name (onboarding-telemetry.ts's
    // offerWorkspaceLink, now cached) takes priority, matching the non-cached branch below.
    return {
      name: cached.name ?? instance.project.name ?? null,
      remote: cached.gitRemote,
      adapter: cached.adapter,
      model_count: cached.modelCount,
      source_count: cached.sourceCount,
      test_count: cached.testCount,
    }
  }
  const detected = await buildProjectHint(instance.directory)
  return { ...detected, name: detected.name ?? instance.project.name ?? null }
}

/** checkpoint 8i: the wire response to the TUI (WorkspaceLinkPollResult in
 * groups/workspace-link.ts) is schema-stripped of `workspace.token` — dialog-workspace-link.tsx
 * genuinely cannot persist a working binding itself. This is the only place with both the real
 * token AND the resolved directory in scope, so it does the persisting that resolve.ts's own
 * createOrLink does for the launch-time flow — same underlying persistApprovedBinding, same
 * directory key, so EITHER consent flow having bound a directory is equally visible to the
 * other (onboarding-telemetry.ts's offerWorkspaceLink, and resolve.ts's own `!binding` check,
 * both read through readBinding). A plain async function, not an Effect generator, so it's
 * testable without the httpapi/InstanceState harness. */
export async function persistIfApproved(instance: HintableInstance, linkId: string, result: WorkspaceLinkPollResponse): Promise<void> {
  if (result.status !== "approved") return
  const hint = await resolveHint(instance)
  await persistApprovedBinding(instance.directory, hint, linkId, result)
}

export const workspaceLinkHandlers = HttpApiBuilder.group(InstanceHttpApi, "workspaceLink", (handlers) =>
  Effect.gen(function* () {
    const createDevice = Effect.fn("WorkspaceLinkHttpApi.createDevice")(function* () {
      const instance = yield* InstanceState.context
      const hint = yield* Effect.promise(() => resolveHint(instance))
      return yield* Effect.tryPromise({
        try: () =>
          WorkspaceLinkClient.createDeviceLink({
            client: "altimate-code",
            client_version: InstallationVersion,
            project: hint,
          }),
        catch: (err) => toApiError(err),
      })
    })

    const poll = Effect.fn("WorkspaceLinkHttpApi.poll")(function* (ctx: { payload: typeof WorkspaceLinkPollPayload.Type }) {
      const instance = yield* InstanceState.context
      const result = yield* Effect.tryPromise({
        try: () => WorkspaceLinkClient.poll(ctx.payload.link_id, ctx.payload.poll_token),
        catch: (err) => toApiError(err),
      })
      yield* Effect.promise(() => persistIfApproved(instance, ctx.payload.link_id, result))
      return result
    })

    return handlers.handle("createDevice", createDevice).handle("poll", poll)
  }),
)

function toApiError(err: unknown): ApiWorkspaceLinkError {
  if (err instanceof WorkspaceLinkNotConfiguredError) {
    return new ApiWorkspaceLinkError({ name: "WorkspaceLinkError", data: { message: err.message } })
  }
  if (err instanceof WorkspaceLinkRequestError) {
    return new ApiWorkspaceLinkError({ name: "WorkspaceLinkError", data: { message: err.message } })
  }
  return new ApiWorkspaceLinkError({
    name: "WorkspaceLinkError",
    data: { message: err instanceof Error ? err.message : "WorkspaceLink request failed" },
  })
}

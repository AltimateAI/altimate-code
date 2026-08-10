// altimate_change — WorkspaceLink feature. The reusable device-flow sequence (consent block →
// create → poll), extracted from cli/cmd/link.ts in checkpoint 8d so the launch-time resolver
// (resolve.ts, tui.ts's --workspace handling) can run the exact same flow `altimate link` uses
// rather than a second, drifting implementation. Native @clack/prompts only — never
// LLM-generated text, same rule CONTRACT.md applies to Path B's own consent dialog.
import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import open from "open"
import { UI } from "@/cli/ui"
import * as Prompt from "@/cli/effect/prompt"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { WorkspaceLinkApi, WorkspaceLinkNotConfiguredError } from "./api-client"
import { pollUntilResolved } from "./poll-loop"
import { recordApproved, type WorkspaceLinkBinding } from "./state"
import type { WorkspaceLinkPollResponse, WorkspaceLinkProjectHint } from "./types"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))
const println = (msg: string) => Effect.sync(() => UI.println(msg))

/** Stops at the raw poll result — declined/approved/expired MESSAGING and any local
 * persistence (recordApproved) is each caller's own job, since that differs slightly per
 * entry point (`altimate link`'s own "Next: altimate code --workspace <slug>" line doesn't
 * make sense inside a launch that's already running WITH --workspace resolution baked in).
 * Returns `undefined` if the user declined at the confirm step itself, before any network call
 * (never resolves to a WorkspaceLinkPollResponse in that case — no link was ever created). */
export const runWorkspaceLinkFlow = Effect.fn("WorkspaceLink.run")(function* (hint: WorkspaceLinkProjectHint) {
  yield* Prompt.intro("Link this project to a workspace")

  // Itemized consent block — BRIEF.md §1 / the terminal mock's exact copy. Every value is
  // best-effort (CONTRACT.md ASSUMPTION A5): fields the cheap detectors can't derive
  // (adapter, model/source/test counts) print as "(unknown)" rather than being omitted, so
  // the shape of what's NOT being shared is as visible as what is.
  const show = (value: string | number | null | undefined) => (value === null || value === undefined ? "(unknown)" : String(value))
  yield* println("")
  yield* println("  This will share the following:")
  yield* println(`    project   ${show(hint.name)}`)
  yield* println(`    remote    ${show(hint.remote)}`)
  yield* println(`    adapter   ${show(hint.adapter)}`)
  yield* println(`    models    ${show(hint.model_count)}`)
  yield* println("  Nothing else leaves this machine. No SQL, no data, no credentials.")
  yield* println("")

  // altimate_change — checkpoint 8k: one prompt, not two. This used to ask "Share these
  // details?" then, on a separate later screen, print a code to type into the browser. There is
  // no code anymore — the single confirm below covers both "yes, share this" and "yes, open the
  // browser", since accepting immediately creates the link and opens it.
  const share = yield* Effect.promise(() => prompts.confirm({ message: "Open browser to approve?", initialValue: true }))
  if (prompts.isCancel(share) || !share) {
    return undefined
  }

  // A network failure here is treated the same as a decline: logged once, then `undefined` —
  // never rethrown. It used to rethrow after logging, which (a) printed the SAME failure a
  // second time via whichever caller's own generic catch-all (tui.ts's "workspace resolution
  // failed", link.ts's `Effect.orDie`), and (b) since this is `Effect.promise` (which assumes
  // its promise never rejects), a rethrow here became an Effect defect — a FiberFailure whose
  // string form is a full stack dump, not the clean message computed above. Found via a live
  // repro (checkpoint 8h bug report) with the backend genuinely unreachable. The message itself
  // is already URL-inclusive and actionable (api-client.ts's describeFetchError), so there's
  // nothing left to add here beyond a stable prefix.
  const created = yield* Effect.promise(() =>
    WorkspaceLinkApi.createDeviceLink({
      client: "altimate-code",
      client_version: InstallationVersion,
      project: hint,
    }).catch((err) => {
      prompts.log.error(err instanceof WorkspaceLinkNotConfiguredError ? err.message : `Could not create the workspace link: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }),
  )
  if (!created) return undefined

  yield* println("")
  yield* println("  Opening this link to approve:")
  yield* println("")
  yield* println(`    ${created.verification_uri} (expires in ${Math.round(created.expires_in / 60)} min)`)
  yield* println("")
  yield* openBrowser(created.verification_uri)

  const s = Prompt.spinner()
  yield* s.start("Waiting for approval in the browser...")

  const result: WorkspaceLinkPollResponse = yield* Effect.promise(() =>
    pollUntilResolved({
      linkId: created.link_id,
      pollToken: created.poll_token,
      expiresIn: created.expires_in,
      interval: created.interval,
    }),
  )

  if (result.status === "approved") yield* s.stop(`Approved by ${result.approved_by}`)
  else if (result.status === "declined") yield* s.stop("Nothing was shared — no workspace was created.", 1)
  else yield* s.stop("Link expired before it was approved or declined.", 1)

  return { linkId: created.link_id, result }
})

/** Shared field-mapping between `altimate link`'s own success path and the launch-time
 * resolver's "create"/"link to existing" choices — both persist an identical shape, just from
 * different call sites. */
export function persistApprovedBinding(
  directory: string,
  hint: WorkspaceLinkProjectHint,
  linkId: string,
  result: Extract<WorkspaceLinkPollResponse, { status: "approved" }>,
): Promise<void> {
  const binding: Omit<WorkspaceLinkBinding, "projectId"> = {
    linkId,
    workspaceId: result.workspace.id,
    workspaceName: result.workspace.name,
    workspaceSlug: result.workspace.slug,
    manageUrl: result.workspace.manage_url,
    approvedBy: result.approved_by,
    linkedAt: Date.now(),
    token: result.workspace.token,
    detectedRemote: hint.remote ?? null,
    detectedProjectName: hint.name ?? null,
  }
  return recordApproved(directory, binding).catch(() => {})
}

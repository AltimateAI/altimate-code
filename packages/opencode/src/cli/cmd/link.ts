// altimate_change — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §3, `altimate link`).
//
// DOGFOOD BUILD: ALTIMATE_WORKSPACE_LINK_API_URL must point at a running instance of the real
// dogfood backend (script/workspace-backend-server.ts) — since checkpoint 2c this hits its real
// /link page, not mock-server.ts's old /admin/approve stand-in (mock-server.ts still exists and
// still works for isolated testing, it's just no longer what this command's default demo path
// uses). Happy path only — no retry/backoff polish beyond what poll-loop.ts already does, no
// scan-cache lookup (that nicety is for the TUI dialog, which already has a project id in scope
// from the plugin/session context; this standalone command always uses the cheap detectors
// directly via buildProjectHint).
//
// Modeled closely on account.ts's loginEffect (device-flow shape: intro -> print code/URL ->
// spinner while polling -> outro) and its CLI wiring (effectCmd, instance: false — this command
// doesn't need a loaded project InstanceContext, just process.cwd()). The actual flow (checkpoint
// 8d) now lives in altimate/workspace-link/flow.ts, shared with the launch-time --workspace
// resolver — this command is just that flow's own UI framing + local persistence.
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { Flag } from "@opencode-ai/core/flag/flag"
import { buildProjectHint } from "@/altimate/workspace-link/detect"
import { runWorkspaceLinkFlow, persistApprovedBinding } from "@/altimate/workspace-link/flow"

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const linkEffect = Effect.fn("Cli.link")(function* () {
  if (!Flag.ALTIMATE_WORKSPACE_LINK) {
    return yield* println(
      "`altimate link` is behind the ALTIMATE_WORKSPACE_LINK flag. Set ALTIMATE_WORKSPACE_LINK=1 to use it.",
    )
  }

  const directory = process.cwd()
  const hint = yield* Effect.promise(() => buildProjectHint(directory))
  const outcome = yield* runWorkspaceLinkFlow(hint)

  if (!outcome) {
    yield* println("Nothing was shared — no workspace was created.")
    return
  }
  const { linkId, result } = outcome

  if (result.status === "approved") {
    yield* println(`  Workspace ${result.workspace.name} created and linked to this project`)
    yield* println("")
    yield* println(`  Next: altimate code --workspace ${result.workspace.slug}`)
    yield* println(`  Manage it at ${result.workspace.manage_url}`)
    // checkpoint 8c fix: this call was entirely missing on Path B — altimate.ts's Path A poller
    // already persisted this binding, but this command (the path DOGFOOD.md's own walkthrough
    // actually exercises) never did, so --workspace <name> had nothing local to resolve against
    // on the only path that works end-to-end today. Keyed by `directory` (process.cwd()), same
    // identifier this command already used to build the consent hint above — not a formal
    // Project.ID, since this command deliberately never loads a full instance to get one.
    yield* Effect.promise(() => persistApprovedBinding(directory, hint, linkId, result))
    yield* Prompt.outro("Done")
    return
  }

  // declined/expired: nothing more to do, runWorkspaceLinkFlow already printed the outcome.
})

export const LinkCommand = effectCmd({
  command: "link",
  describe: "Link this project to an Altimate workspace",
  instance: false,
  handler: Effect.fn("Cli.link.handler")(function* () {
    UI.empty()
    yield* Effect.orDie(linkEffect())
  }),
})

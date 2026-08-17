// altimate_change - new file
//
// On-demand "link this project to a workspace" subcommand. User invoked it
// explicitly, so we skip the Create/Link/Skip funnel the post-scan trigger
// uses and jump straight to a picker over the user's workspaces — the
// currently-linked one is marked, and "＋ Create a new workspace" is the
// first row. New workspaces are auto-named from the git repo (or directory
// name for path-only projects) so the user never has to type anything.
//
// Deliberately shares the WorkspaceApi + state + detect modules with the
// TuiPlugin so the two entry points can't drift on request shape, project
// identity, or error handling.
import { cmd } from "./cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import open from "open"
import { AltimateApi } from "@/altimate/api/client"
import {
  WorkspaceApi,
  ConflictError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  PreconditionFailedError,
  type DatamateRef,
  type MatchedIdentifier,
  type ProjectBindingLookup,
  type ProjectIdentifier,
} from "@/altimate/workspace/api-client"
import {
  projectNameFromPath,
  projectNameFromRemote,
  resolveProjectIdentifier,
} from "@/altimate/workspace/detect"
import { recordApprovedBinding } from "@/altimate/workspace/state"

const CREATE_NEW_SENTINEL = "__create_new__"

export const LinkCommand = cmd({
  command: "link",
  describe: "Link this project to an Altimate workspace",
  builder: (yargs) =>
    yargs.option("directory", {
      alias: "d",
      describe: "Project directory (defaults to cwd)",
      type: "string",
      default: process.cwd(),
    }),
  handler: async (args) => {
    if (!(await AltimateApi.isConfigured())) {
      UI.error(
        "Not signed in to Altimate. Run the TUI (altimate-code) and sign in first, then re-run `altimate-code link`.",
      )
      process.exitCode = 1
      return
    }

    const identifier = resolveProjectIdentifier(args.directory)

    prompts.intro("Link this project to a workspace")
    if (identifier.repoRemote) prompts.log.info(`Project remote: ${identifier.repoRemote}`)
    else prompts.log.info(`Project path: ${identifier.projectPath} (no git remote)`)

    // Pre-check for the currently-linked marker + workspace list. Both are
    // fetched up-front so the picker can annotate the current binding.
    // ``preCheckOk = false`` means the pre-check itself failed (network,
    // 5xx) rather than "not linked" — used later to retry a 409 as a rebind
    // instead of surfacing "already linked to X" with no next step. (m10)
    let existing: ProjectBindingLookup | null = null
    let preCheckOk = true
    try {
      existing = await WorkspaceApi.getBindingForProject(identifier)
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        UI.error(err.message)
        process.exitCode = 1
        return
      }
      preCheckOk = false
      prompts.log.warn(
        `Could not reach the workspace service to look up existing bindings (${err instanceof Error ? err.message : String(err)}). Continuing without the currently-linked marker.`,
      )
    }

    const spin = prompts.spinner()
    spin.start("Loading workspaces...")
    let list: DatamateRef[]
    try {
      list = await WorkspaceApi.listDatamates()
    } catch (err) {
      spin.stop("Could not load workspaces.", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
      return
    }
    spin.stop(`Found ${list.length} workspace${list.length === 1 ? "" : "s"}.`)

    const autoName = identifier.repoRemote
      ? projectNameFromRemote(identifier.repoRemote)
      : projectNameFromPath(identifier.projectPath)
    const currentId = existing?.datamate.id
    const currentName = existing?.datamate.name

    const options: Array<{ value: string; label: string; hint?: string }> = [
      {
        value: CREATE_NEW_SENTINEL,
        label: `＋ Create a new workspace "${autoName}"`,
        hint: existing
          ? "Creates a new workspace and repoints this project to it."
          : "Named from this project; rename in the SaaS after.",
      },
      ...list.map((dm) => ({
        value: String(dm.id),
        label: dm.id === currentId ? `● ${dm.name}` : `  ${dm.name}`,
        hint: dm.id === currentId ? "currently linked here" : undefined,
      })),
    ]

    const pick = await prompts.select<string>({
      message: existing
        ? `Currently linked to "${currentName}". Pick a workspace (or create a new one):`
        : "Pick a workspace to link (or create a new one):",
      options,
      initialValue: currentId !== undefined ? String(currentId) : CREATE_NEW_SENTINEL,
    })

    if (prompts.isCancel(pick)) {
      prompts.outro("No changes.")
      return
    }

    if (pick === CREATE_NEW_SENTINEL) {
      await createThenBindOrRebind(identifier, autoName, args.directory, existing)
      return
    }

    const targetId = Number(pick)
    if (targetId === currentId) {
      prompts.outro(`Kept "${currentName}" — nothing changed.`)
      return
    }

    await bindOrRebind(identifier, targetId, existing, preCheckOk, args.directory)
  },
})

/** "＋ Create a new workspace" flow. When the project is already linked, this
 * MUST rebind after create — otherwise the new workspace is a real (billable)
 * SaaS resource the CLI knows nothing about and the project is still bound to
 * the old workspace (M2 in the consensus review). When rebind fails, the
 * error message tells the user the workspace was created and how to recover;
 * we do NOT silently swallow the orphan. */
async function createThenBindOrRebind(
  identifier: ProjectIdentifier,
  name: string,
  directory: string,
  existing: ProjectBindingLookup | null,
): Promise<void> {
  const spin = prompts.spinner()
  spin.start(`Creating workspace "${name}"...`)
  let created: Awaited<ReturnType<typeof WorkspaceApi.createAndBind>>
  try {
    created = await WorkspaceApi.createAndBind({ name, identifier })
  } catch (err) {
    spin.stop("Failed to create workspace.", 1)
    // A 409 from create means someone else's binding on the same
    // remote/path beat us. If the pre-check already knew about it, the user
    // can pick from the list; if the pre-check missed it, this is the
    // authoritative signal — surface it and hint the picker.
    if (err instanceof ConflictError) {
      prompts.log.error(
        `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` to switch to a different workspace.`,
      )
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
    return
  }
  spin.stop(`Workspace "${created.datamate.name}" created.`)

  // If the project was already linked, the new workspace exists but the
  // binding still points at the OLD workspace — rebind so the project is
  // now bound to the freshly-created one. Otherwise createAndBind already
  // wrote the binding as part of the atomic create; we're done.
  if (existing) {
    const rebindSpin = prompts.spinner()
    rebindSpin.start(`Repointing project at "${created.datamate.name}"...`)
    try {
      await rebindByMatchedIdentifier({
        identifier,
        targetDatamateId: created.datamate.id,
        expectedCurrentDatamateId: existing.datamate.id,
        matchedBy: existing.matchedBy,
      })
      rebindSpin.stop(`Project is now linked to "${created.datamate.name}".`)
    } catch (err) {
      rebindSpin.stop("Could not repoint the project.", 1)
      prompts.log.error(
        `Workspace "${created.datamate.name}" was CREATED but could not be linked to this project. ${err instanceof Error ? err.message : String(err)} — re-run \`altimate-code link\` to retry (or delete the workspace in the SaaS).`,
      )
      process.exitCode = 1
      return
    }
  }
  await recordApprovedBinding(directory, {
    datamateId: created.datamate.id,
    datamateName: created.datamate.name,
    repoRemote: created.binding.repo_remote,
    projectPath: created.binding.project_path,
    linkedAt: Date.now(),
  })
  prompts.log.info(`Manage it at: ${created.manage_url}`)
  // Guard against a server that hands back a non-http(s) manage_url — ``open``
  // delegates to the OS handler, so a rogue value could launch an unrelated
  // application. Log a warning and skip the auto-open rather than trusting
  // whatever protocol the URL parses to.
  if (isSafeHttpUrl(created.manage_url)) {
    await open(created.manage_url).catch(() => undefined)
  } else {
    prompts.log.warn(`Skipped auto-open: manage_url is not an http/https URL.`)
  }
  prompts.outro("Done.")
}

/** True when the URL parses and its protocol is exactly ``http:`` or ``https:``.
 * Used before handing a server-supplied URL to ``open()`` (which would otherwise
 * dispatch to whatever OS scheme handler matches the protocol). */
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

async function bindOrRebind(
  identifier: ProjectIdentifier,
  targetDatamateId: number,
  existing: ProjectBindingLookup | null,
  preCheckOk: boolean,
  directory: string,
): Promise<void> {
  const isRebind = existing !== null
  const spin = prompts.spinner()
  spin.start(isRebind ? `Re-linking to workspace...` : `Linking to workspace...`)
  try {
    let res
    if (isRebind) {
      res = await rebindByMatchedIdentifier({
        identifier,
        targetDatamateId,
        expectedCurrentDatamateId: existing.datamate.id,
        matchedBy: existing.matchedBy,
      })
    } else {
      // No known binding OR pre-check failed. Try bindExisting first — if the
      // pre-check missed a real binding, the server will 409, and we retry as
      // rebind when we're allowed to. (m10)
      try {
        res = await WorkspaceApi.bindExisting(targetDatamateId, identifier)
      } catch (err) {
        if (err instanceof ConflictError && !preCheckOk) {
          // Pre-check failed and the server confirms this project IS linked
          // already. Retry as an unconditional rebind — we don't have an
          // ``expected_current_datamate_id`` (pre-check gave us nothing) so
          // this is last-writer-wins. Callers who need optimistic concurrency
          // should re-run once the network is back and the pre-check succeeds.
          spin.stop("Pre-check missed an existing binding — retrying as re-link.", 1)
          const rebindSpin = prompts.spinner()
          rebindSpin.start("Re-linking...")
          try {
            res = identifier.repoRemote
              ? await WorkspaceApi.rebindByRemote({
                  remote: identifier.repoRemote,
                  targetDatamateId,
                })
              : await WorkspaceApi.rebindByPath({
                  projectPath: identifier.projectPath!,
                  targetDatamateId,
                })
            rebindSpin.stop(`Re-linked to "${res.binding.datamate_name}".`)
          } catch (retryErr) {
            rebindSpin.stop("Re-link failed.", 1)
            throw retryErr
          }
        } else {
          throw err
        }
      }
    }
    await recordApprovedBinding(directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    spin.stop(
      isRebind
        ? `Re-linked to "${res.binding.datamate_name}".`
        : `Linked to "${res.binding.datamate_name}".`,
    )
    prompts.outro("Done.")
  } catch (err) {
    spin.stop(isRebind ? `Re-link failed.` : `Link failed.`, 1)
    if (err instanceof ConflictError) {
      prompts.log.error(
        `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` to switch.`,
      )
    } else if (err instanceof PreconditionFailedError) {
      prompts.log.error("Someone else re-linked this project — re-run and try again.")
    } else if (err instanceof NotFoundError) {
      prompts.log.error("No existing binding to re-link. Re-run and pick again.")
    } else if (err instanceof ForbiddenError) {
      prompts.log.error("Only the workspace owner can attach projects to it.")
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

/** Pick the rebind endpoint that matches which identifier the pre-check
 * resolved the binding on — NOT which identifier the current call happens to
 * carry. A repo whose remote was renamed still has a binding under its path;
 * rebindByRemote against the new remote would 404 with no repair path from
 * the CLI. (M3) */
async function rebindByMatchedIdentifier(input: {
  identifier: ProjectIdentifier
  targetDatamateId: number
  expectedCurrentDatamateId: number
  matchedBy: MatchedIdentifier
}) {
  if (input.matchedBy === "remote" && input.identifier.repoRemote) {
    return WorkspaceApi.rebindByRemote({
      remote: input.identifier.repoRemote,
      targetDatamateId: input.targetDatamateId,
      expectedCurrentDatamateId: input.expectedCurrentDatamateId,
    })
  }
  if (input.matchedBy === "path" && input.identifier.projectPath) {
    return WorkspaceApi.rebindByPath({
      projectPath: input.identifier.projectPath,
      targetDatamateId: input.targetDatamateId,
      expectedCurrentDatamateId: input.expectedCurrentDatamateId,
    })
  }
  throw new Error(
    `Cannot rebind — the pre-check matched on ${input.matchedBy} but that field is not present on the current project identifier.`,
  )
}

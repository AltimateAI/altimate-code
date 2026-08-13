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
  type GetBindingResponse,
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
    let existing: GetBindingResponse | null = null
    try {
      existing = await WorkspaceApi.getBindingForProject(identifier)
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        UI.error(err.message)
        process.exitCode = 1
        return
      }
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
        hint: "Named from this project; rename in the SaaS after.",
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
      await createAndBind(identifier, autoName, args.directory)
      return
    }

    const targetId = Number(pick)
    if (targetId === currentId) {
      prompts.outro(`Kept "${currentName}" — nothing changed.`)
      return
    }

    await bindOrRebind(identifier, targetId, currentId, args.directory)
  },
})

async function createAndBind(
  identifier: ProjectIdentifier,
  name: string,
  directory: string,
): Promise<void> {
  const spin = prompts.spinner()
  spin.start(`Creating workspace "${name}"...`)
  try {
    const res = await WorkspaceApi.createAndBind({ name, identifier })
    await recordApprovedBinding(directory, {
      datamateId: res.datamate.id,
      datamateName: res.datamate.name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    spin.stop(`Workspace "${res.datamate.name}" created and linked.`)
    prompts.log.info(`Manage it at: ${res.manage_url}`)
    await open(res.manage_url).catch(() => undefined)
    prompts.outro("Done.")
  } catch (err) {
    spin.stop("Failed to create workspace.", 1)
    if (err instanceof ConflictError) {
      prompts.log.error(
        `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` to switch.`,
      )
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

async function bindOrRebind(
  identifier: ProjectIdentifier,
  targetDatamateId: number,
  currentDatamateId: number | undefined,
  directory: string,
): Promise<void> {
  const isRebind = currentDatamateId !== undefined
  const spin = prompts.spinner()
  spin.start(isRebind ? `Re-linking to workspace...` : `Linking to workspace...`)
  try {
    const res = await (async () => {
      if (isRebind) {
        // Rebind endpoint depends on which identifier is present. Prefer remote
        // (stronger identity — survives directory moves); fall back to path.
        return identifier.repoRemote
          ? WorkspaceApi.rebindByRemote({
              remote: identifier.repoRemote,
              targetDatamateId,
              expectedCurrentDatamateId: currentDatamateId,
            })
          : WorkspaceApi.rebindByPath({
              projectPath: identifier.projectPath!,
              targetDatamateId,
              expectedCurrentDatamateId: currentDatamateId,
            })
      }
      return WorkspaceApi.bindExisting(targetDatamateId, identifier)
    })()
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
        `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}".`,
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

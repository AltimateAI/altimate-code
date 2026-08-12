// altimate_change - new file
//
// On-demand "link this project to a workspace" subcommand. Runs the same three-
// way flow the TuiPlugin (packages/opencode/src/plugin/tui/altimate/workspace.tsx)
// offers post-scan, but outside a TUI session — so a user who skipped the
// post-scan offer (or skipped it 7+ days ago and wants to link now) has a
// path back in.
//
// Deliberately shares the WorkspaceApi + state modules with the plugin so the
// two entry points can't drift on request shape or error handling.
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
} from "@/altimate/workspace/api-client"
import { detectProjectRemote, projectNameFromRemote } from "@/altimate/workspace/detect"
import { recordApprovedBinding } from "@/altimate/workspace/state"

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
    // Bail early if the CLI has no Altimate credentials — there's no place to
    // send them and no gateway to authenticate against.
    if (!(await AltimateApi.isConfigured())) {
      UI.error(
        "Not signed in to Altimate. Run the TUI (altimate-code) and sign in first, then re-run `altimate-code link`.",
      )
      process.exitCode = 1
      return
    }

    const remote = detectProjectRemote(args.directory)
    if (!remote) {
      UI.error(
        `No git remote found in ${args.directory}. A workspace is bound to a project via its git remote — initialize a repo and add a remote first.`,
      )
      process.exitCode = 1
      return
    }

    prompts.intro("Link workspace")
    prompts.log.info(`Project remote: ${remote}`)

    // Server-authoritative pre-check.
    let existing: Awaited<ReturnType<typeof WorkspaceApi.getBindingForRemote>> = null
    try {
      existing = await WorkspaceApi.getBindingForRemote(remote)
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        UI.error(err.message)
        process.exitCode = 1
        return
      }
      prompts.log.warn(
        `Could not reach the workspace service (${err instanceof Error ? err.message : String(err)}). Continuing anyway.`,
      )
    }

    if (existing) {
      const choice = await prompts.select<"attach" | "relink" | "cancel">({
        message: `This project is already linked to workspace "${existing.datamate.name}".`,
        options: [
          { value: "attach", label: "Keep this binding (no changes)" },
          { value: "relink", label: "Re-link to a different workspace" },
          { value: "cancel", label: "Cancel" },
        ],
        initialValue: "attach",
      })
      if (prompts.isCancel(choice) || choice === "cancel" || choice === "attach") {
        prompts.outro(choice === "attach" ? `Kept "${existing.datamate.name}".` : "No changes.")
        return
      }
      await pickAndBind(remote, "relink", existing.datamate.id, args.directory)
      return
    }

    const choice = await prompts.select<"create" | "link" | "cancel">({
      message: "Set up a workspace for this project?",
      options: [
        {
          value: "create",
          label: "Create a new workspace",
          hint: "Opens a browser to configure integrations and knowledge.",
        },
        {
          value: "link",
          label: "Link to an existing workspace",
          hint: "Attach this project to a workspace you already own.",
        },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "create",
    })
    if (prompts.isCancel(choice) || choice === "cancel") {
      prompts.outro("No workspace was linked.")
      return
    }

    if (choice === "create") {
      await createAndBind(remote, args.directory)
      return
    }
    await pickAndBind(remote, "attach", undefined, args.directory)
  },
})

async function createAndBind(remote: string, directory: string): Promise<void> {
  const defaultName = projectNameFromRemote(remote)
  const nameInput = await prompts.text({
    message: "Name this workspace",
    placeholder: defaultName,
    defaultValue: defaultName,
  })
  if (prompts.isCancel(nameInput)) {
    prompts.outro("No workspace was created.")
    return
  }
  const name = String(nameInput).trim() || defaultName

  const spin = prompts.spinner()
  spin.start(`Creating workspace "${name}"...`)
  try {
    const res = await WorkspaceApi.createAndBind({ name, repoRemote: remote })
    await recordApprovedBinding(directory, {
      datamateId: res.datamate.id,
      datamateName: res.datamate.name,
      repoRemote: res.binding.repo_remote,
      linkedAt: Date.now(),
    })
    spin.stop(`Workspace "${res.datamate.name}" created and linked.`)
    prompts.log.info(`Manage it at: ${res.manage_url}`)
    // Best-effort browser open — never blocks. If it fails the user has the
    // URL above to copy manually.
    await open(res.manage_url).catch(() => undefined)
    prompts.outro("Done.")
  } catch (err) {
    spin.stop("Failed to create workspace.", 1)
    if (err instanceof ConflictError) {
      prompts.log.error(
        `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` and pick "Re-link" if you want to move it.`,
      )
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

async function pickAndBind(
  remote: string,
  mode: "attach" | "relink",
  expectedCurrentDatamateId: number | undefined,
  directory: string,
): Promise<void> {
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

  if (list.length === 0) {
    prompts.log.warn(
      "You don't have any workspaces yet. Re-run and pick \"Create a new workspace\" instead.",
    )
    prompts.outro("No workspace to link.")
    return
  }

  const pick = await prompts.select<number | "cancel">({
    message: mode === "attach" ? "Pick a workspace to attach to" : "Pick a workspace to re-link to",
    options: [
      ...list.map((dm) => ({ value: dm.id as number | "cancel", label: dm.name })),
      { value: "cancel" as const, label: "Cancel" },
    ],
  })
  if (prompts.isCancel(pick) || pick === "cancel") {
    prompts.outro("No changes.")
    return
  }

  const target = list.find((dm) => dm.id === pick)!
  const spin2 = prompts.spinner()
  spin2.start(`${mode === "attach" ? "Linking" : "Re-linking"} to "${target.name}"...`)
  try {
    const res =
      mode === "attach"
        ? await WorkspaceApi.bindExisting(pick, remote)
        : await WorkspaceApi.rebindByRemote({
            remote,
            targetDatamateId: pick,
            expectedCurrentDatamateId,
          })
    await recordApprovedBinding(directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      linkedAt: Date.now(),
    })
    spin2.stop(`${mode === "attach" ? "Linked" : "Re-linked"} to "${res.binding.datamate_name}".`)
    prompts.outro("Done.")
  } catch (err) {
    spin2.stop(`${mode === "attach" ? "Link" : "Re-link"} failed.`, 1)
    if (err instanceof ConflictError) {
      prompts.log.error(
        `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` and pick "Re-link".`,
      )
    } else if (err instanceof PreconditionFailedError) {
      prompts.log.error("Someone else re-linked this project — reload and try again.")
    } else if (err instanceof NotFoundError) {
      prompts.log.error("No existing binding to re-link. Try again and pick Create or Link.")
    } else if (err instanceof ForbiddenError) {
      prompts.log.error("Only the workspace owner can attach projects to it.")
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

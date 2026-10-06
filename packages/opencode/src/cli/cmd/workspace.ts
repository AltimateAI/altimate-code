// altimate_change - new file
//
// `altimate-code workspace status|refresh|sync|unlink`: the `/workspace` menu's actions for a shell,
// so a setup script, a devcontainer, CI or another agent can manage a project's workspace without
// the TUI. Thin wrappers over `altimate/workspace/manage.ts` — the same code the menu and the
// `serve` routes run — with plain-text output, `--json` for scripts, and exit codes a caller can
// branch on:
//
//   0  the action ran (status: the project is linked)
//   1  the action failed (service unreachable, credentials unreadable, a write refused)
//   2  a request to change: not signed in, a destructive action without `--yes` and no terminal to ask
//      on, or a `sync` to a link not yet confirmed on this machine (`link --workspace <id>` confirms it)
//   3  the project is not linked to a workspace
import * as prompts from "@clack/prompts"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { stripControlChars } from "./link"
import { AltimateApi } from "@/altimate/api/client"
import * as Manage from "@/altimate/workspace/manage"
import { resolveBindingOutcome, type BindingOutcome, type CachedBinding } from "@/altimate/workspace/state"

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NOT_LINKED: 3 } as const

/** "6m ago" style, for a timestamp in ms; null when unknown. */
export function ago(at: number | null, now = Date.now()): string | null {
  if (at === null) return null
  const ms = Math.max(0, now - at)
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Human-readable lines for `workspace status`. Pure, so the wording is testable. */
export function describeStatus(report: Manage.StatusReport, now = Date.now()): string[] {
  if (!report.binding) {
    return ["This project is not linked to a workspace.", "Link it with `altimate-code link`."]
  }
  const b = report.binding
  // Workspace names come from the service with no charset rules, so control sequences are stripped from
  // everything printed for a person; `--json` keeps the raw values.
  const lines = [`Linked to workspace "${stripControlChars(b.datamateName)}" (id ${b.datamateId}).`]
  if (b.repoRemote) lines.push(`Matched by git remote: ${stripControlChars(b.repoRemote)}`)
  else if (b.projectPath) lines.push(`Matched by path: ${stripControlChars(b.projectPath)}`)
  if (report.memoryUnreadable) lines.push("Memory: the memory saved on this machine could not be read.")
  else if (!report.memory) lines.push("Memory: off.")
  else if (report.memory.unsynced === null)
    lines.push(`Memory: ${report.memory.local} saved here; how many reached the workspace is not known right now.`)
  else if (report.memory.unsynced === 0) lines.push(`Memory: ${report.memory.local} saved here, all in the workspace.`)
  else
    lines.push(
      `Memory: ${report.memory.local} saved here, ${report.memory.unsynced} not yet in the workspace — run \`altimate-code workspace sync\`.`,
    )
  if (!report.skillsEnabled) lines.push("Workspace skills: off.")
  else {
    const when = ago(report.skillsSyncedAt, now)
    lines.push(when ? `Workspace skills: last synced ${when}.` : "Workspace skills: not synced by this process yet.")
  }
  return lines
}

/** Lines and exit code for `workspace sync`. */
export function describeSync(report: Manage.SyncReport): { lines: string[]; code: number } {
  if (report.gated) {
    switch (report.gatedBecause) {
      case "no-binding":
        return { lines: ["This project is not linked to a workspace, so there is nothing to sync."], code: EXIT.NOT_LINKED }
      case "memory-off":
        return { lines: ["Memory is off for this workspace, so nothing was sent."], code: EXIT.OK }
      case "not-approved":
        return {
          lines: ["This project's link has not been confirmed on this machine, so nothing was sent. Run `altimate-code link --workspace <id>` to confirm it."],
          code: EXIT.USAGE,
        }
      case "flag-off":
        // With workspaces on, only the memory switch (ALTIMATE_DISABLE_MEMORY / OPENCODE_DISABLE_MEMORY) gets here.
        return { lines: ["Memory is turned off on this machine, so nothing was sent."], code: EXIT.OK }
      case "pin-unresolved":
        return {
          lines: ["The workspace selected for this folder could not be confirmed, so nothing was sent. Try again."],
          code: EXIT.FAILED,
        }
      case "setting-unavailable":
        return {
          lines: ["Could not check whether this workspace has memory turned on, so nothing was sent. Try again."],
          code: EXIT.FAILED,
        }
      default:
        return { lines: ["Could not read the memory saved on this machine, so nothing was sent."], code: EXIT.FAILED }
    }
  }
  const lines = [
    `${report.sent} sent, ${report.skipped} already in the workspace` +
      (report.deferred ? `, ${report.deferred} held back` : "") +
      (report.declined ? `, ${report.declined} refused by the workspace` : "") +
      (report.failed ? `, ${report.failed} failed` : "") +
      ".",
  ]
  if (report.deferred) lines.push("Held-back memories are retried on the next save or sync.")
  return { lines, code: report.failed > 0 || report.declined > 0 ? EXIT.FAILED : EXIT.OK }
}

/** Lines and exit code for `workspace refresh`. */
export function describeRefresh(report: Manage.RefreshReport): { lines: string[]; code: number } {
  const lines = [report.skillsChanged ? "Workspace skills updated." : "Workspace skills already up to date."]
  if (report.skillsSkipped.length) {
    lines.push(`${report.skillsSkipped.length} skill${report.skillsSkipped.length === 1 ? "" : "s"} skipped:`)
    for (const s of report.skillsSkipped) lines.push(`  - ${stripControlChars(s.skill)}: ${stripControlChars(s.reason)}`)
  }
  // From a shell there is no session to reload: memory is read fresh by the next session that starts here.
  if (report.memory || report.memoryInvalidated) lines.push("Workspace memory loads in the next session started in this project.")
  for (const e of report.errors) lines.push(`Error: ${stripControlChars(e)}`)
  return { lines, code: report.errors.length ? EXIT.FAILED : EXIT.OK }
}

/** What each subcommand needs from the outside world; replaced in tests so the exit codes and the `--yes`
 * guards can be checked without a service, a terminal or a project. */
export interface WorkspaceDeps {
  isConfigured(): Promise<boolean>
  resolve(directory: string): Promise<BindingOutcome>
  status(directory: string, binding: CachedBinding): Promise<Manage.StatusReport>
  refresh(directory: string): Promise<Manage.RefreshReport>
  sync(directory: string, binding: CachedBinding): Promise<Manage.SyncReport>
  unlink(directory: string): Promise<Manage.UnlinkReport>
  /** false when declined or cancelled. */
  confirm(message: string): Promise<boolean>
  isTTY(): boolean
  print(line: string): void
  printError(line: string): void
  printJson(payload: unknown): void
}

const defaultDeps: WorkspaceDeps = {
  isConfigured: () => AltimateApi.isConfigured().catch(() => false),
  resolve: (directory) => resolveBindingOutcome(directory),
  status: (directory, binding) => Manage.status(directory, { poll: true, binding }),
  refresh: (directory) => Manage.refresh(directory),
  sync: (directory, binding) => Manage.sync(directory, { binding }),
  unlink: (directory) => Manage.unlink(directory),
  confirm: async (message) => {
    const answer = await prompts.confirm({ message, initialValue: false })
    return !prompts.isCancel(answer) && answer === true
  },
  isTTY: () => Boolean(process.stdin.isTTY),
  print: (line) => UI.println(line),
  printError: (line) => UI.error(line),
  printJson: (payload) => process.stdout.write(JSON.stringify(payload, null, 2) + "\n"),
}

/** `ok` is true exactly when the exit code is 0, for every subcommand. */
function report(deps: WorkspaceDeps, json: boolean, code: number, payload: Record<string, unknown>, lines: string[]): number {
  if (json) deps.printJson({ ok: code === EXIT.OK, ...payload })
  else for (const line of lines) (code === EXIT.OK || code === EXIT.NOT_LINKED ? deps.print : deps.printError)(line)
  return code
}

function failure(deps: WorkspaceDeps, json: boolean, code: number, message: string): number {
  return report(deps, json, code, { error: message }, [message])
}

/** Checked first in every subcommand, so each fails the same way with the same exit code. */
const NOT_SIGNED_IN = "Not signed in to Altimate. Run altimate-code, sign in, then try again."
const NOT_LINKED_LINES = ["This project is not linked to a workspace.", "Link it with `altimate-code link`."]

/**
 * The project's link as the service has it. A confirmed "not linked" is exit 3; a service that could not be asked
 * is exit 1, never "not linked": a script branching on 3 would otherwise act on an outage.
 */
async function linkOf(
  deps: WorkspaceDeps,
  json: boolean,
  directory: string,
): Promise<{ binding: CachedBinding; stale: boolean } | { code: number }> {
  const outcome = await deps.resolve(directory)
  if (outcome.status === "bound") return { binding: outcome.binding, stale: outcome.stale === true }
  if (outcome.status === "unbound") {
    // A "not linked" answered from the short-lived miss cache says so: a link made elsewhere in the last few
    // minutes would not show yet.
    const lines = outcome.stale ? [...NOT_LINKED_LINES, "(As of a check in the last few minutes.)"] : NOT_LINKED_LINES
    return { code: report(deps, json, EXIT.NOT_LINKED, { linked: false, stale: outcome.stale === true }, lines) }
  }
  return {
    code: failure(deps, json, EXIT.FAILED, "Could not reach the workspace service to check whether this project is linked. Try again."),
  }
}

export async function runStatus(directory: string, json: boolean, deps: WorkspaceDeps = defaultDeps): Promise<number> {
  if (!(await deps.isConfigured())) return failure(deps, json, EXIT.USAGE, NOT_SIGNED_IN)
  try {
    const link = await linkOf(deps, json, directory)
    if ("code" in link) return link.code
    const status = await deps.status(directory, link.binding)
    const lines = describeStatus(status)
    if (link.stale) lines.push("(Last known link: the workspace service could not confirm it just now.)")
    if (link.binding.adopted)
      lines.push(
        "(Found on the workspace service but not confirmed on this machine: `workspace sync` will not send this machine's " +
          `memory until \`altimate-code link --workspace ${link.binding.datamateId}\` confirms it.)`,
      )
    return report(deps, json, EXIT.OK, { linked: true, stale: link.stale, ...status }, lines)
  } catch (err) {
    return failure(deps, json, EXIT.FAILED, `Could not read the workspace status: ${messageOf(err)}`)
  }
}

export async function runRefresh(directory: string, json: boolean, deps: WorkspaceDeps = defaultDeps): Promise<number> {
  if (!(await deps.isConfigured())) return failure(deps, json, EXIT.USAGE, NOT_SIGNED_IN)
  try {
    const link = await linkOf(deps, json, directory)
    if ("code" in link) return link.code
    const result = await deps.refresh(directory)
    const { lines, code } = describeRefresh(result)
    return report(deps, json, code, { ...result }, lines)
  } catch (err) {
    return failure(deps, json, EXIT.FAILED, `Could not refresh the workspace: ${messageOf(err)}`)
  }
}

export async function runSync(directory: string, json: boolean, deps: WorkspaceDeps = defaultDeps): Promise<number> {
  if (!(await deps.isConfigured())) return failure(deps, json, EXIT.USAGE, NOT_SIGNED_IN)
  try {
    // Resolved first, like `status`: a fresh clone linked on the service is linked here too, and "not linked"
    // is answered before any memory setting is consulted.
    const link = await linkOf(deps, json, directory)
    if ("code" in link) return link.code
    // A link found on the service but never confirmed on this machine does not get this machine's earlier
    // memory sent to it without the user saying so.
    if (link.binding.adopted)
      return failure(
        deps,
        json,
        EXIT.USAGE,
        `This project's link to "${stripControlChars(link.binding.datamateName)}" was found on the workspace service but not confirmed on this machine. ` +
          `Run \`altimate-code link --workspace ${link.binding.datamateId}\` to confirm it, then sync.`,
      )
    // A link the service could not confirm just now may have been detached or moved; memory is not sent to it.
    if (link.stale)
      return failure(deps, json, EXIT.FAILED, "Could not confirm this project's workspace link with the service, so nothing was sent. Try again.")
    const result = await deps.sync(directory, link.binding)
    const { lines, code } = describeSync(result)
    return report(deps, json, code, { ...result }, lines)
  } catch (err) {
    return failure(deps, json, EXIT.FAILED, `Could not sync memory: ${messageOf(err)}`)
  }
}

export async function runUnlink(directory: string, json: boolean, yes: boolean, deps: WorkspaceDeps = defaultDeps): Promise<number> {
  if (!(await deps.isConfigured())) return failure(deps, json, EXIT.USAGE, NOT_SIGNED_IN)
  try {
    const link = await linkOf(deps, json, directory)
    // Nothing is touched when the service says "not linked": `Manage.unlink` deletes server-side, and the
    // answer may be a cached miss that predates a new link. A confirmed unbind already takes the workspace
    // skills out of service on the next skill sync (every turn, or `workspace refresh`).
    if ("code" in link) return link.code
    const name = stripControlChars(link.binding.datamateName)
    if (!yes) {
      if (!deps.isTTY() || json) return failure(deps, json, EXIT.USAGE, `Unlinking from "${name}" needs confirmation: pass --yes.`)
      const confirmed = await deps.confirm(`Unlink this project from "${name}"? Workspace skills are removed from this project.`)
      // Declining is a choice, not a failure: exit 0 with nothing changed.
      if (!confirmed) return report(deps, json, EXIT.OK, { unlinked: false }, ["No changes."])
    }
    const result = await deps.unlink(directory)
    const lines = [`Unlinked from "${stripControlChars(result.was?.datamateName ?? link.binding.datamateName)}".`]
    if (!result.removedServerSide) lines.push("The workspace service had already removed this link; local state is cleared.")
    if (result.skillsLeftBehind) {
      // The link is gone but its skills still load into every session here: not a success.
      lines.push("Workspace skills could not be removed from .altimate-code/skill/_workspace; delete that folder by hand.")
      return report(deps, json, EXIT.FAILED, { unlinked: true, ...result }, lines)
    }
    return report(deps, json, EXIT.OK, { unlinked: true, ...result }, lines)
  } catch (err) {
    return failure(deps, json, EXIT.FAILED, `Could not unlink: ${messageOf(err)}`)
  }
}

function messageOf(err: unknown): string {
  return stripControlChars(err instanceof Error ? err.message : String(err))
}

/** Runs a subcommand inside the project, and reports a failure to even open the project (a bad --directory)
 * the same way as any other, JSON included. */
async function inProject(directory: string, json: boolean, run: () => Promise<number>): Promise<void> {
  let ran = false
  try {
    await bootstrap(directory, async () => {
      process.exitCode = await run()
      ran = true
    })
  } catch (err) {
    // After the command ran and reported, a failure closing the project must not print a second result or turn a
    // success into a failure: it is noted on stderr only.
    if (ran) {
      UI.error(`The command finished, but closing the project failed: ${messageOf(err)}`)
      return
    }
    process.exitCode = failure(defaultDeps, json, EXIT.FAILED, `Could not open the project at ${stripControlChars(directory)}: ${messageOf(err)}`)
  }
}

const DIRECTORY = { alias: "d", type: "string", describe: "Project directory (defaults to cwd)" } as const
const JSON_FLAG = { type: "boolean", default: false, describe: "Print the result as JSON" } as const

const StatusCommand = cmd({
  command: "status",
  describe: "show which workspace this project is linked to, and what has not synced",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await inProject(directory, args.json, () => runStatus(directory, args.json))
  },
})

const RefreshCommand = cmd({
  command: "refresh",
  describe: "pull the workspace's skills into this project (memory loads in the next session)",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await inProject(directory, args.json, () => runRefresh(directory, args.json))
  },
})

const SyncCommand = cmd({
  command: "sync",
  describe: "send memory saved on this machine that the workspace has not received",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await inProject(directory, args.json, () => runSync(directory, args.json))
  },
})

const UnlinkCommand = cmd({
  command: "unlink",
  describe: "detach this project from its workspace",
  builder: (yargs) =>
    yargs
      .option("directory", DIRECTORY)
      .option("json", JSON_FLAG)
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "Skip the confirmation" }),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await inProject(directory, args.json, () => runUnlink(directory, args.json, args.yes))
  },
})

export const WorkspaceCommand = cmd({
  command: "workspace",
  describe: "manage this project's Altimate workspace (status, refresh, sync, unlink)",
  builder: (yargs) =>
    yargs.command(StatusCommand).command(RefreshCommand).command(SyncCommand).command(UnlinkCommand).demandCommand(),
  async handler() {},
})

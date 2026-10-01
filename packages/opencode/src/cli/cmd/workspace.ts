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
//   2  usage: not signed in, or a destructive action without `--yes` and no terminal to ask on
//   3  the project is not linked to a workspace
import * as prompts from "@clack/prompts"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { AltimateApi } from "@/altimate/api/client"
import * as Manage from "@/altimate/workspace/manage"

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
  const lines = [`Linked to workspace "${b.datamateName}" (id ${b.datamateId}).`]
  if (b.repoRemote) lines.push(`Matched by git remote: ${b.repoRemote}`)
  else if (b.projectPath) lines.push(`Matched by path: ${b.projectPath}`)
  if (!report.memory) lines.push("Memory: off.")
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
      case "flag-off":
        return { lines: ["Workspaces are turned off on this machine, so nothing was sent."], code: EXIT.OK }
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
    `Sent ${report.sent}, already in the workspace ${report.skipped}` +
      (report.deferred ? `, held back ${report.deferred}` : "") +
      (report.declined ? `, refused by the workspace ${report.declined}` : "") +
      (report.failed ? `, failed ${report.failed}` : "") +
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
    for (const s of report.skillsSkipped) lines.push(`  - ${s.skill}: ${s.reason}`)
  }
  if (report.memory || report.memoryInvalidated) lines.push("Workspace memory will be reloaded at the start of the next turn.")
  for (const e of report.errors) lines.push(`Error: ${e}`)
  return { lines, code: report.errors.length ? EXIT.FAILED : EXIT.OK }
}

function emit(json: boolean, payload: unknown, lines: string[]): void {
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n")
  else for (const line of lines) UI.println(line)
}

/** Sign-in is checked first so every subcommand fails the same way, with the same exit code. */
async function signedIn(json: boolean): Promise<boolean> {
  if (await AltimateApi.isConfigured().catch(() => false)) return true
  const message = "Not signed in to Altimate. Run altimate-code, sign in, then try again."
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n")
  else UI.error(message)
  process.exitCode = EXIT.USAGE
  return false
}

function fail(json: boolean, action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n")
  else UI.error(`Could not ${action}: ${message}`)
  process.exitCode = EXIT.FAILED
}

const DIRECTORY = { alias: "d", type: "string", describe: "Project directory (defaults to cwd)" } as const
const JSON_FLAG = { type: "boolean", default: false, describe: "Print the result as JSON" } as const

const StatusCommand = cmd({
  command: "status",
  describe: "show which workspace this project is linked to, and what has not synced",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await bootstrap(directory, async () => {
      if (!(await signedIn(args.json))) return
      try {
        // `poll` asks the service when the cache cannot answer, so a fresh clone or a
        // new machine reports its server-side link rather than "not linked".
        const report = await Manage.status(directory, { poll: true })
        emit(args.json, { ok: true, linked: report.binding !== null, ...report }, describeStatus(report))
        process.exitCode = report.binding ? EXIT.OK : EXIT.NOT_LINKED
      } catch (err) {
        fail(args.json, "read the workspace status", err)
      }
    })
  },
})

const RefreshCommand = cmd({
  command: "refresh",
  describe: "pull the workspace's skills and memory into this project",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await bootstrap(directory, async () => {
      if (!(await signedIn(args.json))) return
      try {
        const current = await Manage.status(directory, { poll: true })
        if (!current.binding) {
          emit(args.json, { ok: false, linked: false }, describeStatus(current))
          process.exitCode = EXIT.NOT_LINKED
          return
        }
        const report = await Manage.refresh(directory)
        const { lines, code } = describeRefresh(report)
        emit(args.json, { ok: code === EXIT.OK, ...report }, lines)
        process.exitCode = code
      } catch (err) {
        fail(args.json, "refresh the workspace", err)
      }
    })
  },
})

const SyncCommand = cmd({
  command: "sync",
  describe: "send memory saved on this machine that the workspace has not received",
  builder: (yargs) => yargs.option("directory", DIRECTORY).option("json", JSON_FLAG),
  handler: async (args) => {
    const directory = args.directory ?? process.cwd()
    await bootstrap(directory, async () => {
      if (!(await signedIn(args.json))) return
      try {
        const report = await Manage.sync(directory)
        const { lines, code } = describeSync(report)
        emit(args.json, { ok: code === EXIT.OK, ...report }, lines)
        process.exitCode = code
      } catch (err) {
        fail(args.json, "sync memory", err)
      }
    })
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
    await bootstrap(directory, async () => {
      if (!(await signedIn(args.json))) return
      try {
        const current = await Manage.status(directory, { poll: true })
        if (!current.binding) {
          emit(args.json, { ok: true, linked: false, unlinked: false }, ["This project is not linked to a workspace."])
          process.exitCode = EXIT.NOT_LINKED
          return
        }
        const name = current.binding.datamateName
        if (!args.yes) {
          if (!process.stdin.isTTY || args.json) {
            const message = `Unlinking from "${name}" needs confirmation: pass --yes.`
            if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n")
            else UI.error(message)
            process.exitCode = EXIT.USAGE
            return
          }
          const confirmed = await prompts.confirm({
            message: `Unlink this project from "${name}"? Workspace skills are removed from this project.`,
            initialValue: false,
          })
          if (prompts.isCancel(confirmed) || !confirmed) {
            UI.println("No changes.")
            return
          }
        }
        const report = await Manage.unlink(directory)
        const lines = [`Unlinked from "${report.was?.datamateName ?? name}".`]
        if (!report.removedServerSide) lines.push("The workspace service had already removed this link; local state is cleared.")
        if (report.skillsLeftBehind)
          lines.push("Workspace skills could not be removed from .altimate-code/skill/_workspace; delete that folder by hand.")
        emit(args.json, { ok: true, unlinked: true, ...report }, lines)
      } catch (err) {
        fail(args.json, "unlink", err)
      }
    })
  },
})

export const WorkspaceCommand = cmd({
  command: "workspace",
  describe: "manage this project's Altimate workspace (status, refresh, sync, unlink)",
  builder: (yargs) =>
    yargs.command(StatusCommand).command(RefreshCommand).command(SyncCommand).command(UnlinkCommand).demandCommand(),
  async handler() {},
})

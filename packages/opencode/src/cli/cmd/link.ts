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
import {
  openWorkspaceBrowserHandoff,
  resolveWorkspaceWebUrl,
  type HandoffResult,
} from "@/altimate/workspace/browser-handoff"
import { recordApprovedBinding } from "@/altimate/workspace/state"

const CREATE_NEW_SENTINEL = "__create_new__"
const SET_UP_IN_BROWSER_SENTINEL = "__browser_handoff__"

/** Strip C0/C1 control bytes (including ESC) from server-controlled text
 * before it reaches a raw-stdout escape-sequence wrapper. Workspace names
 * come from ``WorkspaceApi.listDatamates()`` with no charset validation — an
 * attacker-controlled name containing its own ``\x1b]8;;`` could otherwise
 * prematurely close our hyperlink and open a spoofed one pointing wherever
 * they choose, with our trusted URL as the visible (but inert) prefix.
 * (CodeRabbit + cubic, PR #1274.) */
export function stripControlChars(text: string): string {
  // C0 (\x00-\x1f) + DEL (\x7f) + C1 (\x80-\x9f) — the previous range only
  // covered C0/DEL, leaving C1 controls unstripped. ESC (the OSC 8 breakout
  // vector) was always covered, but the doc comment claimed C1 coverage it
  // didn't have. (Kilo, PR #1274.)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
}

/** Conservative allowlist of terminals known to render OSC 8 hyperlinks.
 * There's no capability query as reliable as opentui's device-attribute
 * detection (used by the TUI side) available to a plain CLI process, so this
 * errs toward false negatives — worst case a supporting terminal renders
 * plain text instead of a link, which is a strict improvement over the
 * inverse (underlining text that turns out not to be clickable). Mirrors the
 * checks the `supports-hyperlinks` package uses, inlined to avoid a new
 * dependency for one CLI affordance.
 *
 * Deliberately excludes ``Apple_Terminal`` (macOS Terminal.app): OSC 8
 * support only landed there in macOS Sequoia (Sept 2024) — older versions
 * (Ventura/Sonoma and earlier) only auto-linkify plain-text URLs, not OSC 8.
 * ``TERM_PROGRAM`` carries no OS/Terminal-version signal to tell those apart,
 * and this function's own stated bias is toward false negatives, so it's
 * left off the list rather than guessing the user is on a current-enough
 * macOS. (Kilo, PR #1274 — corrects an earlier version of this list that
 * included it.) */
export function terminalSupportsHyperlinks(): boolean {
  if (!process.stdout.isTTY) return false
  if (process.env.TERM === "dumb" || process.env.TERM === "linux") return false
  const termProgram = process.env.TERM_PROGRAM
  if (termProgram && ["iTerm.app", "WezTerm", "Hyper", "vscode", "ghostty", "Tabby", "rio"].includes(termProgram))
    return true
  if (process.env.WT_SESSION) return true // Windows Terminal
  if (process.env.KONSOLE_VERSION) return true
  const vte = Number(process.env.VTE_VERSION)
  if (!Number.isNaN(vte) && vte >= 5000) return true // VTE >= 0.50.0 (GNOME Terminal and other VTE-based terms)
  return false
}

/** Append ``/w/<id>`` to ``base``'s pathname using real URL semantics, rather
 * than string-concatenating ``toString()``. The dev-only
 * ``ALTIMATE_WORKSPACE_WEB_URL`` override (resolveWorkspaceWebUrl) can carry
 * its own path/query/fragment (e.g. a local dev server), and naive
 * concatenation would land ``/w/<id>`` inside the query string instead of the
 * path — clears search/hash for the same reason. (CodeRabbit + cubic, PR #1274.)
 *
 * Both in-file callers (``currentManageUrl`` in the handler, and
 * ``manageUrlFor`` below) now go through this one implementation. The
 * identical ``workspace.tsx``/``workspace-sidebar.tsx`` copy
 * (``joinManageUrlPath``) is deliberately NOT unified with this one across a
 * shared module, though: same
 * CLI/TUI self-containment reasoning as ``isSafeHttpUrl``'s split (see
 * ``cli/cmd/link.ts``'s other comment on that). cubic suggested a shared
 * module (PR #1274 round 3); declined for that reason — but *within* this
 * file, keep it to one implementation (see ``manageUrlFor``'s comment on
 * why two near-identical copies in the same file already drifted once). */
export function buildManageUrl(base: URL, workspaceId: number): string {
  const u = new URL(base)
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/w/${workspaceId}`
  u.search = ""
  u.hash = ""
  return u.toString()
}

/** Wrap ``text`` in an OSC 8 terminal hyperlink pointing at ``url``, or return
 * ``text`` unchanged when ``url`` is null. Unlike the TUI's `<a href>` (which
 * crashes in the current @opentui/solid JSX layer — see workspace-sidebar.tsx),
 * plain stdout can emit OSC 8 directly: a terminal directly interpreting the
 * bytes either renders a real clickable link or silently skips the sequence
 * it doesn't recognize — the visible text is unaffected either way. That
 * "harmless when unrecognized" argument only holds when a terminal emulator
 * is actually the one reading the bytes, though: with stdout redirected to a
 * file or piped into another program (stdin can still be a TTY — the
 * interactive-stdin check in the handler doesn't imply stdout is a terminal
 * too), there's no interpreter to skip them, so the raw escape sequence
 * would land as literal junk in the captured output. Skip the OSC 8 wrapping
 * entirely in that case. The *underline* is additionally gated on
 * ``terminalSupportsHyperlinks`` — a much older and more universally-rendered
 * SGR code than OSC 8, so emitting it unconditionally would make the name
 * look clickable in terminals where it isn't. (cubic, PR #1274, rounds 2 + 3.) */
export function hyperlink(text: string, url: string | null): string {
  if (!url || !text) return text
  const safeText = stripControlChars(text)
  if (!process.stdout.isTTY) return safeText
  const OSC8 = "\x1b]8;;"
  const ST = "\x1b\\"
  if (!terminalSupportsHyperlinks()) return `${OSC8}${url}${ST}${safeText}${OSC8}${ST}`
  const UNDERLINE = "\x1b[4m"
  const UNDERLINE_OFF = "\x1b[24m"
  return `${OSC8}${url}${ST}${UNDERLINE}${safeText}${UNDERLINE_OFF}${OSC8}${ST}`
}

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
    // Fail fast on non-TTY stdin — the whole subcommand is a series of
    // ``@clack/prompts`` interactive selects (workspace picker, name prompt,
    // confirm), so a piped or redirected stdin (``altimate-code link < /dev/null``,
    // CI runner, background job) makes every prompt.select() block forever
    // with no output — the user sees a hung process at 0% CPU. Bail with a
    // clear message directing them to the alternative that actually works
    // headless (the TUI plugin's palette command). (kilo cycle 6.)
    if (!process.stdin.isTTY) {
      UI.error(
        "`altimate-code link` needs an interactive terminal (stdin must be a TTY). " +
          "Run it directly in a shell, or use the TUI palette command " +
          '"Link this project to a workspace".',
      )
      process.exitCode = 1
      return
    }

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

    // Only offer the browser-based handoff when the deployment supports it
    // (freemium only today). Enterprise / localhost / custom-domain callers
    // silently fall back to the CLI-side quick create.
    const creds = await AltimateApi.getCredentials()
    const workspaceWebBase = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    const browserAvailable = workspaceWebBase !== null
    // Deterministic from tenant + id, same derivation as the TUI's
    // buildManageUrl (workspace.tsx) — null on BYOK/unresolvable, in which
    // case the name below prints as plain (non-clickable) text.
    const currentManageUrl =
      currentId !== undefined && workspaceWebBase ? buildManageUrl(workspaceWebBase, currentId) : null
    // On a terminal `terminalSupportsHyperlinks()` doesn't recognize, the
    // OSC 8 wrapping below is invisible bytes and the name renders as plain
    // text with no indication a URL exists at all — unlike the TUI, which
    // falls back to a toast ("Could not open browser. Copy this URL: ...").
    // Print the plain URL once as a fallback the terminal can't hide, rather
    // than leaving it unreachable outside the allowlist. (multi-model
    // review, PR #1274.)
    if (currentManageUrl && !terminalSupportsHyperlinks()) {
      prompts.log.info(`Manage it at: ${currentManageUrl}`)
    }

    const options: Array<{ value: string; label: string; hint?: string }> = [
      // Only offer browser handoff for UNLINKED projects (CodeRabbit cycle 5).
      // ``runBrowserHandoff`` creates a fresh workspace and calls
      // ``bindExisting``, which 409s when there's already an active binding —
      // leaving the browser-created workspace stranded and no rebind actually
      // happening. If the project is already linked, the caller wants a
      // rebind path (offered elsewhere in this menu), not create-and-bind.
      //
      // Also gate on ``preCheckOk`` (Kilo cycle 6): when the pre-check itself
      // failed (network / 5xx), ``existing`` stays null but the project MAY
      // be linked server-side. Offering the browser flow then would run the
      // same 409 → stranded-workspace path. Better to hide the option until
      // the caller can confirm the binding state.
      ...(browserAvailable && !existing && preCheckOk
        ? [
            {
              value: SET_UP_IN_BROWSER_SENTINEL,
              label: `＋ Set up in browser "${autoName}"`,
              hint: "Approve in the Altimate SaaS; CLI links your project automatically.",
            },
          ]
        : []),
      {
        value: CREATE_NEW_SENTINEL,
        label: `＋ Create a quick workspace "${autoName}" here`,
        hint: existing
          ? "Creates a new workspace and repoints this project to it (no browser step)."
          : "No browser step; configure integrations later in the SaaS.",
      },
      ...list.map((dm) => ({
        value: String(dm.id),
        label:
          dm.id === currentId ? `● ${hyperlink(dm.name, currentManageUrl)}` : `  ${dm.name}`,
        hint: dm.id === currentId ? "currently linked here" : undefined,
      })),
    ]

    const pick = await prompts.select<string>({
      message: existing
        ? `Currently linked to "${hyperlink(currentName!, currentManageUrl)}". Pick a workspace (or create a new one):`
        : "Pick a workspace to link (or create a new one):",
      options,
      initialValue: currentId !== undefined ? String(currentId) : CREATE_NEW_SENTINEL,
    })

    if (prompts.isCancel(pick)) {
      prompts.outro("No changes.")
      return
    }

    if (pick === SET_UP_IN_BROWSER_SENTINEL) {
      await runBrowserHandoff(identifier, autoName, args.directory)
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

/** Browser-based create-and-bind flow. Same handoff module the TUI post-scan
 * dialog uses; on success, the CLI calls the existing bind endpoint to link
 * the current project to the newly-created workspace. When the project is
 * already linked, bindExisting will 409; the caller re-runs and picks
 * "＋ Create a quick workspace here" instead to trigger the create-and-rebind
 * path. (Full create-then-rebind via the browser flow is deferred — the
 * SaaS approval screen doesn't yet know how to receive a "rebind after
 * create" instruction from the CLI.) */
async function runBrowserHandoff(
  identifier: ProjectIdentifier,
  projectName: string,
  directory: string,
): Promise<void> {
  const spin = prompts.spinner()
  spin.start("Waiting for browser approval (up to 15 min)...")
  const result: HandoffResult = await openWorkspaceBrowserHandoff({ identifier, projectName })
  if (!result.ok) {
    spin.stop(handoffFailureMessage(result), 1)
    process.exitCode = 1
    return
  }
  // M6 in the consensus review: re-verify credentials before binding. The
  // browser window can stay open for up to 15 minutes; an account switch in
  // that window would otherwise bind a callback validated for tenant A
  // under tenant B (workspace ids are tenant-schema-local).
  try {
    const fresh = await AltimateApi.getCredentials()
    if (
      fresh.altimateInstanceName !== result.credentials.tenant ||
      fresh.altimateUrl !== result.credentials.apiUrl
    ) {
      spin.stop(
        `Credentials changed while the browser was open (was ${result.credentials.tenant}, now ${fresh.altimateInstanceName}). Re-run to link this project.`,
        1,
      )
      process.exitCode = 1
      return
    }
  } catch {
    spin.stop("Lost Altimate credentials while the browser was open — sign in and re-run.", 1)
    process.exitCode = 1
    return
  }
  spin.stop(`Workspace approved. Binding to project...`)
  const bindSpin = prompts.spinner()
  bindSpin.start("Linking workspace...")
  try {
    const res = await WorkspaceApi.bindExisting(result.workspaceId, identifier)
    // Match the two other recordApprovedBinding call sites in this file
    // (lines 377 and 496) which cache under ``identifier.projectPath ??
    // directory``. The raw ``directory`` here caches under a different key
    // when the caller passes a relative or symlinked ``-d`` path, so a
    // later readLocalBinding from the TUI sidebar can miss the binding.
    // (coderabbitai #1100 comment 3841173342.)
    await recordApprovedBinding(identifier.projectPath ?? directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    }, { awaitBackfill: true })
    bindSpin.stop(`Linked to "${res.binding.datamate_name}".`)
    prompts.log.info("Saved memory blocks will sync to this workspace if memory is enabled for it.")
    const manageUrl = await manageUrlFor(res.binding.datamate_id)
    if (manageUrl) prompts.log.info(`Manage it at: ${manageUrl}`)
    prompts.outro("Done.")
  } catch (err) {
    bindSpin.stop("Link failed.", 1)
    if (err instanceof ConflictError) {
      prompts.log.error(
        `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Workspace "${projectName}" was created but is not linked — re-run \`altimate-code link\` and pick a different action to switch, or delete the new workspace in the SaaS.`,
      )
    } else if (err instanceof NotFoundError) {
      prompts.log.error("Workspace not found — the tenant or workspace may have changed.")
    } else if (err instanceof ForbiddenError) {
      prompts.log.error("Only the workspace owner can bind projects to it.")
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

/** Best-effort manage-workspace URL for the current credentials. Returns null
 * on BYOK / unresolvable deployments — callers omit the "Manage it at" line.
 * Delegates the actual join to ``buildManageUrl`` rather than re-deriving it —
 * this function had its own copy of the pre-fix string-concatenation bug
 * (cubic, PR #1274 round 3): two near-identical builders in the same file
 * drifted, and only one got fixed the first time around. */
async function manageUrlFor(workspaceId: number): Promise<string | null> {
  try {
    const creds = await AltimateApi.getCredentials()
    const base = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    if (!base) return null
    return buildManageUrl(base, workspaceId)
  } catch {
    return null
  }
}

function handoffFailureMessage(result: Extract<HandoffResult, { ok: false }>): string {
  switch (result.reason) {
    case "unavailable":
      return "Browser handoff isn't available for this deployment."
    case "not_configured":
      return "Altimate credentials not configured — sign in first."
    case "timeout":
      return "Timed out waiting for browser approval (15 min)."
    case "cancelled":
      return "Cancelled by user."
    case "tenant_mismatch":
      return result.message ?? "Workspace was set up in a different tenant than the CLI's credentials."
    case "port_exhausted":
      return result.message ?? "Loopback ports 7317-7325 all in use."
    case "browser_open_failed":
      return `Could not open browser${result.authorizeUrl ? `. Open manually: ${result.authorizeUrl}` : "."}`
    case "aborted":
      return result.message ?? "Browser handoff was cancelled."
    default:
      return result.message ?? "Browser handoff failed."
  }
}

/** "＋ Create a quick workspace here" flow. When the project is already
 * linked, this MUST rebind after create — otherwise the new workspace is a
 * real (billable) SaaS resource the CLI knows nothing about and the project
 * is still bound to the old workspace (M2 in the consensus review). When
 * rebind fails, the error message tells the user the workspace was created
 * and how to recover; we do NOT silently swallow the orphan. */
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
  // Prefer the canonicalized ``identifier.projectPath`` over the raw
  // ``--directory`` argument so ``altimate-code link -d ./myproj`` and its
  // symlink-resolved twin both write under the same cache key (Kilo cycle 6).
  await recordApprovedBinding(identifier.projectPath ?? directory, {
    datamateId: created.datamate.id,
    datamateName: created.datamate.name,
    repoRemote: created.binding.repo_remote,
    projectPath: created.binding.project_path,
    linkedAt: Date.now(),
  }, { awaitBackfill: true })
  prompts.log.info("Saved memory blocks will sync to this workspace if memory is enabled for it.")
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
 * dispatch to whatever OS scheme handler matches the protocol).
 *
 * Deliberately duplicated in ``packages/opencode/src/plugin/tui/altimate/workspace.tsx``
 * so the CLI subcommand path (this file) and the TUI plugin path stay
 * independent. Keep in sync — if the allowed-protocol set ever changes
 * (e.g. tighten to ``https:`` only), update both copies. */
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
          //
          // Pick the rebind endpoint from the CONFLICT DETAIL, not from the
          // current identifier — the existing binding may be keyed by a
          // different identifier than the project's current one (path-keyed
          // legacy binding + newly-added remote, or vice versa). Keying off
          // the current identifier reproduces the M3 hazard on this fallback
          // path. (Kilo cycle 6.)
          spin.stop("Pre-check missed an existing binding — retrying as re-link.", 1)
          const rebindSpin = prompts.spinner()
          rebindSpin.start("Re-linking...")
          try {
            // detail.project_path present → the conflicting binding is
            // path-keyed; use /by-path. Else the conflict was on repo_remote.
            const conflictPath = err.detail.project_path
            const conflictRemote = err.detail.repo_remote
            if (conflictPath) {
              res = await WorkspaceApi.rebindByPath({
                projectPath: conflictPath,
                targetDatamateId,
              })
            } else if (conflictRemote) {
              res = await WorkspaceApi.rebindByRemote({
                remote: conflictRemote,
                targetDatamateId,
              })
            } else {
              // Server didn't tell us which identifier owned the conflict —
              // fall back to the current identifier's preference (better than
              // nothing, but shouldn't happen with a well-formed 409 body).
              res = identifier.repoRemote
                ? await WorkspaceApi.rebindByRemote({
                    remote: identifier.repoRemote,
                    targetDatamateId,
                  })
                : await WorkspaceApi.rebindByPath({
                    projectPath: identifier.projectPath!,
                    targetDatamateId,
                  })
            }
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
    // Prefer the canonicalized identifier over the raw --directory (Kilo cycle 6).
    await recordApprovedBinding(identifier.projectPath ?? directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    }, { awaitBackfill: true })
    spin.stop(
      isRebind
        ? `Re-linked to "${res.binding.datamate_name}".`
        : `Linked to "${res.binding.datamate_name}".`,
    )
    prompts.log.info("Saved memory blocks will sync to this workspace if memory is enabled for it.")
    const manageUrl = await manageUrlFor(res.binding.datamate_id)
    if (manageUrl) prompts.log.info(`Manage it at: ${manageUrl}`)
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
 * the CLI. (M3)
 *
 * Deliberately duplicated in ``packages/opencode/src/plugin/tui/altimate/workspace.tsx``
 * so the CLI subcommand and the TUI plugin flows can evolve independently.
 * Keep both copies in sync when the M3 endpoint-selection logic changes. */
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

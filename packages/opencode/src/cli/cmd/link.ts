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
  HIDDEN_BINDING_MESSAGE,
  isHiddenBindingConflict,
  QUICK_WORKSPACE_PRIVATE_NOTE,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  PreconditionFailedError,
  type ActAs,
  type Binding,
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
  buildManageUrl,
  openWorkspaceBrowserHandoff,
  resolveWorkspaceWebUrl,
  type HandoffResult,
} from "@/altimate/workspace/browser-handoff"
import { accountDigest, credentialDigest, recordApprovedBinding } from "@/altimate/workspace/state"
import type { SeedOutcome } from "@/altimate/workspace/memory-backfill"
import {
  confirmsNamesake,
  displayWorkspaceName,
  findNamesakes,
  linkPickerOpensOn,
  namesakeHint,
  stripBidiControls,
} from "@/altimate/workspace/workspace-name"

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
  // Plus the Unicode bidi controls (ALM, LRM/RLM, LRE..RLO, LRI..PDI): they cannot break out of the
  // hyperlink (the href is always `buildManageUrl`, never the name) but can visually reverse or
  // reorder the displayed name in the picker. (v0.11.2 release review.)
  // eslint-disable-next-line no-control-regex
  return stripBidiControls(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""))
}

/** What a pick in the link picker does: one of the two create paths, or an existing workspace. */
export function linkPickKind(pick: string): "create" | "browser" | "workspace" {
  if (pick === CREATE_NEW_SENTINEL) return "create"
  if (pick === SET_UP_IN_BROWSER_SENTINEL) return "browser"
  return "workspace"
}

/** Sanitized display name for a ``ConflictError``'s existing-binding name,
 * with a stable fallback when the server didn't send one. A third
 * near-identical copy of this exact ternary appeared across three different
 * catch blocks in this file before being extracted here — same drift risk
 * ``buildManageUrl``'s move to ``browser-handoff.ts`` (see that function's
 * comment) was extracted to avoid: a security-relevant pattern duplicated
 * per call site only stays in sync by accident. (Kilo, PR #1274 round 8.) */
function conflictExistingName(detail: { existing_datamate_name?: string | null }): string {
  return detail.existing_datamate_name ? stripControlChars(detail.existing_datamate_name) : "another workspace"
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
  if (!text) return text
  const safeText = stripControlChars(text)
  // Sanitize before checking `url` — the null-URL early return used to skip
  // stripControlChars entirely, so a caller relying on hyperlink() as its
  // sanitization boundary got the raw name whenever no manage URL existed
  // (BYOK/unresolvable deployments). Every caller in this file now also
  // sanitizes independently before calling this (defense in depth, not the
  // sole boundary), but this fixes the function's own contract too.
  // (CodeRabbit, PR #1274 round 4.)
  //
  // Also validate `url` itself, not just `text` — hyperlink() is exported
  // (tests import it directly), so its contract is wider than its two
  // in-file callers, both of which only ever pass a `buildManageUrl(...)`-
  // derived trusted URL. A hypothetical external caller passing something
  // unvalidated (e.g. a raw `manage_url` straight from an API response)
  // would otherwise defeat the escaping this function is careful about on
  // the `text` side while doing nothing for `url`. (multi-model review, PR
  // #1274 round 7.)
  //
  // isSafeHttpUrl only checks that `url` PARSES as http(s) via `new URL()`
  // — it doesn't sanitize, and doesn't return the re-serialized/encoded
  // form. `new URL()` itself percent-encodes control bytes when it builds
  // its own `.toString()`, but that encoding never reaches the ORIGINAL
  // `url` string this function actually interpolates below — a string can
  // contain a live ESC byte and still parse successfully as a valid
  // https: URL (verified: `new URL("https://evil.example/\x1b]8;;...")`
  // does not throw). So `isSafeHttpUrl` returning true does not mean `url`
  // is free of control bytes; reject it separately, the same way `text` is
  // sanitized above — rejecting (falling back to plain text) rather than
  // stripping, since a mangled URL is worse than no link at all. (cubic,
  // PR #1274 round 8.)
  if (!url || stripControlChars(url) !== url || !isSafeHttpUrl(url)) return safeText
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
    yargs
      .option("directory", {
        alias: "d",
        describe: "Project directory (defaults to cwd)",
        type: "string",
        default: process.cwd(),
      })
      // altimate_change start — non-interactive link for scripts, devcontainers and CI
      .option("workspace", {
        alias: "w",
        describe: "Link to this existing workspace without prompting: an id, or an exact name (an id is matched first)",
        type: "string",
      })
      .option("create", {
        describe: "Create a workspace with this name (defaults to the repo name) and link to it without prompting",
        type: "string",
      })
      .option("yes", {
        alias: "y",
        describe: "Allow replacing an existing link when --workspace or --create is used",
        type: "boolean",
        default: false,
      })
      .option("allow-duplicate", {
        describe: "With --create, create the workspace even if one with that name already exists",
        type: "boolean",
        default: false,
      }),
  // altimate_change end
  handler: async (args) => {
    // altimate_change start — non-interactive link
    if (args.workspace !== undefined || args.create !== undefined) {
      await linkHeadless({
        directory: args.directory,
        workspace: args.workspace,
        create: args.create,
        yes: args.yes,
        allowDuplicate: args["allow-duplicate"],
      })
      return
    }
    // altimate_change end
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
        `Could not reach the workspace service to check which workspace this project is linked to (${err instanceof Error ? err.message : String(err)}). The current link will not be marked.`,
      )
    }

    // One credential for the list, the owner lookup and the bind: workspace and user ids are
    // per tenant, so a switch while the picker is open must not mix two accounts.
    const actAs = await WorkspaceApi.captureCredentials()
    if (!actAs) {
      prompts.log.error("Could not read your Altimate credentials. Check /connect and try again.")
      process.exitCode = 1
      return
    }
    const spin = spinner()
    spin.start("Loading workspaces...")
    let list: DatamateRef[]
    try {
      list = await WorkspaceApi.listDatamates(actAs)
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
    // Listed workspaces already named what a quick create would use. The picker opens on
    // the caller's own (never a colleague's), and creating another namesake is confirmed.
    // Without a user id nothing is preselected; the confirmation still applies.
    const userId = await WorkspaceApi.whoami(actAs).catch(() => undefined)
    const namesakes = findNamesakes(list, autoName, userId)
    // Sanitized once here so every downstream display (the picker message,
    // the "Kept" outro, hyperlink()'s own text) is covered — hyperlink()
    // only sanitized its own `text` param, not the raw name reaching
    // `prompts.outro`/`prompts.select`'s message directly. (CodeRabbit,
    // PR #1274 round 4 — flagged one call site; the underlying gap was
    // every raw name-interpolation in this file, not just that one.)
    const currentName = existing ? stripControlChars(existing.datamate.name) : undefined

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
      ...list.map((dm) => {
        // Every row's name is server-controlled (any workspace the account
        // can see, not just ones this user created) — sanitize regardless
        // of whether this row also goes through hyperlink() below.
        const safeDmName = stripControlChars(dm.name)
        return {
          value: String(dm.id),
          label: dm.id === currentId ? `● ${hyperlink(safeDmName, currentManageUrl)}` : `  ${safeDmName}`,
          hint: dm.id === currentId ? "currently linked here" : namesakeHint(dm, namesakes, userId),
        }
      }),
    ]

    const pick = await prompts.select<string>({
      message: existing
        ? `Currently linked to "${hyperlink(currentName!, currentManageUrl)}". Pick a workspace (or create a new one):`
        : "Pick a workspace to link (or create a new one):",
      options,
      initialValue: ((at) => (at === "create" ? CREATE_NEW_SENTINEL : String(at)))(
        linkPickerOpensOn(currentId, namesakes),
      ),
    })

    if (prompts.isCancel(pick)) {
      prompts.outro("No changes.")
      return
    }

    // Both create paths start from the project's name, so both confirm a namesake.
    const twin = namesakes.own ?? namesakes.all[0]
    if (twin && confirmsNamesake(linkPickKind(pick), namesakes)) {
      const again = await prompts.confirm({
        message: `A workspace named "${stripControlChars(displayWorkspaceName(twin.name))}" already exists. Create another one with the same name?`,
        initialValue: false,
      })
      if (prompts.isCancel(again) || !again) {
        prompts.outro("No changes.")
        return
      }
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

    await bindOrRebind(identifier, targetId, existing, preCheckOk, args.directory, actAs)
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
  // The account this bind acts as; the seed refuses (account-changed) if it switches mid-way.
  // Unreadable credentials cannot link anyway, and must not leave the bind unguarded.
  const linkAccount = await accountDigest()
  if (linkAccount === null) {
    prompts.log.error("Could not read your Altimate credentials, so nothing was linked. Check /connect and try again.")
    process.exitCode = 1
    return
  }
  const spin = spinner()
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
  spin.stop(`Workspace approved. Linking it to this project...`)
  const bindSpin = spinner()
  bindSpin.start("Linking workspace...")
  try {
    const res = await WorkspaceApi.bindExisting(result.workspaceId, identifier)
    // Match the two other recordApprovedBinding call sites in this file
    // (lines 377 and 496) which cache under ``identifier.projectPath ??
    // directory``. The raw ``directory`` here caches under a different key
    // when the caller passes a relative or symlinked ``-d`` path, so a
    // later readLocalBinding from the TUI sidebar can miss the binding.
    // (coderabbitai #1100 comment 3841173342.)
    const seed = await recordApprovedBinding(identifier.projectPath ?? directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    }, { awaitBackfill: true, account: linkAccount })
    bindSpin.stop(`Linked to "${stripControlChars(res.binding.datamate_name)}".`)
    prompts.log.info(seedMessage(seed))
    const manageUrl = await manageUrlFor(res.binding.datamate_id)
    if (manageUrl) prompts.log.info(`Manage it at: ${manageUrl}`)
    prompts.outro("Done.")
  } catch (err) {
    bindSpin.stop("Link failed.", 1)
    if (isHiddenBindingConflict(err)) {
      prompts.log.error(`${HIDDEN_BINDING_MESSAGE} Workspace "${projectName}" was created but is not linked.`)
    } else if (err instanceof ConflictError) {
      const existingName = conflictExistingName(err.detail)
      prompts.log.error(
        `This project is already linked to "${existingName}". Workspace "${projectName}" was created but is not linked — re-run \`altimate-code link\` and pick a different action to switch, or delete the new workspace in the SaaS.`,
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
 * and how to recover; we do NOT silently swallow the orphan.
 *
 * Exported for tests. The branch it picks — atomic create-and-bind when the
 * project is free, unbound-create-then-rebind when it is already linked — is
 * the whole of this fix, and nothing else in this file can assert it. */
export async function createThenBindOrRebind(
  identifier: ProjectIdentifier,
  name: string,
  directory: string,
  existing: ProjectBindingLookup | null,
  /** False for a headless run: print the manage URL, but there is nobody at a browser to look at it. */
  opts: { openBrowser?: boolean } = {},
): Promise<void> {
  // The account this bind acts as; the seed refuses (account-changed) if it switches mid-way.
  // Unreadable credentials cannot link anyway, and must not leave the bind unguarded.
  const linkAccount = await accountDigest()
  if (linkAccount === null) {
    prompts.log.error("Could not read your Altimate credentials, so nothing was linked. Check /connect and try again.")
    process.exitCode = 1
    return
  }
  const spin = spinner()
  spin.start(`Creating workspace "${name}"...`)
  // Discriminated on how the workspace was made, because the two creates return
  // genuinely different things: only `bound` carries a server binding row and a
  // manage_url. An optional-field shape let the rest of this function reach for
  // `binding` on the path that never has one and silently fall through to a
  // default. (review, PR #1314)
  type Created =
    | { via: "bound"; datamate: DatamateRef; binding: Binding; manage_url: string }
    | { via: "unbound"; datamate: DatamateRef }
  let created: Created
  // Captured BEFORE the create and re-checked before the rebind. Each request
  // resolves credentials on its own, so an account switch in between would
  // create the workspace on one tenant and rebind on another using an id that
  // is local to the first. (review, PR #1314)
  const account = await WorkspaceApi.accountFingerprint().catch(() => null)
  try {
    // Two different creates, because the server offers two different things.
    //
    // Unlinked: ``createAndBind`` creates and binds in ONE transaction, so a
    // conflicting binding can never strand a half-created workspace.
    //
    // Already linked: that same atomicity makes it unusable. ``create_and_bind``
    // pre-checks the identifiers and 409s *before* creating anything, so the
    // rebind below never got a target and this row simply always failed — with
    // an error telling the user to re-run the command they were already inside.
    // Create unbound first, then repoint, which is what the row's own hint
    // promises.
    if (existing) {
      const ws = await WorkspaceApi.createWorkspaceUnbound({ name })
      created = { via: "unbound", datamate: ws }
    } else {
      const res = await WorkspaceApi.createAndBind({ name, identifier })
      created = { via: "bound", datamate: res.datamate, binding: res.binding, manage_url: res.manage_url }
    }
  } catch (err) {
    spin.stop("Failed to create workspace.", 1)
    // Split by which call actually ran, because they cannot 409 for the same
    // reason. `createAndBind` sends the project identifiers, so its conflict is
    // a binding race. The unbound create sends none — it cannot produce an
    // identity conflict at all, so attributing one there would have sent the
    // user looking for a race that did not happen. (review, PR #1314)
    if (err instanceof ConflictError) {
      if (existing) {
        prompts.log.error(
          `The workspace could not be created: ${err.message}. Nothing was created, and this ` +
            `project is still linked to "${stripControlChars(existing.datamate.name)}".`,
        )
      } else if (isHiddenBindingConflict(err)) {
        prompts.log.error(`${HIDDEN_BINDING_MESSAGE} Nothing was created.`)
      } else {
        const existingName = conflictExistingName(err.detail)
        prompts.log.error(
          `Another workspace, "${existingName}", claimed this project while you were choosing. ` +
            `Nothing was created. Run \`altimate-code link\` again to see the current list.`,
        )
      }
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
    return
  }
  // Sanitized once — echoed back from the create-workspace API response
  // (not the locally-typed `name` param), so it's technically server data
  // even though it usually just round-trips the caller's own auto-name.
  const safeCreatedName = stripControlChars(created.datamate.name)
  spin.stop(`Workspace "${safeCreatedName}" created.`)

  // The already-linked path created an unbound workspace above, so the binding
  // still points at the OLD one — repoint it now. The unlinked path already got
  // its binding from the atomic create, so there is nothing left to do.
  let reboundBinding: Binding | null = null
  if (existing) {
    const rebindSpin = spinner()
    rebindSpin.start(`Repointing project at "${safeCreatedName}"...`)
    // The workspace exists on the account that was in effect a moment ago, and
    // its id means nothing anywhere else. Rebinding under a different account
    // would point this project at whatever id collides there.
    if (account && !(await WorkspaceApi.sameAccount(account))) {
      rebindSpin.stop("Could not repoint the project.", 1)
      prompts.log.error(
        `The signed-in account changed while "${safeCreatedName}" was being created, so it was ` +
          `not linked to this project. The workspace exists on the previous account. Re-run ` +
          `\`altimate-code link\` to link this project on the account you are on now.`,
      )
      process.exitCode = 1
      return
    }
    try {
      const res = await rebindByMatchedIdentifier({
        identifier,
        targetDatamateId: created.datamate.id,
        expectedCurrentDatamateId: existing.datamate.id,
        matchedBy: existing.matchedBy,
      })
      reboundBinding = res.binding
      rebindSpin.stop(`Project is now linked to "${safeCreatedName}".`)
    } catch (err) {
      rebindSpin.stop("Could not repoint the project.", 1)
      prompts.log.error(
        `Workspace "${safeCreatedName}" was CREATED but could not be linked to this project. ${err instanceof Error ? err.message : String(err)} — re-run \`altimate-code link\` to retry (or delete the workspace in the SaaS).`,
      )
      process.exitCode = 1
      return
    }
  }
  // Prefer the canonicalized ``identifier.projectPath`` over the raw
  // ``--directory`` argument so ``altimate-code link -d ./myproj`` and its
  // symlink-resolved twin both write under the same cache key (Kilo cycle 6).
  // Whichever call last wrote the row is what gets cached. `createAndBind`
  // returns it directly; the unbound path gets it from the rebind. Caching the
  // local identifiers instead would record fields the server never stored — a
  // path-keyed row rebound through `/by-path` would be cached carrying a
  // `repo_remote` that is not on the server's row. (review, PR #1314)
  const serverBinding = created.via === "bound" ? created.binding : reboundBinding
  const seed = await recordApprovedBinding(identifier.projectPath ?? directory, {
    datamateId: created.datamate.id,
    datamateName: created.datamate.name,
    repoRemote: serverBinding?.repo_remote ?? identifier.repoRemote ?? null,
    projectPath: serverBinding?.project_path ?? identifier.projectPath ?? null,
    linkedAt: Date.now(),
  }, { awaitBackfill: true, account: linkAccount })
  prompts.log.info(seedMessage(seed))
  // The quick create is private, and the server hides a private workspace's link from
  // everyone else: a teammate who clones this repo is told it is unlinked.
  prompts.log.warn(QUICK_WORKSPACE_PRIVATE_NOTE)
  // ``createAndBind`` hands back a manage_url; the unbound create does not, so
  // derive it from credentials exactly as the rest of this file does. Null on
  // BYOK / unresolvable deployments — then there is simply nothing to show.
  const manageUrl = created.via === "bound" ? created.manage_url : await manageUrlFor(created.datamate.id)
  if (manageUrl) {
    prompts.log.info(`Manage it at: ${manageUrl}`)
    // Guard against a server that hands back a non-http(s) manage_url — ``open``
    // delegates to the OS handler, so a rogue value could launch an unrelated
    // application. Log a warning and skip the auto-open rather than trusting
    // whatever protocol the URL parses to.
    if (opts.openBrowser === false) {
      // printed above; nothing to open
    } else if (isSafeHttpUrl(manageUrl)) {
      await open(manageUrl).catch(() => undefined)
    } else {
      prompts.log.warn(`Skipped auto-open: manage_url is not an http/https URL.`)
    }
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
  /** The credential the picker's list was read as. The bind runs as it, and the seed refuses
   * (account-changed) if the configured account switches mid-way. */
  actAs: ActAs,
): Promise<void> {
  const linkAccount = credentialDigest(actAs.url, actAs.instance, actAs.apiKey)
  if ((await accountDigest()) !== linkAccount) {
    prompts.log.error("Your Altimate account changed since the list was loaded, so nothing was linked. Re-run `altimate-code link`.")
    process.exitCode = 1
    return
  }
  const isRebind = existing !== null
  const spin = spinner()
  spin.start(isRebind ? `Re-linking to workspace...` : `Linking to workspace...`)
  try {
    let res
    if (isRebind) {
      res = await rebindByMatchedIdentifier({
        identifier,
        targetDatamateId,
        expectedCurrentDatamateId: existing.datamate.id,
        matchedBy: existing.matchedBy,
        actAs,
      })
    } else {
      // No known binding OR pre-check failed. Try bindExisting first — if the
      // pre-check missed a real binding, the server will 409, and we retry as
      // rebind when we're allowed to. (m10)
      try {
        res = await WorkspaceApi.bindExisting(targetDatamateId, identifier, actAs)
      } catch (err) {
        // A teammate's private workspace is not a pre-check race: rebinding it only fails
        // again (forbidden), and would hide the explanation the outer handler gives.
        if (err instanceof ConflictError && !preCheckOk && !isHiddenBindingConflict(err)) {
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
          spin.stop("This project is already linked to a workspace — re-linking it instead.")
          const rebindSpin = spinner()
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
                actAs,
              })
            } else if (conflictRemote) {
              res = await WorkspaceApi.rebindByRemote({
                remote: conflictRemote,
                targetDatamateId,
                actAs,
              })
            } else {
              // Server didn't tell us which identifier owned the conflict —
              // fall back to the current identifier's preference (better than
              // nothing, but shouldn't happen with a well-formed 409 body).
              res = identifier.repoRemote
                ? await WorkspaceApi.rebindByRemote({
                    remote: identifier.repoRemote,
                    targetDatamateId,
                    actAs,
                  })
                : await WorkspaceApi.rebindByPath({
                    projectPath: identifier.projectPath!,
                    targetDatamateId,
                    actAs,
                  })
            }
            rebindSpin.stop(`Re-linked to "${stripControlChars(res.binding.datamate_name)}".`)
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
    const seed = await recordApprovedBinding(identifier.projectPath ?? directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    }, { awaitBackfill: true, account: linkAccount })
    const safeResName = stripControlChars(res.binding.datamate_name)
    spin.stop(isRebind ? `Re-linked to "${safeResName}".` : `Linked to "${safeResName}".`)
    prompts.log.info(seedMessage(seed))
    const manageUrl = await manageUrlFor(res.binding.datamate_id)
    if (manageUrl) prompts.log.info(`Manage it at: ${manageUrl}`)
    prompts.outro("Done.")
  } catch (err) {
    spin.stop(isRebind ? `Re-link failed.` : `Link failed.`, 1)
    if (isHiddenBindingConflict(err)) {
      prompts.log.error(HIDDEN_BINDING_MESSAGE)
    } else if (err instanceof ConflictError) {
      const existingName = conflictExistingName(err.detail)
      prompts.log.error(`Already linked to "${existingName}". Re-run \`altimate-code link\` to switch.`)
    } else if (err instanceof PreconditionFailedError) {
      prompts.log.error("Someone else re-linked this project — re-run and try again.")
    } else if (err instanceof NotFoundError) {
      prompts.log.error("That workspace, or this project's link to it, could not be found, or you no longer have access to it. Re-run and pick again.")
    } else if (err instanceof ForbiddenError) {
      prompts.log.error("Only the workspace owner can attach projects to it.")
    } else {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    process.exitCode = 1
  }
}

/** What `link` says about this machine's saved memory after the bind. A seed that left
 * blocks behind used to print the same line as one that stored everything. */
export function seedMessage(seed: SeedOutcome | null): string {
  if (seed?.status === "incomplete")
    return seed.pending > 0
      ? `${seed.pending} saved memor${seed.pending === 1 ? "y" : "ies"} did not reach the workspace yet. Run \`altimate-code workspace sync\` (or /workspace → Sync in the TUI) to retry.`
      : "Saved memory could not be sent to the workspace yet. Run `altimate-code workspace sync` (or /workspace → Sync in the TUI) to retry."
  if (seed?.status === "seeded")
    return seed.sent > 0
      ? `Sent ${seed.sent} saved memor${seed.sent === 1 ? "y" : "ies"} to the workspace.`
      : "Saved memory is in sync with the workspace."
  // `already` means the one-time bind seed ran before, not that every block is synced now.
  if (seed?.status === "already")
    return "This machine's saved memory was sent when this workspace was first linked. To resend anything missed since, run `altimate-code workspace sync` (or /workspace → Sync in the TUI)."
  if (seed?.status === "off") return "Workspace memory is off, so saved memory stays on this machine."
  if (seed?.status === "account-changed")
    return "Your Altimate account changed during linking, so saved memory was not sent. Run `altimate-code workspace sync` (or /workspace → Sync in the TUI) to retry."
  if (seed?.status === "local-off")
    return "Memory sync is turned off on this machine (ALTIMATE_DISABLE_MEMORY or OPENCODE_DISABLE_MEMORY), so saved memory stays here."
  // null: the seed could not run here (no resolvable credentials), which is not "off".
  return "Saved memory could not be checked against the workspace. Run `altimate-code workspace sync` (or /workspace → Sync in the TUI) to retry."
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
  actAs?: ActAs
}) {
  if (input.matchedBy === "remote" && input.identifier.repoRemote) {
    return WorkspaceApi.rebindByRemote({
      remote: input.identifier.repoRemote,
      targetDatamateId: input.targetDatamateId,
      expectedCurrentDatamateId: input.expectedCurrentDatamateId,
      actAs: input.actAs,
    })
  }
  if (input.matchedBy === "path" && input.identifier.projectPath) {
    return WorkspaceApi.rebindByPath({
      projectPath: input.identifier.projectPath,
      targetDatamateId: input.targetDatamateId,
      expectedCurrentDatamateId: input.expectedCurrentDatamateId,
      actAs: input.actAs,
    })
  }
  throw new Error(
    `Cannot re-link: the existing link was found by this project's ${input.matchedBy === "remote" ? "git remote" : "path"}, which the project no longer has.`,
  )
}

// altimate_change start — non-interactive link
/** clack's spinner redraws in place; without a terminal every frame lands on one line of a CI
 * log. Off a TTY, print the start and the outcome as plain lines instead. */
function spinner(): { start(msg?: string): void; stop(msg?: string, code?: number): void; message(msg?: string): void } {
  if (process.stdout.isTTY) return prompts.spinner()
  return {
    start: (msg) => msg && UI.println(msg),
    message: () => {},
    stop: (msg, code) => {
      if (!msg) return
      if (code) UI.error(msg)
      else UI.println(msg)
    },
  }
}

/** Exit code for a request the caller has to change, e.g. a re-link without --yes. */
const EXIT_USAGE = 2

/** The workspace `--workspace` names: by numeric id first, then by exact name (case-insensitive). */
export function matchWorkspace(
  list: DatamateRef[],
  wanted: string,
): { kind: "one"; workspace: DatamateRef } | { kind: "none" } | { kind: "many"; matches: DatamateRef[] } {
  const trimmed = wanted.trim()
  if (/^\d+$/.test(trimmed)) {
    const byId = list.find((dm) => dm.id === Number(trimmed))
    if (byId) return { kind: "one", workspace: byId }
  }
  const matches = list.filter((dm) => dm.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (matches.length === 1) return { kind: "one", workspace: matches[0] }
  if (matches.length > 1) return { kind: "many", matches }
  return { kind: "none" }
}

/** What `linkHeadless` needs from the service; replaced in tests so its guards can be checked without one. */
export interface LinkHeadlessDeps {
  isConfigured(): Promise<boolean>
  getBindingForProject(
    identifier: ProjectIdentifier,
    actAs: NonNullable<Awaited<ReturnType<typeof WorkspaceApi.captureCredentials>>>,
  ): Promise<ProjectBindingLookup | null>
  captureCredentials(): ReturnType<typeof WorkspaceApi.captureCredentials>
  /** Record on this machine that the user approved a link the service already has; no server call. */
  approve(identifier: ProjectIdentifier, existing: ProjectBindingLookup): Promise<void>
  listDatamates(actAs: NonNullable<Awaited<ReturnType<typeof WorkspaceApi.captureCredentials>>>): Promise<DatamateRef[]>
  bindOrRebind(
    identifier: ProjectIdentifier,
    datamateId: number,
    existing: ProjectBindingLookup | null,
    actAs: NonNullable<Awaited<ReturnType<typeof WorkspaceApi.captureCredentials>>>,
  ): Promise<void>
  create(identifier: ProjectIdentifier, name: string, existing: ProjectBindingLookup | null): Promise<void>
  print(line: string): void
  printError(line: string): void
}

export async function linkHeadless(
  args: { directory: string; workspace?: string; create?: string; yes: boolean; allowDuplicate?: boolean },
  deps: LinkHeadlessDeps = linkHeadlessDeps(args.directory),
): Promise<void> {
  if (args.workspace !== undefined && args.create !== undefined) {
    deps.printError("Use either --workspace or --create, not both.")
    process.exitCode = EXIT_USAGE
    return
  }
  if (args.workspace !== undefined && !args.workspace.trim()) {
    deps.printError("--workspace needs a workspace id or name.")
    process.exitCode = EXIT_USAGE
    return
  }
  if (!(await deps.isConfigured())) {
    deps.printError("Not signed in to Altimate. Run altimate-code, sign in, then re-run `altimate-code link`.")
    process.exitCode = EXIT_USAGE
    return
  }
  const identifier = resolveProjectIdentifier(args.directory)

  // Same rule as the picker: the pre-check, the list and the bind all run as one captured credential, so an
  // account switch in between cannot pair one tenant's link with another tenant's workspace ids.
  const actAs = await deps.captureCredentials()
  if (!actAs) {
    deps.printError("Could not read your Altimate credentials. Check /connect and try again.")
    process.exitCode = 1
    return
  }

  // Unlike the interactive picker, a failed pre-check stops here: the picker can
  // fall back to retrying a conflict as a re-link, which must not happen without
  // the caller having asked for it.
  let existing: ProjectBindingLookup | null
  try {
    existing = await deps.getBindingForProject(identifier, actAs)
  } catch (err) {
    deps.printError(
      `Could not check which workspace this project is linked to, so nothing was changed: ${stripControlChars(err instanceof Error ? err.message : String(err))}`,
    )
    process.exitCode = 1
    return
  }
  const currentName = existing ? stripControlChars(existing.datamate.name) : undefined

  // An explicit `link` for the workspace the service already has: record the user's approval here (a fresh clone
  // only knows the link as discovered, which `workspace sync` refuses), without a redundant server rebind.
  const alreadyLinked = async (lookup: ProjectBindingLookup): Promise<void> => {
    await deps.approve(identifier, lookup)
    deps.print(`Already linked to "${stripControlChars(lookup.datamate.name)}" — link confirmed on this machine.`)
  }

  // Re-running the same `link --create` (a devcontainer rebuild) finds the workspace it made last time; checked
  // before listing workspaces, so a rebuild does not depend on the list being available.
  const createName =
    args.create === undefined
      ? undefined
      : args.create.trim() ||
        (identifier.repoRemote ? projectNameFromRemote(identifier.repoRemote) : projectNameFromPath(identifier.projectPath))
  if (createName !== undefined && !args.allowDuplicate && existing && findNamesakes([existing.datamate], createName, undefined).all.length > 0) {
    await alreadyLinked(existing)
    return
  }

  let list: DatamateRef[]
  try {
    list = await deps.listDatamates(actAs)
  } catch (err) {
    deps.printError(`Could not load workspaces: ${stripControlChars(err instanceof Error ? err.message : String(err))}`)
    process.exitCode = 1
    return
  }

  if (createName !== undefined) {
    const name = createName
    if (existing && !args.yes) {
      deps.printError(`This project is already linked to "${currentName}". Pass --yes to create "${stripControlChars(name)}" and re-link to it.`)
      process.exitCode = EXIT_USAGE
      return
    }
    // The picker asks before creating a second workspace with a name in use; headless cannot ask, so it refuses.
    const twins = findNamesakes(list, name, undefined).all
    if (twins.length > 0 && !args.allowDuplicate) {
      const ids = twins.map((dm) => dm.id).join(", ")
      deps.printError(
        `A workspace named "${stripControlChars(name)}" already exists (id ${ids}). Link to it with --workspace ${twins[0].id}, ` +
          `or pass --allow-duplicate to create another.`,
      )
      process.exitCode = EXIT_USAGE
      return
    }
    await deps.create(identifier, name, existing)
    return
  }

  const match = matchWorkspace(list, args.workspace ?? "")
  if (match.kind === "none") {
    const names = list.map((dm) => `${stripControlChars(dm.name)} (id ${dm.id})`).join(", ")
    deps.printError(
      `No workspace named or numbered "${stripControlChars(args.workspace ?? "")}". ${names ? `Available: ${names}.` : "This account has no workspaces."}`,
    )
    process.exitCode = 1
    return
  }
  if (match.kind === "many") {
    const ids = match.matches.map((dm) => dm.id).join(", ")
    deps.printError(`More than one workspace is named "${stripControlChars(args.workspace ?? "")}" (ids ${ids}). Pass the id instead.`)
    process.exitCode = EXIT_USAGE
    return
  }
  const target = match.workspace
  if (existing?.datamate.id === target.id) {
    await alreadyLinked(existing)
    return
  }
  if (existing && !args.yes) {
    deps.printError(`This project is already linked to "${currentName}". Pass --yes to re-link it to "${stripControlChars(target.name)}".`)
    process.exitCode = EXIT_USAGE
    return
  }
  await deps.bindOrRebind(identifier, target.id, existing, actAs)
}

function linkHeadlessDeps(directory: string): LinkHeadlessDeps {
  return {
    isConfigured: () => AltimateApi.isConfigured(),
    getBindingForProject: (identifier, actAs) => WorkspaceApi.getBindingForProject(identifier, actAs),
    captureCredentials: () => WorkspaceApi.captureCredentials(),
    approve: async (identifier, existing) => {
      // Pinned to the account that confirmed the link: the record is refused if the account changed meanwhile.
      const account = await accountDigest()
      if (account === null) throw new Error("Could not read your Altimate credentials")
      const seed = await recordApprovedBinding(
        identifier.projectPath ?? directory,
        {
          datamateId: existing.datamate.id,
          datamateName: existing.datamate.name,
          repoRemote: existing.binding.repo_remote,
          projectPath: existing.binding.project_path ?? identifier.projectPath ?? null,
          linkedAt: Date.now(),
        },
        { awaitBackfill: true, account },
      )
      UI.println(seedMessage(seed))
    },
    listDatamates: (actAs) => WorkspaceApi.listDatamates(actAs),
    bindOrRebind: (identifier, datamateId, existing, actAs) => bindOrRebind(identifier, datamateId, existing, true, directory, actAs),
    create: (identifier, name, existing) => createThenBindOrRebind(identifier, name, directory, existing, { openBrowser: false }),
    print: (line) => UI.println(line),
    printError: (line) => UI.error(line),
  }
}
// altimate_change end

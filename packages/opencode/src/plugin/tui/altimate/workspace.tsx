// altimate_change start — fork TUI feature: Workspaces (pilot).
//
// Post-scan prompt to create or link a "Workspace" (server-side: a Datamate)
// to the current project, plus an on-demand "Link this project to a workspace"
// palette command. Server API lives in altimate-backend under
// /datamate-project-bindings/* (top-level router). Backend contract:
//
//   POST   /datamate-project-bindings/            create-and-bind (atomic)
//   POST   /datamate-project-bindings/bind        attach to existing workspace
//   PUT    /datamate-project-bindings/by-remote   atomic re-link (FOR UPDATE)
//   GET    /datamate-project-bindings/by-remote   server-authoritative lookup
//
// Fork-owned plugin per docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md.
// Registered by ./index.ts's altimateTuiPlugins() aggregator; upstream
// packages/tui is not touched. Uses `api.ui.*`, `api.keymap.registerLayer`,
// `api.state.path.directory`, `api.kv` (persistent) — the real TuiPluginApi
// surface, not a made-up one (see codex round-2 report for the history).
//
// Trigger: the /altimate-workspace.postScan command is dispatched by the
// existing onboarding-telemetry.ts plugin's `tool.execute.after` hook when
// `project_scan` completes AND `AltimateApi.isConfigured()` returns true AND
// `Flag.ALTIMATE_WORKSPACE` is on. Dispatch travels via the existing
// `TuiEvent.CommandExecute` event bus.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import open from "open"
import { createSignal, onCleanup, onMount } from "solid-js"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  WorkspaceApi,
  type DatamateRef,
  type MatchedIdentifier,
  type ProjectBindingLookup,
  type ProjectIdentifier,
} from "@/altimate/workspace/api-client"
import {
  openWorkspaceBrowserHandoff,
  resolveWorkspaceWebUrl,
  type HandoffResult,
} from "@/altimate/workspace/browser-handoff"
import {
  projectNameFromPath,
  projectNameFromRemote,
  resolveProjectIdentifier,
} from "@/altimate/workspace/detect"
import { readLocalBinding, recordApprovedBinding } from "@/altimate/workspace/state"
import {
  describeOffer,
  installCommand,
  installEngine,
  nodeMajor as detectNodeMajor,
  npmAvailable,
  MIN_NODE_MAJOR,
  OFFER_COMMAND,
  OFFER_SKIP_TTL_MS,
  type EngineOffer,
} from "@/altimate/workspace/engine-offer"
import { useClipboard } from "@opencode-ai/tui/context/clipboard"
import { AltimateApi } from "@/altimate/api/client"
import { Log } from "@/altimate/util/log"

const PLUGIN_ID = "altimate:workspace"

const log = Log.create({ service: "altimate-workspace" })

/** True when the browser-based workspace-creation handoff is available for
 * the current credentials (freemium only today). Wrapped so both the post-scan
 * flow and the on-demand `altimate-code link` picker can hide the option
 * consistently when the deployment isn't supported. */
async function isBrowserHandoffAvailable(): Promise<boolean> {
  // Both credential calls can throw (corrupt JSON, schema drift, unresolved
  // ``${env:...}`` reference). Callers use this in the sync arm of dialog
  // rendering, so an unhandled rejection would take the TUI down. Fail
  // closed — treat any credential error as "handoff unavailable". (CR cycle 6.)
  try {
    if (!(await AltimateApi.isConfigured().catch(() => false))) return false
    const creds = await AltimateApi.getCredentials()
    return resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName) !== null
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip latch (TUI-only). Uses TuiPluginApi.kv — persistent across sessions
// via packages/tui/src/context/kv.tsx (state/kv.json). The `altimate link`
// subcommand deliberately bypasses this latch (it's user-initiated).
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const KV_SKIP_PREFIX = "altimate.workspace.postScan.skip."

/** (tenant, apiUrl) scope for the Skip latch — matches the local binding
 * cache's top-level scoping. Without this a Skip in one Altimate account
 * suppresses the post-scan prompt for the same project in every other
 * account for 7 days. Sync-provided by the caller because ``recordSkip`` is
 * invoked inside the dialog's synchronous ``onSelect`` handler. Null means
 * "unscoped" (used only when credentials are unavailable). (cubic round 3.) */
export interface LatchScope {
  tenant: string
  apiUrl: string
}

/** Latch key from (tenant, apiUrl, primary identifier). Path-only projects
 * also get a latch — sample-scaffold users are still users. */
function skipKey(id: ProjectIdentifier, scope: LatchScope | null): string {
  const primary = id.repoRemote ?? id.projectPath ?? ""
  const scopeString = scope ? `${scope.tenant}|${scope.apiUrl}|` : ""
  return (
    KV_SKIP_PREFIX +
    createHash("sha1")
      .update(scopeString + primary)
      .digest("hex")
  )
}

function isSkipActive(
  api: TuiPluginApi,
  id: ProjectIdentifier,
  scope: LatchScope | null,
  nowMs: number,
): boolean {
  const rec = api.kv.get<{ skippedAt: number }>(skipKey(id, scope))
  if (!rec || typeof rec.skippedAt !== "number") return false
  // Reject records timestamped in the future — a system-clock rewind after
  // ``recordSkip`` would otherwise produce ``nowMs - rec.skippedAt < 0``,
  // trivially below the 7-day TTL, and suppress the prompt indefinitely.
  // Treat future timestamps as "corrupt, retry" so the next scan re-offers.
  // (CodeRabbit cycle 6.)
  const delta = nowMs - rec.skippedAt
  if (delta < 0) return false
  return delta < SKIP_TTL_MS
}

function recordSkip(
  api: TuiPluginApi,
  id: ProjectIdentifier,
  scope: LatchScope | null,
  nowMs: number,
): void {
  api.kv.set(skipKey(id, scope), { skippedAt: nowMs })
}

/** Best-effort ``LatchScope`` from the current CLI credentials. Returns null
 * on any credential failure — the latch then falls back to an unscoped key. */
async function currentLatchScope(): Promise<LatchScope | null> {
  try {
    if (!(await AltimateApi.isConfigured().catch(() => false))) return null
    const creds = await AltimateApi.getCredentials()
    return { tenant: creds.altimateInstanceName, apiUrl: creds.altimateUrl }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog components — deliberate three-way selects; no LLM-generated copy.
// Every dialog closes via `api.ui.dialog.clear()` when the user picks a
// terminal action, so onboarding is never blocked by a stuck workspace prompt.
// ─────────────────────────────────────────────────────────────────────────────

interface OfferProps {
  api: TuiPluginApi
  identifier: ProjectIdentifier
  defaultName: string
  /** True when this deployment supports the browser-based workspace-creation
   * handoff (i.e. ``resolveWorkspaceWebUrl`` returned non-null for the current
   * credentials). Resolved by the caller so the dialog doesn't need to await
   * on mount. When false, the "Set up in browser" option is hidden and the
   * dialog falls back to the pre-browser-handoff behavior. */
  browserAvailable: boolean
  /** (tenant, apiUrl) scope for the Skip latch. Resolved once by the caller
   * so the sync ``onSelect`` handler can call ``recordSkip`` without a
   * mid-render await. Null when creds are unavailable — latch falls back
   * to unscoped. (cubic round 3.) */
  latchScope: LatchScope | null
}

function OfferDialog(props: OfferProps) {
  const identLabel = () => props.identifier.repoRemote ?? props.identifier.projectPath ?? "this project"
  const options = [
    ...(props.browserAvailable
      ? [
          {
            title: "Set up in browser (recommended)",
            value: "browser",
            description: `Approve and name "${props.defaultName}" in the Altimate SaaS; the CLI links your project automatically.`,
          },
        ]
      : []),
    {
      title: "Create quick workspace here",
      value: "create",
      description: `Auto-named "${props.defaultName}" from this repo — no browser step. Configure integrations later in the SaaS.`,
    },
    {
      title: "Link to an existing workspace",
      value: "link",
      description: "Attach this project to a workspace you already own.",
    },
    {
      title: "Skip for now",
      value: "skip",
      description: "Won't ask again for 7 days.",
    },
  ]
  const defaultValue = props.browserAvailable ? "browser" : "create"
  return (
    <props.api.ui.DialogSelect
      title={`Set up a workspace for this project? (${identLabel()})`}
      options={options}
      current={defaultValue}
      onSelect={(option) => {
        if (option.value === "skip") {
          recordSkip(props.api, props.identifier, props.latchScope, Date.now())
          props.api.ui.dialog.clear()
          return
        }
        if (option.value === "browser") {
          void runBrowserHandoff(props.api, props.identifier, props.defaultName)
          return
        }
        if (option.value === "create") {
          // Local direct-create — the CLI-only fallback. The SaaS UI is the
          // place to rename / configure; this branch establishes the binding
          // without a browser round-trip.
          void createAndBindInline(props.api, props.identifier, props.defaultName)
          return
        }
        // link → picker (fresh-project attach path)
        props.api.ui.dialog.replace(() => (
          <PickerDialog api={props.api} identifier={props.identifier} mode="attach" />
        ))
      }}
    />
  )
}

/** Build the SaaS manage-workspace URL for a bound workspace. Deterministic
 * from tenant + id, so any caller can construct it without an extra round-trip.
 * Returns null when the current deployment isn't the freemium web (BYOK or
 * unresolvable) — the confirmation dialog degrades to id-only in that case. */
async function buildManageUrl(workspaceId: number): Promise<string | null> {
  try {
    const creds = await AltimateApi.getCredentials()
    const base = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    if (!base) return null
    return `${base.toString().replace(/\/$/, "")}/w/${workspaceId}`
  } catch {
    return null
  }
}

interface LinkedProps {
  api: TuiPluginApi
  workspaceName: string
  manageUrl: string | null
  /** Verb for the title — "Linked" / "Re-linked" / "Created". Keeps the
   * three success paths visually consistent while still labelling what
   * just happened. */
  verb: "Linked" | "Re-linked" | "Created"
}

/** Persistent confirmation card shown after a successful bind. Replaces the
 * transient success toast so the user has an unmissable "yes, it worked" and
 * a stable CTA back to the browser. Dismissable via Done or Esc. */
function WorkspaceLinkedDialog(props: LinkedProps) {
  const title = () => {
    const suffix = props.manageUrl ? ` — ${props.manageUrl}` : ""
    // DialogSelect doesn't take a top-level description block, so the
    // memory-sync disclosure is packed into the title, matching the
    // AlreadyLinkedDialog convention above.
    return `${props.verb} workspace "${props.workspaceName}"${suffix} — Saved memory blocks will sync to this workspace if memory is enabled for it.`
  }
  const options = () => {
    if (props.manageUrl) {
      return [
        {
          title: "Continue editing in browser",
          value: "open",
          description: "Open the workspace in your browser.",
        },
        { title: "Done", value: "done", description: "Close this dialog." },
      ]
    }
    return [{ title: "Done", value: "done", description: "Close this dialog." }]
  }
  return (
    <props.api.ui.DialogSelect
      title={title()}
      options={options()}
      current={props.manageUrl ? "open" : "done"}
      onSelect={(option) => {
        if (option.value === "open" && props.manageUrl) {
          const url = props.manageUrl
          // Guard before delegating to open() — a rogue manage_url with a
          // non-http protocol would otherwise dispatch to an unrelated OS
          // scheme handler. buildManageUrl only ever emits http(s) URLs from
          // resolveWorkspaceWebUrl, but the guard survives future changes.
          if (!isSafeHttpUrl(url)) {
            props.api.ui.toast({
              variant: "warning",
              message: `Refused to open a non-http URL: ${url}`,
              duration: 15_000,
            })
          } else {
            open(url).catch(() => {
              props.api.ui.toast({
                variant: "warning",
                message: `Could not open browser. Copy this URL: ${url}`,
                duration: 15_000,
              })
            })
          }
        }
        props.api.ui.dialog.clear()
      }}
    />
  )
}

/** Show the persistent linked-confirmation dialog. Builds the manage URL
 * best-effort; degrades gracefully on BYOK/unresolvable. */
async function showLinkedConfirmation(
  api: TuiPluginApi,
  verb: LinkedProps["verb"],
  workspaceId: number,
  workspaceName: string,
): Promise<void> {
  const manageUrl = await buildManageUrl(workspaceId)
  api.ui.dialog.replace(() => (
    <WorkspaceLinkedDialog api={api} workspaceName={workspaceName} manageUrl={manageUrl} verb={verb} />
  ))
}

/** Held across ``runBrowserHandoff`` invocations so a second handoff can
 * supersede a still-open first one — otherwise the first loopback listener
 * stays bound for its full 15-minute callback window and the second flow
 * walks past its port. (coderabbitai #1100 review 5005112438.) */
let activeHandoffAbort: AbortController | null = null

/** Post-scan / on-demand browser-handoff runner. Opens the SaaS approval
 * modal, waits for the callback, and binds the current project to the
 * returned workspace via the existing ``POST /bind`` endpoint. Every failure
 * mode surfaces as a toast; the user can always fall back to another option
 * by re-invoking the dialog. */
async function runBrowserHandoff(
  api: TuiPluginApi,
  identifier: ProjectIdentifier,
  projectName: string,
): Promise<void> {
  api.ui.dialog.clear()
  api.ui.toast({
    variant: "info",
    message:
      "Opening browser to set up your workspace (up to 15 min) — approve there, then check back here for the confirmation.",
  })
  // Supersede any still-open handoff before starting a new one.
  if (activeHandoffAbort) activeHandoffAbort.abort()
  activeHandoffAbort = new AbortController()
  const signal = activeHandoffAbort.signal
  const result: HandoffResult = await openWorkspaceBrowserHandoff({ identifier, projectName, signal })
  if (!result.ok) {
    // A superseded handoff (``activeHandoffAbort.abort()`` above, fired when
    // the user re-triggers the flow) settles as ``reason: "aborted"``. That
    // is not a failure the user caused, and the newer flow already emitted
    // its "Opening browser..." toast — surfacing a red "Handoff aborted"
    // on top would look like the second attempt failed. Silent return.
    // (kilo-code-bot #1100 comment 3841282737.)
    if (result.reason === "aborted") return
    toastHandoffFailure(api, result)
    return
  }
  // M6 in the consensus review: the browser window can stay open for up to
  // 15 minutes. If the user signs out or switches tenant mid-flow, the
  // WorkspaceApi client re-reads credentials on every call — so a callback
  // validated for tenant A would then bind under tenant B, and workspace
  // ids are tenant-schema-local (same integer, different workspace). Compare
  // the credential fingerprint the handoff was validated against with the
  // credentials we're about to bind under, and refuse if either drifted.
  try {
    const fresh = await AltimateApi.getCredentials()
    if (
      fresh.altimateInstanceName !== result.credentials.tenant ||
      fresh.altimateUrl !== result.credentials.apiUrl
    ) {
      api.ui.toast({
        variant: "error",
        message: `Your Altimate credentials changed while the browser was open (was ${result.credentials.tenant}, now ${fresh.altimateInstanceName}). Re-run to link this project.`,
        duration: 15_000,
      })
      return
    }
  } catch {
    api.ui.toast({
      variant: "error",
      message: "Lost Altimate credentials while the browser was open — sign in and re-run.",
    })
    return
  }
  // Handoff succeeded and credentials are still consistent — bind the project
  // to the returned workspace via the existing bind endpoint. Same code path
  // as PickerDialog's attach mode.
  try {
    const res = await WorkspaceApi.bindExisting(result.workspaceId, identifier)
    await recordApprovedBinding(api.state.path.directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    await showLinkedConfirmation(api, "Linked", res.binding.datamate_id, res.binding.datamate_name)
  } catch (err) {
    if (err instanceof ConflictError) {
      api.ui.toast({
        variant: "warning",
        message: `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Run \`altimate-code link\` to change.`,
      })
    } else if (err instanceof NotFoundError) {
      api.ui.toast({
        variant: "error",
        message: "Workspace not found — the tenant or workspace may have changed. Try again.",
      })
    } else if (err instanceof ForbiddenError) {
      api.ui.toast({
        variant: "error",
        message: "Only the workspace owner can bind projects to it.",
      })
    } else {
      api.ui.toast({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to bind workspace",
      })
    }
  }
}

function toastHandoffFailure(api: TuiPluginApi, result: Extract<HandoffResult, { ok: false }>): void {
  switch (result.reason) {
    case "unavailable":
      // Should not happen if browserAvailable was checked, but guard anyway.
      api.ui.toast({
        variant: "warning",
        message: "Browser-based workspace setup isn't available for this deployment. Use \"Create quick workspace here\" instead.",
      })
      break
    case "not_configured":
      api.ui.toast({
        variant: "error",
        message: "Altimate credentials not configured — sign in first, then re-run.",
      })
      break
    case "timeout":
      api.ui.toast({
        variant: "warning",
        message: "Workspace setup timed out (15 min). Re-run when you're ready.",
      })
      break
    case "cancelled":
      api.ui.toast({
        variant: "info",
        message: "Workspace setup cancelled.",
      })
      break
    case "tenant_mismatch":
      api.ui.toast({
        variant: "error",
        message: result.message ?? "Workspace was set up under a different account than the CLI is signed into.",
      })
      break
    case "port_exhausted":
      api.ui.toast({
        variant: "error",
        message: result.message ?? "Local ports 7317-7325 all in use — free one and try again.",
      })
      break
    case "browser_open_failed":
      api.ui.toast({
        variant: "error",
        message: `Could not open browser. ${result.authorizeUrl ? `Open this URL manually: ${result.authorizeUrl}` : ""}`,
        duration: 15_000,
      })
      break
    default:
      api.ui.toast({
        variant: "error",
        message: result.message ?? "Workspace setup failed.",
      })
  }
}

async function createAndBindInline(
  api: TuiPluginApi,
  identifier: ProjectIdentifier,
  name: string,
  /** When present, this project is already bound to another workspace.
   * createAndBind succeeds but leaves the binding pointing at the OLD
   * workspace; without this rebind step the new workspace is an orphaned
   * (billable) SaaS resource the CLI knows nothing about (M2). */
  rebindFrom?: { expectedCurrentDatamateId: number; matchedBy: MatchedIdentifier },
): Promise<void> {
  api.ui.dialog.clear()
  let res: Awaited<ReturnType<typeof WorkspaceApi.createAndBind>>
  try {
    res = await WorkspaceApi.createAndBind({ name, identifier })
  } catch (err) {
    if (err instanceof ConflictError) {
      api.ui.toast({
        variant: "warning",
        message: `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Use the palette's "Link this project to a workspace" to change.`,
      })
    } else {
      api.ui.toast({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to create workspace",
      })
    }
    return
  }

  if (rebindFrom) {
    // The atomic create-and-bind wrote a NEW binding for the new workspace,
    // but the existing binding for THIS project's remote/path still points
    // at the old workspace. Repoint via the matched-identifier rebind
    // endpoint. If rebind fails, tell the user the workspace exists but
    // the link didn't switch — do not silently orphan.
    try {
      await rebindByMatchedIdentifier({
        identifier,
        targetDatamateId: res.datamate.id,
        expectedCurrentDatamateId: rebindFrom.expectedCurrentDatamateId,
        matchedBy: rebindFrom.matchedBy,
      })
    } catch (err) {
      api.ui.toast({
        variant: "error",
        message: `Workspace "${res.datamate.name}" was CREATED but could not be linked to this project (${err instanceof Error ? err.message : String(err)}). Run \`altimate-code link\` to retry.`,
        duration: 15_000,
      })
      return
    }
  }

  // Post-success tail — this function is invoked fire-and-forget
  // (``void createAndBindInline(...)``), so a bare rejection here would
  // surface as an unhandled promise and terminate the TUI. Contain the
  // fallout inside the function itself. ``recordApprovedBinding`` already
  // swallows its own errors (state.ts is best-effort), but
  // ``showLinkedConfirmation`` can reject on dialog-teardown races — the
  // toast fallback keeps the user informed without taking the process down.
  // (Kilo cycle 5.)
  try {
    await recordApprovedBinding(api.state.path.directory, {
      datamateId: res.datamate.id,
      datamateName: res.datamate.name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    await showLinkedConfirmation(api, "Created", res.datamate.id, res.datamate.name)
  } catch (err) {
    // Log the failure so a regression in ``showLinkedConfirmation`` doesn't
    // vanish silently, then fall back to a plain toast. Previously ``void err``
    // discarded the diagnostic — Kilo cycle 6 called it out.
    log.warn("workspace post-create confirmation failed", { err: String(err) })
    api.ui.toast({
      variant: "info",
      message: `Workspace "${res.datamate.name}" created and linked.`,
    })
  }
}

/** True when the URL parses and its protocol is exactly ``http:`` or ``https:``.
 * Used before handing a server-supplied URL to ``open()`` (which would otherwise
 * dispatch to whatever OS scheme handler matches the protocol). Kept exported
 * as a top-level helper because both ``showLinkedConfirmation`` (below) and
 * the on-demand link paths need the same guard. */
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/** Pick the rebind endpoint that matches which identifier the pre-check
 * resolved the binding on. Shared with cli/cmd/link.ts through duplicated
 * code (M3) — the modules deliberately don't cross-import so the CLI
 * subcommand stays self-contained. */
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
    `Cannot rebind — pre-check matched on ${input.matchedBy} but that field is not present on the current project identifier.`,
  )
}

interface AlreadyLinkedProps {
  api: TuiPluginApi
  identifier: ProjectIdentifier
  workspaceName: string
  workspaceId: number
  hasDrift: boolean
  driftedWas?: string | null
  unverified?: boolean
  /** Which identifier arm resolved the binding — remote-matched projects
   * rebind via ``/by-remote``, path-matched via ``/by-path``. Not the same
   * as ``identifier.repoRemote`` / ``identifier.projectPath``, which reflect
   * the CURRENT project, not the binding's origin. Threaded into PickerDialog
   * so a re-link picks the correct endpoint. (M3) */
  matchedBy: MatchedIdentifier
}

function AlreadyLinkedDialog(props: AlreadyLinkedProps) {
  // Title carries the primary context (workspace name + drift/unverified hint)
  // since DialogSelect doesn't take a top-level description block. Verbose but
  // it puts the critical info in the user's field of view before they pick.
  const title = () => {
    const parts: string[] = [`Project is linked to workspace "${props.workspaceName}"`]
    const now = props.identifier.repoRemote ?? props.identifier.projectPath
    if (props.hasDrift && props.driftedWas) parts.push(`(was ${props.driftedWas}, now ${now})`)
    if (props.unverified) parts.push("(⚠ unverified — server unreachable, showing cached value)")
    return parts.join(" ")
  }
  return (
    <props.api.ui.DialogSelect
      title={title()}
      options={[
        {
          title: "Attach and continue",
          value: "attach",
          description: "Use this workspace for the session.",
        },
        {
          title: "Re-link to a different workspace",
          value: "relink",
          description: "Swap this project's workspace.",
        },
        {
          title: "Skip for now",
          value: "skip",
          description: "Close this prompt without changing the link.",
        },
      ]}
      current={props.hasDrift ? "relink" : "attach"}
      onSelect={(option) => {
        if (option.value === "attach" || option.value === "skip") {
          props.api.ui.dialog.clear()
          return
        }
        // relink → picker with the current workspace id as expected_current so
        // a concurrent re-link by another client 412s cleanly. matchedBy
        // determines which rebind endpoint the picker will call (M3).
        props.api.ui.dialog.replace(() => (
          <PickerDialog
            api={props.api}
            identifier={props.identifier}
            mode="relink"
            expectedCurrentDatamateId={props.workspaceId}
            matchedBy={props.matchedBy}
          />
        ))
      }}
    />
  )
}

interface PickerProps {
  api: TuiPluginApi
  identifier: ProjectIdentifier
  mode: "attach" | "relink"
  expectedCurrentDatamateId?: number
  /** Set for ``mode: "relink"`` — which identifier arm the pre-check matched
   * on so we pick the correct rebind endpoint. (M3) */
  matchedBy?: MatchedIdentifier
}

function PickerDialog(props: PickerProps) {
  const [datamates, setDatamates] = createSignal<DatamateRef[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  // DialogSelect delivers ``onSelect`` synchronously per Enter keypress, but
  // ``pick()`` awaits the network round-trip — a second Enter before the
  // first bind resolves would fire a duplicate ``bindExisting`` /
  // ``rebindBy…`` against a project that may already be bound by the first
  // call. The second call typically 409s, but the toast then contradicts the
  // success toast the first call is about to render. Latch on the first
  // in-flight ``pick()``. (kilo cycle 6.)
  let submitting = false

  onMount(async () => {
    try {
      const list = await WorkspaceApi.listDatamates()
      setDatamates(list)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load workspaces"
      setLoadError(msg)
      props.api.ui.toast({ variant: "error", message: msg })
      props.api.ui.dialog.clear()
    }
  })

  async function pick(datamateId: number) {
    if (submitting) return
    submitting = true
    try {
      if (props.mode === "attach") {
        const res = await WorkspaceApi.bindExisting(datamateId, props.identifier)
        await recordApprovedBinding(props.api.state.path.directory, {
          datamateId: res.binding.datamate_id,
          datamateName: res.binding.datamate_name,
          repoRemote: res.binding.repo_remote,
          projectPath: res.binding.project_path,
          linkedAt: Date.now(),
        })
        await showLinkedConfirmation(
          props.api,
          "Linked",
          res.binding.datamate_id,
          res.binding.datamate_name,
        )
        return
      } else {
        // Rebind: pick the endpoint that matches which identifier the
        // pre-check RESOLVED the binding on — not what the current identifier
        // happens to carry. A repo whose remote was renamed still has its
        // binding under its path; rebindByRemote against the new remote would
        // 404 with no repair path from the TUI. (M3)
        if (!props.matchedBy || !props.expectedCurrentDatamateId) {
          throw new Error("relink picker opened without matchedBy / expectedCurrentDatamateId")
        }
        const res = await rebindByMatchedIdentifier({
          identifier: props.identifier,
          targetDatamateId: datamateId,
          expectedCurrentDatamateId: props.expectedCurrentDatamateId,
          matchedBy: props.matchedBy,
        })
        await recordApprovedBinding(props.api.state.path.directory, {
          datamateId: res.binding.datamate_id,
          datamateName: res.binding.datamate_name,
          repoRemote: res.binding.repo_remote,
          projectPath: res.binding.project_path,
          linkedAt: Date.now(),
        })
        await showLinkedConfirmation(
          props.api,
          "Re-linked",
          res.binding.datamate_id,
          res.binding.datamate_name,
        )
        return
      }
    } catch (err) {
      // Surface as a toast so the user sees the specific failure. Dialog
      // closes either way — the palette command ``altimate.workspace.link``
      // (or re-running ``altimate-code link``) re-enters the flow, so the
      // user always has a way to try again from a clean slate.
      let msg: string
      if (err instanceof ConflictError) {
        // The picker doesn't have a "Re-link" option; the referral used to
        // point at OfferDialog's Re-link, which doesn't exist either. Point
        // at the concrete next action instead. (kilo cycle 6.)
        msg = `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Re-run \`altimate-code link\` to change the workspace.`
      } else if (err instanceof PreconditionFailedError) {
        msg = "Someone else re-linked this project — reload and try again."
      } else if (err instanceof NotFoundError) {
        msg = "No existing binding for this remote to re-link. Re-run `altimate-code link` and pick Create."
      } else if (err instanceof ForbiddenError) {
        msg = "Only the workspace owner can attach projects to it."
      } else {
        msg = err instanceof Error ? err.message : "Failed to link workspace"
      }
      props.api.ui.toast({ variant: "error", message: msg })
      props.api.ui.dialog.clear()
    } finally {
      submitting = false
    }
  }

  // While loading (or on error before dialog closes), render a placeholder
  // row the user can dismiss with Enter. NOTE: DialogSelect's ``filtered()``
  // drops rows with ``disabled: true`` (packages/tui/src/ui/dialog-select.tsx),
  // so the placeholder MUST be rendered without that flag — otherwise the
  // picker shows an empty list, hiding both the loading state and the
  // "no workspaces yet" hint. Selection is dispatched to ``value === -1``
  // in ``onSelect`` below and simply clears the dialog. (Kilo cycle 6.)
  const options = () => {
    const list = datamates()
    if (!list) return [{ title: "Loading workspaces...", value: -1 }]
    if (list.length === 0)
      return [
        {
          title: "No workspaces yet — cancel and pick 'Create a new workspace' instead.",
          value: -1,
        },
      ]
    return list.map((dm: DatamateRef) => ({ title: dm.name, value: dm.id }))
  }

  return (
    <props.api.ui.DialogSelect<number>
      title={props.mode === "attach" ? "Link to workspace" : "Re-link to workspace"}
      options={options()}
      onSelect={(option) => {
        if (option.value === -1) {
          props.api.ui.dialog.clear()
          return
        }
        void pick(option.value)
      }}
    />
  )
}

// Sentinel value for the "＋ Create a new workspace" row in the on-demand
// picker. Negative so it can't collide with any real datamate id (SERIAL PK).
const CREATE_NEW_SENTINEL = -2

interface OnDemandPickerProps {
  api: TuiPluginApi
  identifier: ProjectIdentifier
  currentlyLinkedDatamateId?: number
  currentlyLinkedDatamateName?: string
  /** Which identifier arm the pre-check matched on. Required to pick the
   * correct rebind endpoint when the user swaps workspaces or picks Create
   * on an already-linked project. (M3) */
  matchedBy?: MatchedIdentifier
  defaultName: string
}

/** Picker-first flow for the on-demand `altimate.workspace.link` command.
 *
 * Skips the Create/Link/Skip funnel — the user already opted in by invoking
 * the palette. Immediately lists workspaces; currently-linked one is marked;
 * "＋ Create a new workspace" is the first row. No Skip option (user chose to
 * be here). Auto-names any new workspace from the git repo. */
function OnDemandPickerDialog(props: OnDemandPickerProps) {
  const [datamates, setDatamates] = createSignal<DatamateRef[] | null>(null)

  onMount(async () => {
    try {
      const list = await WorkspaceApi.listDatamates()
      setDatamates(list)
    } catch (err) {
      props.api.ui.toast({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to load workspaces",
      })
      props.api.ui.dialog.clear()
    }
  })

  const options = () => {
    const list = datamates()
    // No ``disabled: true`` — DialogSelect filters those out (Kilo cycle 6).
    if (!list) return [{ title: "Loading workspaces...", value: -1 }]
    // Deliberately short titles + hint in description so the dialog's narrow
    // width doesn't truncate either. The "●" marker stays in the title (single
    // char, cheap) so the currently-linked row is scannable at a glance.
    return [
      {
        title: "＋ Create a new workspace",
        value: CREATE_NEW_SENTINEL,
        description: `Auto-named "${props.defaultName}" from this repo — rename in the SaaS.`,
      },
      ...list.map((dm) => ({
        title: dm.id === props.currentlyLinkedDatamateId ? `● ${dm.name}` : `  ${dm.name}`,
        value: dm.id,
        description: dm.id === props.currentlyLinkedDatamateId ? "currently linked to this project" : undefined,
      })),
    ]
  }

  return (
    <props.api.ui.DialogSelect<number>
      title="Link this project to a workspace"
      options={options()}
      current={props.currentlyLinkedDatamateId ?? CREATE_NEW_SENTINEL}
      onSelect={(option) => {
        if (option.value === -1) {
          props.api.ui.dialog.clear()
          return
        }
        if (option.value === CREATE_NEW_SENTINEL) {
          // If already linked, thread the pre-check outcome so createAndBind
          // is followed by a rebind — otherwise the new workspace is a real
          // (billable) SaaS resource left orphaned while the project is
          // still bound to the OLD workspace. (M2)
          const rebindFrom =
            props.currentlyLinkedDatamateId !== undefined && props.matchedBy
              ? {
                  expectedCurrentDatamateId: props.currentlyLinkedDatamateId,
                  matchedBy: props.matchedBy,
                }
              : undefined
          void createAndBindInline(props.api, props.identifier, props.defaultName, rebindFrom)
          return
        }
        // Picked an existing workspace.
        if (option.value === props.currentlyLinkedDatamateId) {
          // No-op — user picked the workspace this project is already linked to.
          props.api.ui.toast({
            variant: "info",
            message: `Already linked to "${props.currentlyLinkedDatamateName}" — nothing changed.`,
          })
          props.api.ui.dialog.clear()
          return
        }
        const existing =
          props.currentlyLinkedDatamateId !== undefined && props.matchedBy
            ? { datamateId: props.currentlyLinkedDatamateId, matchedBy: props.matchedBy }
            : undefined
        void bindOrRebindInline(props.api, props.identifier, option.value, existing)
      }}
    />
  )
}

async function bindOrRebindInline(
  api: TuiPluginApi,
  identifier: ProjectIdentifier,
  targetDatamateId: number,
  /** Pre-check outcome. Absent means "not linked / pre-check missed" and
   * we call bindExisting; present means "linked" and we rebind via the
   * matched-identifier endpoint (M3). */
  existing: { datamateId: number; matchedBy: MatchedIdentifier } | undefined,
): Promise<void> {
  api.ui.dialog.clear()
  const isRebind = existing !== undefined
  try {
    const res = await (async () => {
      if (existing) {
        return rebindByMatchedIdentifier({
          identifier,
          targetDatamateId,
          expectedCurrentDatamateId: existing.datamateId,
          matchedBy: existing.matchedBy,
        })
      }
      return WorkspaceApi.bindExisting(targetDatamateId, identifier)
    })()
    await recordApprovedBinding(api.state.path.directory, {
      datamateId: res.binding.datamate_id,
      datamateName: res.binding.datamate_name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    await showLinkedConfirmation(
      api,
      isRebind ? "Re-linked" : "Linked",
      res.binding.datamate_id,
      res.binding.datamate_name,
    )
  } catch (err) {
    let msg: string
    if (err instanceof ConflictError) {
      msg = `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}".`
    } else if (err instanceof PreconditionFailedError) {
      msg = "Someone else re-linked this project — reload and try again."
    } else if (err instanceof NotFoundError) {
      msg = "No existing binding to re-link. Try again."
    } else if (err instanceof ForbiddenError) {
      msg = "Only the workspace owner can attach projects to it."
    } else {
      msg = err instanceof Error ? err.message : "Failed to link workspace"
    }
    api.ui.toast({ variant: "error", message: msg })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow orchestrators.
//
// `runFlow` — the post-scan trigger flow. Three-way Create/Link/Skip funnel
// for a user we're prompting FROM ZERO (they haven't opted in). Skip is a
// first-class outcome; Create branch auto-names.
//
// `runOnDemandPicker` — the palette / `/altimate.workspace.link` flow. User
// already opted in by invoking, so no Skip. Fetches the workspace list +
// pre-check binding, opens the picker with the currently-linked one marked.
// ─────────────────────────────────────────────────────────────────────────────

async function runOnDemandPicker(api: TuiPluginApi, directory: string): Promise<void> {
  const identifier = resolveProjectIdentifier(directory)
  // Pre-check for the currently-linked marker. Failures are non-fatal — we
  // still show the picker without the "(currently linked here)" annotation.
  let existing: ProjectBindingLookup | null = null
  try {
    existing = await WorkspaceApi.getBindingForProject(identifier)
  } catch (err) {
    log.warn("on-demand picker pre-check failed", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  const defaultName = identifier.repoRemote
    ? projectNameFromRemote(identifier.repoRemote)
    : projectNameFromPath(identifier.projectPath)
  api.ui.dialog.replace(() => (
    <OnDemandPickerDialog
      api={api}
      identifier={identifier}
      currentlyLinkedDatamateId={existing?.datamate.id}
      currentlyLinkedDatamateName={existing?.datamate.name}
      matchedBy={existing?.matchedBy}
      defaultName={defaultName}
    />
  ))
}

async function runFlow(api: TuiPluginApi, directory: string): Promise<void> {
  const identifier = resolveProjectIdentifier(directory)
  // Resolve latch scope ONCE — passed to isSkipActive here + threaded into
  // OfferDialog so its sync onSelect can call recordSkip without awaiting.
  // (cubic round 3.)
  const latchScope = await currentLatchScope()
  // Path is always populated by resolveProjectIdentifier — projects without a
  // git remote (sample dbt scaffolds, scratch dirs) still get a binding offer.
  if (isSkipActive(api, identifier, latchScope, Date.now())) {
    log.info("workspace prompt suppressed by 7-day Skip latch", {
      identifier: identifier.repoRemote ?? identifier.projectPath,
    })
    return
  }

  const defaultName = identifier.repoRemote
    ? projectNameFromRemote(identifier.repoRemote)
    : projectNameFromPath(identifier.projectPath)

  // Whether the browser-based handoff is available for this deployment. The
  // OfferDialog hides the "Set up in browser" option when false, silently
  // falling back to the pre-browser-handoff behavior. Compute here (once,
  // async) so the dialog itself stays sync.
  const browserAvailable = await isBrowserHandoffAvailable()

  let serverBinding: ProjectBindingLookup | null | undefined
  try {
    serverBinding = await WorkspaceApi.getBindingForProject(identifier)
  } catch (err) {
    log.warn("workspace pre-check server call failed, falling back to local cache", {
      err: err instanceof Error ? err.message : String(err),
    })
    serverBinding = undefined
  }

  if (serverBinding) {
    // Warm the local cache so an offline follow-up render is consistent.
    await recordApprovedBinding(directory, {
      datamateId: serverBinding.datamate.id,
      datamateName: serverBinding.datamate.name,
      repoRemote: serverBinding.binding.repo_remote,
      projectPath: serverBinding.binding.project_path,
      linkedAt: Date.now(),
    })
    // Drift = the identifier the server matched on doesn't equal the
    // corresponding identifier this project currently has. E.g. we matched
    // on remote but the current remote differs from what the binding
    // stored — the repo was renamed / remote swapped. The dialog surfaces
    // this so the user isn't silently attached to a stale binding. (M3)
    const boundIdent =
      serverBinding.matchedBy === "remote"
        ? serverBinding.binding.repo_remote
        : serverBinding.binding.project_path
    const currentIdent =
      serverBinding.matchedBy === "remote" ? identifier.repoRemote : identifier.projectPath
    const hasDrift = boundIdent != null && currentIdent != null && boundIdent !== currentIdent
    api.ui.dialog.replace(() => (
      <AlreadyLinkedDialog
        api={api}
        identifier={identifier}
        workspaceName={serverBinding!.datamate.name}
        workspaceId={serverBinding!.datamate.id}
        matchedBy={serverBinding!.matchedBy}
        hasDrift={hasDrift}
        driftedWas={hasDrift ? boundIdent : undefined}
      />
    ))
    return
  }

  if (serverBinding === null) {
    // Server confirmed unbound → offer create-or-link.
    api.ui.dialog.replace(() => (
      <OfferDialog
        api={api}
        identifier={identifier}
        defaultName={defaultName}
        browserAvailable={browserAvailable}
        latchScope={latchScope}
      />
    ))
    return
  }

  // Server unreachable — fall back to the local cache (marked as unverified).
  const local = await readLocalBinding(directory)
  if (local) {
    // Prefer whichever identifier the cache remembers as populated. Same
    // ordering as the server-side pre-check: remote first, path fallback.
    const cachedMatchedBy: MatchedIdentifier = local.repoRemote ? "remote" : "path"
    const cachedIdent = local.repoRemote ?? local.projectPath ?? ""
    const currentIdent =
      cachedMatchedBy === "remote" ? identifier.repoRemote : identifier.projectPath
    const hasDrift = cachedIdent !== "" && currentIdent != null && cachedIdent !== currentIdent
    api.ui.dialog.replace(() => (
      <AlreadyLinkedDialog
        api={api}
        identifier={identifier}
        workspaceName={local.datamateName}
        workspaceId={local.datamateId}
        matchedBy={cachedMatchedBy}
        hasDrift={hasDrift}
        driftedWas={hasDrift ? cachedIdent : undefined}
        unverified
      />
    ))
    return
  }
  // No local cache either → offer, but flag the server-unreachable state so the
  // user can decide whether to proceed.
  api.ui.toast({
    variant: "warning",
    message: "Could not reach the Altimate workspace service — pre-check skipped.",
  })
  api.ui.dialog.replace(() => (
    <OfferDialog
      api={api}
      identifier={identifier}
      defaultName={defaultName}
      browserAvailable={browserAvailable}
      latchScope={latchScope}
    />
  ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine install offer. The workspace engine overlay decides there is no usable engine and hands
// the offer here; this file owns the interaction. Offer, never silently
// install — the install only ever runs from an explicit "Install now".
// ─────────────────────────────────────────────────────────────────────────────

const KV_ENGINE_SKIP_PREFIX = "altimate.workspace.engineInstall.skip."

/** Latch key from (tenant, apiUrl, workspace id). Keyed on the workspace so a
 * "Not now" for one workspace doesn't silence the offer for another, and on
 * the id rather than the name so a rename doesn't reset it. */
function engineSkipKey(workspaceId: string, scope: LatchScope | null): string {
  const scopeString = scope ? `${scope.tenant}|${scope.apiUrl}|` : ""
  return (
    KV_ENGINE_SKIP_PREFIX +
    createHash("sha1")
      .update(scopeString + workspaceId)
      .digest("hex")
  )
}

/** The KV store starts empty and fills in once the persisted file is read
 * (`api.kv.ready`). A latch checked before that reads as absent, so an offer
 * raised on the first message after a restart would ignore a "Not now" that
 * is still in force. `ready` is a plain getter with nothing to await, so poll
 * it — bounded, and on timeout proceed as if hydrated rather than never
 * answer. Resolves to whether the store was ready. */
const KV_READY_TIMEOUT_MS = 3_000
const KV_READY_POLL_MS = 25
async function awaitKvReady(
  kv: { readonly ready: boolean },
  timeoutMs = KV_READY_TIMEOUT_MS,
  pollMs = KV_READY_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!kv.ready) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return true
}

/** Same clock-rewind handling as the post-scan latch; the TTL is the one the
 * attach side's announce dedupe expires on, so both agree on "7 days". */
function isEngineSkipActive(
  api: TuiPluginApi,
  workspaceId: string,
  scope: LatchScope | null,
  nowMs: number,
): boolean {
  const rec = api.kv.get<{ skippedAt: number }>(engineSkipKey(workspaceId, scope))
  if (!rec || typeof rec.skippedAt !== "number") return false
  const delta = nowMs - rec.skippedAt
  if (delta < 0) return false
  return delta < OFFER_SKIP_TTL_MS
}

function recordEngineSkip(
  api: TuiPluginApi,
  workspaceId: string,
  scope: LatchScope | null,
  nowMs: number,
): void {
  api.kv.set(engineSkipKey(workspaceId, scope), { skippedAt: nowMs })
}

interface EngineOfferProps {
  api: TuiPluginApi
  offer: EngineOffer
  /** Node major on PATH, or null when Node is absent. Resolved by the caller
   * so the dialog itself stays sync (same shape as ``browserAvailable``). */
  nodeMajor: number | null
  /** Whether npm itself can be invoked. Node 20+ is not enough: several Linux
   * distributions package node and npm separately. */
  hasNpm: boolean
  latchScope: LatchScope | null
  /** Which raise owns the single-offer latch; only the owner releases it. */
  generation: number
}

/** One DialogSelect for every phase — the row set changes, the component never
 * does. Swapping the top-level dialog component between states tears down and
 * remounts the dialog, which drops focus and loses the phase signal. Sentinel
 * rows carry the non-idle phases, and never use ``disabled: true`` (
 * DialogSelect's ``filtered()`` drops those, leaving an empty list). */
function EngineInstallOfferDialog(props: EngineOfferProps) {
  const clipboard = useClipboard()
  const [phase, setPhase] = createSignal<"idle" | "installing" | "installed" | "failed">("idle")
  const [failure, setFailure] = createSignal<string | null>(null)
  // The install outlives this component: Escape or a click outside dismisses
  // the dialog while npm keeps running. Signals set after that update nothing
  // anyone can see — a failed install or the five-minute timeout would be
  // completely silent — and clearing the dialog stack would close whatever
  // opened in our place. So completion reports through a toast when we are
  // gone, and only touches the dialog while we still own it.
  let mounted = true
  onCleanup(() => {
    mounted = false
    // Release the single-offer latch however this dialog goes away — chosen,
    // dismissed, or replaced — but only if this dialog still owns it. A
    // superseded dialog tearing down must not free a slot the newer one holds.
    if (engineOfferGeneration === props.generation) engineOfferVisible = false
  })
  // ``onSelect`` is delivered synchronously per Enter keypress; the install is
  // a multi-minute await. Without this latch a second Enter starts a second
  // ``npm i -g`` against the same global prefix.
  let installing = false

  const command = () => props.offer.command
  const canInstall = () => props.nodeMajor !== null && props.nodeMajor >= MIN_NODE_MAJOR && props.hasNpm

  const title = () => {
    const tools = `${props.offer.declared} integration tool${props.offer.declared === 1 ? "" : "s"}`
    const head =
      props.offer.reason === "engine-too-old"
        ? `Workspace "${props.offer.workspaceName}" needs a newer local engine (found ${props.offer.found ?? "unknown"}) — ${tools} unavailable`
        : `Workspace "${props.offer.workspaceName}" declares ${tools}, which need the local engine`
    const parts = [head, command()]
    if (!canInstall()) {
      parts.push(
        props.nodeMajor === null
          ? `(needs Node ${MIN_NODE_MAJOR}+ to install — Node was not found on PATH)`
          : props.nodeMajor < MIN_NODE_MAJOR
            ? `(needs Node ${MIN_NODE_MAJOR}+ to install — found Node ${props.nodeMajor})`
            : `(needs npm to install — npm was not found on PATH)`,
      )
    }
    const err = failure()
    if (err) parts.push(`(install failed: ${err})`)
    return parts.join(" · ")
  }

  const options = () => {
    switch (phase()) {
      case "installing":
        return [{ title: "Installing… this can take a minute.", value: "busy" }]
      case "installed":
        return [{ title: "Installed — attaching integrations.", value: "close" }]
      case "failed":
        return [
          { title: "Copy command", value: "copy", description: "Run it yourself, then start a new session." },
          { title: "Close", value: "close" },
        ]
      default:
        return [
          ...(canInstall()
            ? [
                {
                  title: "Install now",
                  value: "install",
                  description: `Runs ${command()} and attaches this session when it finishes.`,
                },
              ]
            : []),
          {
            title: "Copy command",
            value: "copy",
            description: "Copy the install command to your clipboard.",
          },
          {
            title: "Not now",
            value: "skip",
            description: "Won't ask again for this workspace for 7 days.",
          },
        ]
    }
  }

  const runInstall = async () => {
    setPhase("installing")
    engineInstallInFlight = true
    try {
      await performInstall()
    } finally {
      engineInstallInFlight = false
    }
  }

  const performInstall = async () => {
    const result = await installEngine()
    if (!result.ok) {
      installing = false
      if (!mounted) {
        // Dismissed mid-install: the failed-phase rows have nowhere to render,
        // so the error reaches the user as a toast or not at all.
        props.api.ui.toast({
          variant: "error",
          message: `Workspace engine install failed: ${result.error}. Run: ${command()}`,
          duration: 30_000,
        })
        return
      }
      setFailure(result.error)
      setPhase("failed")
      return
    }
    setPhase("installed")
    // Only clear a dialog we still own — by now the user may have opened
    // another, and clearing the stack would take theirs down instead.
    if (mounted) props.api.ui.dialog.clear()
    // Deliberately NOT reconciling this session from here. The plugin runtime
    // loads this file in its own realm, so the overlay module here is not the
    // one the server consults. Nothing needs to: the turn boundary looks for a
    // missing engine on PATH again every turn, so the engine just installed is
    // picked up on the next message without a restart.
    props.api.ui.toast({
      variant: "success",
      message:
        `Workspace engine installed. Integration tools for "${props.offer.workspaceName}" ` +
        `attach on your next message.`,
      duration: 15_000,
    })
  }

  const copyCommand = () => {
    const cmd = command()
    void (async () => {
      try {
        await clipboard.write?.(cmd)
        // A resolved write is NOT proof of a copy. The host's writer picks
        // xclip/xsel on Linux and otherwise falls back to clipboardy, and it
        // swallows backend failures (`.catch(() => undefined)`), so on the many
        // Linux/WSL boxes with neither tool installed the write silently does
        // nothing. Read back and compare before claiming success. (Caught by
        // E2E: the toast said "Copied:" while the clipboard was untouched.)
        const back = await clipboard.read?.()
        if (back?.data.trim() === cmd) {
          props.api.ui.toast({ variant: "info", message: `Copied: ${cmd}` })
          return
        }
      } catch {
        // Unreadable or unwritable clipboard — fall through and show it.
      }
      props.api.ui.toast({
        variant: "warning",
        message: `Could not confirm the clipboard. Run: ${cmd}`,
        duration: 30_000,
      })
    })()
  }

  return (
    <props.api.ui.DialogSelect
      title={title()}
      options={options()}
      // No filter. The row set changes with the phase, and a query typed to
      // reach "Install now" still applies afterwards — the installing sentinel
      // and the failure rows do not match it, so `filtered()` empties and the
      // recovery actions become unreachable. A fixed three-option dialog gains
      // nothing from filtering anyway.
      skipFilter
      current={canInstall() ? "install" : "copy"}
      onSelect={(option) => {
        if (option.value === "busy") return
        if (option.value === "install") {
          if (installing) return
          installing = true
          void runInstall().catch((err) => {
            setFailure(err instanceof Error ? err.message : String(err))
            setPhase("failed")
            installing = false
          })
          return
        }
        if (option.value === "copy") {
          copyCommand()
          props.api.ui.dialog.clear()
          return
        }
        if (option.value === "skip") {
          recordEngineSkip(props.api, props.offer.workspaceId, props.latchScope, Date.now())
        }
        props.api.ui.dialog.clear()
      }}
    />
  )
}

/** Show the offer unless the 7-day latch suppresses it.
 *
 * The overlay raises this as a bare command over the event bus — it cannot hand
 * us the offer object, because the plugin runtime loads this file in a separate
 * realm from the attach flow. So the detail is re-derived here, the same way
 * the post-scan prompt re-derives its own state from the directory. Node
 * availability and latch scope are resolved before rendering so the dialog
 * itself stays sync. */
let engineOfferVisible = false
/** Identifies which raise owns the latch, so a superseded dialog's teardown
 * cannot free a slot that a newer dialog is still holding. */
let engineOfferGeneration = 0
/** Held for the lifetime of an `npm i -g`, independently of the dialog.
 *
 * The install outlives the dialog that started it: dismissing mid-install
 * tears the component down and frees the offer latch, but npm keeps running.
 * Without this, the next turn's repair retry raises a fresh offer whose
 * "Install now" starts a SECOND `npm i -g` against the same global prefix.
 * The dialog latch answers "is an offer on screen"; this one answers "is an
 * install still running", and only the second survives dismissal. */
let engineInstallInFlight = false

async function showEngineInstallOffer(api: TuiPluginApi): Promise<void> {
  // The attach re-probes a repairable failure on every turn, so the offer can
  // be raised again while an earlier one is still up — including mid-install,
  // where a fresh idle dialog replaces the "Installing…" one and then swallows
  // the user's keystrokes into its own filter. Observed end-to-end: after a
  // successful install the pane showed a second offer in its idle phase and
  // typing went to the dialog rather than the prompt. One offer at a time.
  //
  // The slot is reserved BEFORE the first await. Discovery below awaits three
  // times, and a check-then-act guard placed after them lets two dispatches
  // that arrive close together both pass — which is worse than the bug it
  // fixes, because the second dialog can replace an installing one and start a
  // concurrent global npm install.
  // `attach <url>` runs this plugin on the CLIENT while the binding, the PATH
  // that matters and the MCP session all live on the SERVER. Probing PATH here
  // would describe the wrong machine, and "Install now" would install npm on
  // the client, leaving the server exactly as it was behind a success toast.
  // attach.ts recognises that case the same way — the server's directory does
  // not exist locally — so use it and refuse to act, saying where the fix goes.
  //
  // Not a complete answer: a client that happens to have the same path, with a
  // binding, is still misread. Closing that needs server-side discovery and
  // install behind an API, which this PR does not add.
  if (!existsSync(api.state.path.directory)) {
    log.info("engine install offer suppressed: not the host that owns this workspace")
    api.ui.toast({
      variant: "warning",
      message: `This workspace's engine is missing on the server, not on this machine. Run there: ${installCommand()}`,
      duration: 30_000,
    })
    return
  }
  if (engineOfferVisible) return
  if (engineInstallInFlight) {
    // An install started from an earlier dialog is still running; offering
    // again would invite a second concurrent global install.
    log.info("engine install offer suppressed while an install is in flight")
    return
  }
  engineOfferVisible = true
  const generation = ++engineOfferGeneration
  const release = () => {
    // Only the current owner may free the slot.
    if (engineOfferGeneration === generation) engineOfferVisible = false
  }
  try {
    const offer = await describeOffer(api.state.path.directory)
    // Null means the situation resolved between the attach and this dialog — an
    // engine appeared, or the project is no longer bound. Say nothing.
    if (!offer) return release()
    const latchScope = await currentLatchScope()
    if (!(await awaitKvReady(api.kv))) {
      log.warn("kv store not hydrated in time; checking the engine install latch against what is loaded")
    }
    if (isEngineSkipActive(api, offer.workspaceId, latchScope, Date.now())) {
      log.info("engine install offer suppressed by 7-day latch", { workspaceId: offer.workspaceId })
      return release()
    }
    const major = await detectNodeMajor()
  const hasNpm = npmAvailable()
    api.ui.dialog.replace(() => (
      <EngineInstallOfferDialog
        api={api}
        offer={offer}
        nodeMajor={major}
        hasNpm={hasNpm}
        latchScope={latchScope}
        generation={generation}
      />
    ))
  } catch (err) {
    release()
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────────

/** Report a fire-and-forget flow failure. The keymap ``run()`` callbacks
 * discard the returned promise with ``void``, so any rejection from
 * ``recordApprovedBinding`` / ``readLocalBinding`` / anything else awaited
 * inside would otherwise surface as an unhandled rejection and terminate
 * the TUI process. Log + surface a toast so the user knows the workspace
 * flow bailed. (CR round 2.) */
function reportFlowFailure(api: TuiPluginApi, err: unknown): void {
  log.error("workspace flow failed", { err: err instanceof Error ? err.message : String(err) })
  api.ui.toast({
    variant: "error",
    message: "Workspace setup failed — see the CLI log for details.",
  })
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.workspace.postScan",
        title: "Post-scan workspace prompt",
        category: "Altimate",
        namespace: "internal",
        run() {
          runFlow(api, api.state.path.directory).catch((err) => reportFlowFailure(api, err))
        },
      },
      {
        // Raised by the workspace engine overlay over the event bus when a bound workspace has
        // no usable engine. Internal: dispatched, never shown in the palette.
        name: OFFER_COMMAND,
        title: "Workspace engine install offer",
        category: "Altimate",
        namespace: "internal",
        run() {
          showEngineInstallOffer(api).catch((err) => reportFlowFailure(api, err))
        },
      },
      {
        name: "altimate.workspace.link",
        title: "Link this project to a workspace",
        category: "Altimate",
        namespace: "palette",
        run() {
          // User-initiated → jump straight to picker (currently-linked marked,
          // "＋ Create new" as the first row). No Skip funnel — they invoked.
          runOnDemandPicker(api, api.state.path.directory).catch((err) =>
            reportFlowFailure(api, err),
          )
        },
      },
    ],
  })
}

export default { id: PLUGIN_ID, tui } satisfies BuiltinTuiPlugin

// Exported for unit tests only. The shared logic (WorkspaceApi, cache, detect,
// project-name) lives in `@/altimate/workspace/*` and should be tested there;
// the plugin owns just the TUI-specific latch semantics.
export { isSkipActive, recordSkip, isEngineSkipActive, recordEngineSkip, awaitKvReady }
// altimate_change end

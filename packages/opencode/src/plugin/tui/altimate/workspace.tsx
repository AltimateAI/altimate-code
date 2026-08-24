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
import open from "open"
import { createSignal, onMount } from "solid-js"
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
  projectNameFromPath,
  projectNameFromRemote,
  resolveProjectIdentifier,
} from "@/altimate/workspace/detect"
import { readLocalBinding, recordApprovedBinding } from "@/altimate/workspace/state"
import { AltimateApi } from "@/altimate/api/client"
import { Log } from "@/altimate/util/log"

const PLUGIN_ID = "altimate:workspace"

const log = Log.create({ service: "altimate-workspace" })

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
  /** (tenant, apiUrl) scope for the Skip latch. Resolved once by the caller
   * so the sync ``onSelect`` handler can call ``recordSkip`` without a
   * mid-render await. Null when creds are unavailable — latch falls back
   * to unscoped. (cubic round 3.) */
  latchScope: LatchScope | null
}

function OfferDialog(props: OfferProps) {
  const identLabel = () => props.identifier.repoRemote ?? props.identifier.projectPath ?? "this project"
  return (
    <props.api.ui.DialogSelect
      title={`Set up a workspace for this project? (${identLabel()})`}
      options={[
        {
          title: "Create a new workspace",
          value: "create",
          description: `Auto-named "${props.defaultName}" from this repo — rename in the SaaS.`,
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
      ]}
      current="create"
      onSelect={(option) => {
        if (option.value === "skip") {
          recordSkip(props.api, props.identifier, props.latchScope, Date.now())
          props.api.ui.dialog.clear()
          return
        }
        if (option.value === "create") {
          // Auto-name from git repo — no name prompt. The SaaS UI is the place to
          // rename / configure; the CLI's job is just to establish the binding.
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
  // fallout inside the function itself: ``recordApprovedBinding`` already
  // swallows its own errors (state.ts is best-effort), but ``open()`` and
  // the toast APIs can reject unexpectedly. Fall back to a plain info
  // toast so the user still sees the URL. (Kilo cycle 5.)
  try {
    await recordApprovedBinding(api.state.path.directory, {
      datamateId: res.datamate.id,
      datamateName: res.datamate.name,
      repoRemote: res.binding.repo_remote,
      projectPath: res.binding.project_path,
      linkedAt: Date.now(),
    })
    // Guard against a non-http(s) manage_url — ``open`` dispatches to whatever
    // OS handler matches the protocol, so a rogue value could launch an
    // unrelated app. Fall through to the info toast (with the URL for manual
    // copy) if the URL isn't a safe http/https link.
    if (isSafeHttpUrl(res.manage_url)) {
      try {
        await open(res.manage_url)
        api.ui.toast({
          variant: "success",
          message: `Workspace "${res.datamate.name}" created. Opened ${res.manage_url} in your browser.`,
        })
        return
      } catch {
        /* fall through to the "open manually" toast below */
      }
    }
    api.ui.toast({
      variant: "info",
      message: `Workspace "${res.datamate.name}" created. Open ${res.manage_url} to configure it.`,
      duration: 10_000,
    })
  } catch (err) {
    api.ui.toast({
      variant: "info",
      message: `Workspace "${res.datamate.name}" created and linked.`,
    })
    void err
  }
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
        props.api.ui.toast({
          variant: "success",
          message: `Linked to workspace "${res.binding.datamate_name}".`,
        })
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
        props.api.ui.toast({
          variant: "success",
          message: `Re-linked to workspace "${res.binding.datamate_name}".`,
        })
      }
      props.api.ui.dialog.clear()
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
    api.ui.toast({
      variant: "success",
      message: isRebind
        ? `Re-linked to workspace "${res.binding.datamate_name}".`
        : `Linked to workspace "${res.binding.datamate_name}".`,
    })
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
      latchScope={latchScope}
    />
  ))
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
export { isSkipActive, recordSkip }
// altimate_change end

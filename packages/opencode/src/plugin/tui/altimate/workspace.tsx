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
import { createSignal, onMount, Show } from "solid-js"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  WorkspaceApi,
  type DatamateRef,
  type GetBindingResponse,
} from "@/altimate/workspace/api-client"
import { detectProjectRemote, projectNameFromRemote } from "@/altimate/workspace/detect"
import { readLocalBinding, recordApprovedBinding } from "@/altimate/workspace/state"
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

function skipKey(remote: string): string {
  // Hash to keep the KV keyspace bounded and avoid embedding a URL (which can
  // contain userinfo even after scrubbing edge cases) into a persisted key.
  return KV_SKIP_PREFIX + createHash("sha1").update(remote).digest("hex")
}

function isSkipActive(api: TuiPluginApi, remote: string, nowMs: number): boolean {
  const rec = api.kv.get<{ skippedAt: number }>(skipKey(remote))
  if (!rec || typeof rec.skippedAt !== "number") return false
  return nowMs - rec.skippedAt < SKIP_TTL_MS
}

function recordSkip(api: TuiPluginApi, remote: string, nowMs: number): void {
  api.kv.set(skipKey(remote), { skippedAt: nowMs })
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog components — deliberate three-way selects; no LLM-generated copy.
// Every dialog closes via `api.ui.dialog.clear()` when the user picks a
// terminal action, so onboarding is never blocked by a stuck workspace prompt.
// ─────────────────────────────────────────────────────────────────────────────

interface OfferProps {
  api: TuiPluginApi
  remote: string
  defaultName: string
  suppressLatch?: boolean // altimate link on-demand skips the Skip latch
}

function OfferDialog(props: OfferProps) {
  return (
    <props.api.ui.DialogSelect
      title={`Set up a workspace for this project? (${props.remote})`}
      options={[
        {
          title: "Create a new workspace",
          value: "create",
          description: "Opens a browser to configure integrations and knowledge.",
        },
        {
          title: "Link to an existing workspace",
          value: "link",
          description: "Attach this project to a workspace you already own.",
        },
        {
          title: "Skip for now",
          value: "skip",
          description: props.suppressLatch ? "Close this prompt." : "Won't ask again for 7 days.",
        },
      ]}
      current="create"
      onSelect={(option) => {
        if (option.value === "skip") {
          if (!props.suppressLatch) recordSkip(props.api, props.remote, Date.now())
          props.api.ui.dialog.clear()
          return
        }
        if (option.value === "create") {
          props.api.ui.dialog.replace(() => (
            <CreateDialog api={props.api} defaultName={props.defaultName} remote={props.remote} />
          ))
          return
        }
        // link → picker
        props.api.ui.dialog.replace(() => (
          <PickerDialog api={props.api} remote={props.remote} mode="attach" />
        ))
      }}
    />
  )
}

interface AlreadyLinkedProps {
  api: TuiPluginApi
  remote: string
  workspaceName: string
  workspaceId: number
  hasDrift: boolean
  driftedWas?: string | null
  unverified?: boolean
}

function AlreadyLinkedDialog(props: AlreadyLinkedProps) {
  // Title carries the primary context (workspace name + drift/unverified hint)
  // since DialogSelect doesn't take a top-level description block. Verbose but
  // it puts the critical info in the user's field of view before they pick.
  const title = () => {
    const parts: string[] = [`Project is linked to workspace "${props.workspaceName}"`]
    if (props.hasDrift && props.driftedWas) parts.push(`(was ${props.driftedWas}, now ${props.remote})`)
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
        // a concurrent re-link by another client 412s cleanly.
        props.api.ui.dialog.replace(() => (
          <PickerDialog
            api={props.api}
            remote={props.remote}
            mode="relink"
            expectedCurrentDatamateId={props.workspaceId}
          />
        ))
      }}
    />
  )
}

interface PickerProps {
  api: TuiPluginApi
  remote: string
  mode: "attach" | "relink"
  expectedCurrentDatamateId?: number
}

function PickerDialog(props: PickerProps) {
  const [datamates, setDatamates] = createSignal<DatamateRef[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)

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
    try {
      if (props.mode === "attach") {
        const res = await WorkspaceApi.bindExisting(datamateId, props.remote)
        await recordApprovedBinding(props.api.state.path.directory, {
          datamateId: res.binding.datamate_id,
          datamateName: res.binding.datamate_name,
          repoRemote: res.binding.repo_remote,
          linkedAt: Date.now(),
        })
        props.api.ui.toast({
          variant: "success",
          message: `Linked to workspace "${res.binding.datamate_name}".`,
        })
      } else {
        const res = await WorkspaceApi.rebindByRemote({
          remote: props.remote,
          targetDatamateId: datamateId,
          expectedCurrentDatamateId: props.expectedCurrentDatamateId,
        })
        await recordApprovedBinding(props.api.state.path.directory, {
          datamateId: res.binding.datamate_id,
          datamateName: res.binding.datamate_name,
          repoRemote: res.binding.repo_remote,
          linkedAt: Date.now(),
        })
        props.api.ui.toast({
          variant: "success",
          message: `Re-linked to workspace "${res.binding.datamate_name}".`,
        })
      }
      props.api.ui.dialog.clear()
    } catch (err) {
      // Surface as a toast so the user sees the specific failure. Dialog closes
      // either way — the user can re-invoke via /altimate.workspace.link.
      let msg: string
      if (err instanceof ConflictError) {
        msg = `Already linked to "${err.detail.existing_datamate_name ?? "another workspace"}" — pick Re-link from the offer if you want to move it.`
      } else if (err instanceof PreconditionFailedError) {
        msg = "Someone else re-linked this project — reload and try again."
      } else if (err instanceof NotFoundError) {
        msg = "No existing binding for this remote to re-link. Try Create/Link from the offer instead."
      } else if (err instanceof ForbiddenError) {
        msg = "Only the workspace owner can attach projects to it."
      } else {
        msg = err instanceof Error ? err.message : "Failed to link workspace"
      }
      props.api.ui.toast({ variant: "error", message: msg })
      props.api.ui.dialog.clear()
    }
  }

  // While loading (or on error before dialog closes), render an empty select as
  // a placeholder — DialogSelect requires the options array up front and doesn't
  // have a native busy state; the empty list closes to a "no workspaces" message.
  const options = () => {
    const list = datamates()
    if (!list) return [{ title: "Loading workspaces...", value: -1, disabled: true }]
    if (list.length === 0)
      return [
        {
          title: "No workspaces yet — cancel and pick 'Create a new workspace' instead.",
          value: -1,
          disabled: true,
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

interface CreateProps {
  api: TuiPluginApi
  defaultName: string
  remote: string
}

function CreateDialog(props: CreateProps) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  return (
    <props.api.ui.DialogPrompt
      title="Create workspace"
      placeholder={props.defaultName || "workspace name"}
      busy={busy()}
      busyText="Creating workspace..."
      description={() => (
        <box gap={1}>
          <text fg={props.api.theme.current.textMuted}>Name this workspace (defaults to your project name):</text>
          <text fg={props.api.theme.current.textMuted}>You can add integrations, knowledge, and guardrails in the browser after.</text>
          <Show when={error()}>
            <text fg={props.api.theme.current.error}>{error()!}</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        if (busy()) return
        const name = (value || "").trim() || props.defaultName || "Untitled Workspace"
        setBusy(true)
        setError(null)
        try {
          const res = await WorkspaceApi.createAndBind({
            name,
            repoRemote: props.remote,
          })
          await recordApprovedBinding(props.api.state.path.directory, {
            datamateId: res.datamate.id,
            datamateName: res.datamate.name,
            repoRemote: res.binding.repo_remote,
            linkedAt: Date.now(),
          })
          // Best-effort browser open. On failure, fall back to a toast with the
          // URL so the user has a copy-pasteable path forward — silent failure
          // was flagged by codex round 1.
          try {
            await open(res.manage_url)
            props.api.ui.toast({
              variant: "success",
              message: `Workspace "${res.datamate.name}" created. Opened ${res.manage_url} in your browser.`,
            })
          } catch {
            props.api.ui.toast({
              variant: "info",
              message: `Workspace "${res.datamate.name}" created. Open ${res.manage_url} in your browser to configure it.`,
              duration: 10_000,
            })
          }
          props.api.ui.dialog.clear()
        } catch (err) {
          if (err instanceof ConflictError) {
            setError(
              `This project is already linked to "${err.detail.existing_datamate_name ?? "another workspace"}". Cancel and pick "Re-link" from the offer if you want to move it.`,
            )
          } else {
            setError(err instanceof Error ? err.message : "Failed to create workspace")
          }
        } finally {
          setBusy(false)
        }
      }}
      onCancel={() => props.api.ui.dialog.clear()}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow orchestrator — runs on every `altimate.workspace.postScan` command
// dispatch AND on every `altimate.workspace.link` command dispatch. Idempotent
// re-entry: if a dialog is already up, the mount replaces it (that's fine —
// two rapid scan completions collapse to one visible offer).
// ─────────────────────────────────────────────────────────────────────────────

async function runFlow(
  api: TuiPluginApi,
  directory: string,
  opts: { suppressLatch?: boolean } = {},
): Promise<void> {
  const remote = detectProjectRemote(directory)
  if (!remote) {
    // Not a git project (or git failed) — nothing to bind to. Silent per spec:
    // the ticket says "handle failures without blocking the existing flow".
    return
  }
  if (!opts.suppressLatch && isSkipActive(api, remote, Date.now())) {
    log.info("workspace prompt suppressed by 7-day Skip latch", { remote })
    return
  }

  let serverBinding: GetBindingResponse | null | undefined
  try {
    serverBinding = await WorkspaceApi.getBindingForRemote(remote)
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
      repoRemote: remote,
      linkedAt: Date.now(),
    })
    api.ui.dialog.replace(() => (
      <AlreadyLinkedDialog
        api={api}
        remote={remote}
        workspaceName={serverBinding!.datamate.name}
        workspaceId={serverBinding!.datamate.id}
        hasDrift={false}
      />
    ))
    return
  }

  if (serverBinding === null) {
    // Server confirmed unbound → offer create-or-link.
    api.ui.dialog.replace(() => (
      <OfferDialog
        api={api}
        remote={remote}
        defaultName={projectNameFromRemote(remote)}
        suppressLatch={opts.suppressLatch}
      />
    ))
    return
  }

  // Server unreachable — fall back to the local cache (marked as unverified).
  const local = await readLocalBinding(directory)
  if (local) {
    api.ui.dialog.replace(() => (
      <AlreadyLinkedDialog
        api={api}
        remote={remote}
        workspaceName={local.datamateName}
        workspaceId={local.datamateId}
        hasDrift={local.repoRemote !== remote}
        driftedWas={local.repoRemote !== remote ? local.repoRemote : undefined}
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
      remote={remote}
      defaultName={projectNameFromRemote(remote)}
      suppressLatch={opts.suppressLatch}
    />
  ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.workspace.postScan",
        title: "Post-scan workspace prompt",
        category: "Altimate",
        namespace: "internal",
        run() {
          void runFlow(api, api.state.path.directory)
        },
      },
      {
        name: "altimate.workspace.link",
        title: "Link this project to a workspace",
        category: "Altimate",
        namespace: "palette",
        run() {
          // User-initiated → bypass the Skip latch.
          void runFlow(api, api.state.path.directory, { suppressLatch: true })
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

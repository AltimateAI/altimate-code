// altimate_change - new file
// Right-pane sidebar tile that shows the workspace the current project
// directory is bound to (or "Not linked" with a hint). Reads from the local
// binding cache written by `../workspace.tsx` (post-scan dialog, on-demand
// picker, browser handoff).
//
// Deliberately read-only. All bind mutations live in workspace.tsx / link.ts;
// this tile just reflects state.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { readLocalBinding, type CachedBinding } from "@/altimate/workspace/state"
import { resolveWorkspaceWebUrl } from "@/altimate/workspace/browser-handoff"
import { getResolvedWorkspaceId } from "@/altimate/workspace/session-context"
import { AltimateApi } from "@/altimate/api/client"

const id = "altimate:sidebar-workspace"

/** Cache-file poll cadence. Longer than a "reactive" ideal but the cheapest
 * option that does not require plumbing an event bus through the binding
 * writers. Trade-off documented (m1 in the consensus review): a fresh bind
 * surfaces within one interval instead of instantly; a mostly-idle CLI reads
 * the small cache file twice per minute. In-flight guard below prevents
 * overlap when the file grows / the disk is slow. */
const POLL_MS = 30_000

/** Cached credential lookup — the API is a network round-trip candidate in
 * the general case, but the credentials source here (local file) rarely
 * changes within a single CLI process. We memoize the resolved manage-URL
 * base per (apiUrl, tenant) pair for the life of the process; if the file
 * changes mid-session, the binding cache invalidation (in state.ts) still
 * catches it via its own (tenant, apiUrl) top-level scoping. */
let cachedManageBase: { apiUrl: string; tenant: string; base: string | null } | null = null
async function resolveManageBase(): Promise<string | null> {
  try {
    const creds = await AltimateApi.getCredentials()
    if (
      cachedManageBase &&
      cachedManageBase.apiUrl === creds.altimateUrl &&
      cachedManageBase.tenant === creds.altimateInstanceName
    ) {
      return cachedManageBase.base
    }
    const url = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    const base = url ? url.toString().replace(/\/$/, "") : null
    cachedManageBase = { apiUrl: creds.altimateUrl, tenant: creds.altimateInstanceName, base }
    return base
  } catch {
    return null
  }
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [binding, setBinding] = createSignal<CachedBinding | null>(null)
  const [manageUrl, setManageUrl] = createSignal<string | null>(null)

  let refreshInFlight = false
  const refresh = async () => {
    if (refreshInFlight) return
    refreshInFlight = true
    try {
      const dir = props.api.state.path.directory
      const b = await readLocalBinding(dir).catch(() => null)
      setBinding(b)
      if (!b) {
        setManageUrl(null)
        return
      }
      const base = await resolveManageBase()
      setManageUrl(base ? `${base}/w/${b.datamateId}` : null)
    } finally {
      refreshInFlight = false
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(timer as any)?.unref?.()
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Workspace</b>
      </text>
      <Show
        when={binding()}
        fallback={
          <text fg={theme().textMuted}>
            Not linked — run <b>altimate-code link</b>
          </text>
        }
      >
        {(b) => (
          <>
            <text fg={theme().textMuted}>
              {b().datamateName}
              {/* ``pinned via --workspace`` means "this SESSION was launched
                * with --workspace and it resolved to this id". It does NOT
                * mean "the current binding was set by --workspace" — if the
                * user relinks mid-session to a different workspace, the pin
                * disappears (id mismatch); if they relink to the same id,
                * the pin correctly stays because the launch fact is
                * unchanged. Known imprecision: relink-to-same-id looks
                * indistinguishable from "never relinked". Accepted per
                * altimate-harness-bot round 8 (option b of the review).
                * ``getResolvedWorkspaceId`` returns null when the launch
                * had no --workspace flag or the flag failed to resolve,
                * so the pin never falsely appears for a session that
                * wasn't launched with the flag. */}
              <Show when={getResolvedWorkspaceId() === b().datamateId}>
                {" (pinned via --workspace)"}
              </Show>
            </text>
            <Show when={manageUrl()}>
              {(u) => <text fg={theme().textMuted}>{u()}</text>}
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Below MCP (200) and above LSP (300) — workspace identity is high-signal
    // when present, but not more useful than the connection status above.
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

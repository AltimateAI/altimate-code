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
import { buildManageUrl, resolveWorkspaceWebUrl } from "@/altimate/workspace/browser-handoff"
import { getResolvedWorkspaceId } from "@/altimate/workspace/session-context"
import { AltimateApi } from "@/altimate/api/client"
import { openManageUrl } from "./workspace"

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
let cachedManageBase: { apiUrl: string; tenant: string; base: URL | null } | null = null
async function resolveManageBase(): Promise<URL | null> {
  try {
    const creds = await AltimateApi.getCredentials()
    if (
      cachedManageBase &&
      cachedManageBase.apiUrl === creds.altimateUrl &&
      cachedManageBase.tenant === creds.altimateInstanceName
    ) {
      return cachedManageBase.base
    }
    const base = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
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
      setManageUrl(base ? buildManageUrl(base, b.datamateId) : null)
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
            {/* Clicking the name (or the URL line below) opens the workspace
              * in the browser — the manage URL is deterministic from tenant
              * + id (see resolveManageBase above), so there's no extra
              * round-trip before it's clickable. The whole line is the click
              * target (mouse events only land on block-level `<text>`/`<box>`,
              * not inline `<span>`/`<a>` nodes), while only the name itself
              * is styled to look like a link — matching the footer's docs/
              * community links (sidebar/footer.tsx), which use the same
              * span-style + onMouseUp pair because raw `<a href>` hyperlink
              * nodes crash in this JSX layer. ``onMouseUp`` is omitted
              * entirely (not just a no-op) when there's no URL yet, so the
              * name never advertises a click target that does nothing. The
              * "pinned via --workspace" hint lives on its own line below
              * (rather than appended inline here) so the click region
              * doesn't extend over text that isn't part of the link — same
              * reasoning as the URL line already being separate. (multi-model
              * review, PR #1274.) */}
            <text fg={theme().textMuted} onMouseUp={manageUrl() ? () => openManageUrl(props.api, manageUrl()!) : undefined}>
              <Show when={manageUrl()} fallback={b().datamateName}>
                {(_u) => <span style={{ fg: theme().accent, underline: true }}>{b().datamateName}</span>}
              </Show>
            </text>
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
              <text fg={theme().textMuted}>(pinned via --workspace)</text>
            </Show>
            <Show when={manageUrl()}>
              {(u) => (
                <text fg={theme().textMuted} onMouseUp={() => openManageUrl(props.api, u())}>
                  <span style={{ fg: theme().accent, underline: true }}>{u()}</span>
                </text>
              )}
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

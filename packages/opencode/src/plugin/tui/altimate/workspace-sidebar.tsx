// altimate_change - new file
// Right-pane sidebar tile that shows the workspace the current project
// directory is bound to (or "Not linked" with a hint). Reads from the local
// binding cache written by `../workspace.tsx` (post-scan dialog, on-demand
// picker, browser handoff). Cache is polled every 3s so a fresh bind
// surfaces without the user having to reload the TUI.
//
// Deliberately read-only. All bind mutations live in workspace.tsx / link.ts;
// this tile just reflects state.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { readLocalBinding, type CachedBinding } from "@/altimate/workspace/state"
import { resolveWorkspaceWebUrl } from "@/altimate/workspace/browser-handoff"
import { AltimateApi } from "@/altimate/api/client"

const id = "altimate:sidebar-workspace"

const POLL_MS = 3000

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [binding, setBinding] = createSignal<CachedBinding | null>(null)
  const [manageUrl, setManageUrl] = createSignal<string | null>(null)

  const refresh = async () => {
    const dir = props.api.state.path.directory
    const b = await readLocalBinding(dir).catch(() => null)
    setBinding(b)
    if (!b) {
      setManageUrl(null)
      return
    }
    try {
      const creds = await AltimateApi.getCredentials()
      const base = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
      setManageUrl(base ? `${base.toString().replace(/\/$/, "")}/w/${b.datamateId}` : null)
    } catch {
      setManageUrl(null)
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
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
            Not linked — run <b>/link</b>
          </text>
        }
      >
        {(b) => (
          <>
            <text fg={theme().textMuted}>{b().datamateName}</text>
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

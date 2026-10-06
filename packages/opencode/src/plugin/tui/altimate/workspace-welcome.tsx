// altimate_change - new file
// The workspace-mode block inside the boot box, under "What is Altimate Code":
// which mode and workspace this is, the slash commands the mode adds, and what
// the last session got from the workspace. Registered only under the
// ALTIMATE_WORKSPACE flag (see ./index.ts), so outside workspace mode the box
// is unchanged. Read-only, like the sidebar tile: the binding as the tile
// resolves it, the attach outcome from its snapshot file.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, onCleanup, onMount } from "solid-js"
import { resolveBindingOutcome } from "@/altimate/workspace/state"
import { boundAttachSnapshot } from "@/altimate/workspace/status-view"
import { welcomeLinesFor, type WelcomeLines } from "@/altimate/workspace/welcome-lines"

const id = "altimate:welcome-workspace"

/** The box is on screen before the first message and through the session,
 * so the integrations line has to pick up the attach after it settles; a short
 * poll is the cheapest way without an event bus. The binding resolve it makes
 * is the sidebar's, memoized, so a poll costs a server request at most once
 * every few minutes. */
const POLL_MS = 5_000

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [lines, setLines] = createSignal<WelcomeLines | null>(null)
  let inFlight = false
  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const dir = props.api.state.path.directory
      // Resolved, not read from the cache alone: on a cold cache a linked project
      // would read as unlinked and the box would tell the user to run
      // `altimate-code link`. An unknown answer (the server unreachable) leaves
      // the box as it was rather than asserting either way.
      const outcome = await resolveBindingOutcome(dir).catch(() => ({ status: "unknown" }) as const)
      const snapshot = await boundAttachSnapshot(dir, outcome.status === "bound" ? outcome.binding : null)
      const next = welcomeLinesFor(outcome, snapshot)
      if (next) setLines(next)
    } finally {
      inFlight = false
    }
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const current = () => lines()
  return (
    <box gap={0} paddingTop={1}>
      <text fg={theme().accent}>
        <b>{current()?.mode ?? "Workspace mode"}</b>
      </text>
      <text fg={theme().text} wrapMode="word" width="100%">
        {current()?.commands ?? ""}
      </text>
      <text fg={theme().textMuted} wrapMode="word" width="100%">
        {current()?.integrations ?? ""}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      welcome_extra() {
        return <View api={api} />
      },
    },
  })
}

export default { id, tui } satisfies BuiltinTuiPlugin

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
import { resolveBindingOutcome, type BindingOutcome } from "@/altimate/workspace/state"
import { accountScope, boundAttachSnapshot } from "@/altimate/workspace/status-view"
import { nextWelcomeState, shouldResolveBinding, type WelcomeState } from "@/altimate/workspace/welcome-lines"

const id = "altimate:welcome-workspace"

/** The box is on screen before the first message and through the session,
 * so the integrations line has to pick up the attach after it settles; a short
 * poll of the snapshot file is the cheapest way without an event bus. The
 * binding is resolved far less often (`shouldResolveBinding`). */
const POLL_MS = 5_000

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [state, setState] = createSignal<WelcomeState>({ lines: null, scope: null })
  let inFlight = false
  let outcome: BindingOutcome = { status: "unknown" }
  let resolvedAt: number | null = null
  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const dir = props.api.state.path.directory
      // Resolved, not read from the cache alone: on a cold cache a linked project
      // would read as unlinked and the box would tell the user to run
      // `altimate-code link`. An unknown answer (the server unreachable) leaves
      // the box as it was rather than asserting either way.
      // Bracketed by two account reads: after an account switch the box must
      // not keep the previous account's workspace, nor pair one account's
      // binding with another's numbers.
      const scopeBefore = await accountScope()
      const now = Date.now()
      if (shouldResolveBinding({ now, resolvedAt, scopeNow: scopeBefore, shownScope: state().scope })) {
        outcome = await resolveBindingOutcome(dir).catch(() => ({ status: "unknown" }) as const)
        resolvedAt = now
      }
      const snapshot = boundAttachSnapshot(dir, outcome.status === "bound" ? outcome.binding : null, scopeBefore)
      const scopeAfter = await accountScope()
      setState((prev) => nextWelcomeState(prev, { scopeBefore, outcome, snapshot, scopeAfter }))
    } finally {
      inFlight = false
    }
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const current = () => state().lines
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

// altimate_change - new file
// The workspace-mode block inside the boot box, under "What is Altimate Code":
// which mode and workspace this is, the slash commands the mode adds, and what
// the last session got from the workspace. Registered unless
// ALTIMATE_DISABLE_WORKSPACE is set (see ./index.ts). Renders nothing until there is an
// answer to show: signed out, or the service not reached yet, the box is unchanged. Read-only, like the sidebar tile: the binding as the tile
// resolves it, the attach outcome from its snapshot file.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { resolveBindingOutcome, type BindingOutcome } from "@/altimate/workspace/state"
import { accountScope, boundAttachSnapshot } from "@/altimate/workspace/status-view"
import {
  nextWelcomeState,
  shouldResolveBinding,
  type WelcomeLines,
  type WelcomeState,
} from "@/altimate/workspace/welcome-lines"

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
  // The last binding answer, and the account it was resolved under: an answer
  // is only ever used under that same account.
  let outcome: BindingOutcome = { status: "unknown" }
  let answerScope: string | null = null
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
      if (shouldResolveBinding({ now, resolvedAt, scopeNow: scopeBefore, answerScope })) {
        outcome = await resolveBindingOutcome(dir).catch(() => ({ status: "unknown" }) as const)
        resolvedAt = now
        // Pinned to an account only if none switched during the resolve.
        answerScope = (await accountScope()) === scopeBefore ? scopeBefore : null
      }
      const answer: BindingOutcome =
        scopeBefore !== null && answerScope === scopeBefore ? outcome : { status: "unknown" }
      const snapshot = boundAttachSnapshot(dir, answer.status === "bound" ? answer.binding : null, scopeBefore)
      const scopeAfter = await accountScope()
      setState((prev) => nextWelcomeState(prev, { scopeBefore, outcome: answer, snapshot, scopeAfter }))
    } finally {
      inFlight = false
    }
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  return <WelcomeBlock lines={() => state().lines} theme={theme} />
}

/** The lines, under a root that is always there. OpenTUI's `Slot` shows its fallback for a plugin view
 * whose first render has no output, and renders the view again when that output changes. With a `<Show>`
 * root still waiting on the binding, the lines arriving mounted a new `View`, which started empty and
 * resolved again: the lines never stayed, the box remounted without end, and every keybinding (Ctrl+C,
 * Ctrl+P, Esc) stopped working, which is what took this box off the start screen in 0.12.6. */
export function WelcomeBlock(props: {
  lines: () => WelcomeLines | null
  theme: () => TuiPluginApi["theme"]["current"]
}) {
  return (
    <box>
      <Show when={props.lines()}>
        {(lines) => (
          <box gap={0} paddingTop={1}>
            <text fg={props.theme().accent}>
              <b>{lines().mode}</b>
            </text>
            <text fg={props.theme().text} wrapMode="word" width="100%">
              {lines().commands}
            </text>
            <text fg={props.theme().textMuted} wrapMode="word" width="100%">
              {lines().integrations}
            </text>
          </box>
        )}
      </Show>
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

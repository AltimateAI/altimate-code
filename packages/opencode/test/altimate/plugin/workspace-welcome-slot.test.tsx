/** @jsxImportSource @opentui/solid */
// altimate_change - new file
//
// The start-screen welcome box rendered nothing until the binding resolved. OpenTUI's `Slot` renders a plugin
// view's fallback when its first render is empty, and renders the view again when that output changes; the
// new view starts empty and fetches again, so the lines never stayed and the box remounted without end, and
// in the TUI every keybinding stopped working (0.12.5). These mount the real slot machinery with a view that,
// like the box, fills its own lines in after it mounts.
import { expect, test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import { createSignal, onMount, Show, type JSX } from "solid-js"
import { WelcomeBlock } from "@/plugin/tui/altimate/workspace-welcome"
import type { WelcomeLines } from "@/altimate/workspace/welcome-lines"

type Slots = { welcome_extra: {} }
const MAX_MOUNTS = 10

const theme = () => ({ accent: "#00ff00", text: "#ffffff", textMuted: "#888888" }) as never
const LINES: WelcomeLines = {
  mode: "Workspace mode · linked to acme",
  commands: "/workspace → Get started",
  integrations: "Integrations: attach on your first message",
}

/** Mounts a view that, like the box, owns its lines and fills them in after it mounts (the box resolves the
 * binding in `onMount`). `body` renders them. Returns the app and how many times the view was mounted. */
async function mountLate(body: (lines: () => WelcomeLines | null) => JSX.Element) {
  let mounts = 0
  const View = () => {
    const [lines, setLines] = createSignal<WelcomeLines | null>(null)
    onMount(() => {
      mounts++
      // Bounded: under the bare `<Show>` each arrival remounts the view, which fetches again, without end.
      if (mounts <= MAX_MOUNTS) queueMicrotask(() => setLines(LINES))
    })
    return body(lines)
  }
  const App = () => {
    const registry = createSolidSlotRegistry<Slots>(useRenderer(), {})
    const Slot = createSlot(registry)
    registry.register({ id: "welcome", slots: { welcome_extra: () => <View /> } })
    return (
      <box>
        <Slot name="welcome_extra" />
      </box>
    )
  }
  const app = await testRender(() => <App />, { width: 80, height: 10 })
  for (let i = 0; i < 5; i++) {
    await app.renderOnce()
    await Bun.sleep(5)
  }
  return { app, mounts: () => mounts }
}

test("the welcome block shows lines that arrive after its first render, mounted once", async () => {
  const { app, mounts } = await mountLate((lines) => <WelcomeBlock lines={lines} theme={theme} />)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Workspace mode · linked to acme")
    expect(frame).toContain("Integrations: attach on your first message")
    expect(mounts()).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

// The hazard itself, pinned so a change in OpenTUI is noticed: under a bare `<Show>` root, the lines arriving
// re-runs the slot's render, which mounts a new view that starts empty again, so they never stay on screen.
test("a slot view whose root renders nothing at first is remounted when its output arrives", async () => {
  const { app, mounts } = await mountLate((lines) => <Show when={lines()}>{(l) => <text>{l().mode}</text>}</Show>)
  try {
    expect(app.captureCharFrame()).not.toContain("Workspace mode")
    expect(mounts()).toBeGreaterThan(MAX_MOUNTS)
  } finally {
    app.renderer.destroy()
  }
})

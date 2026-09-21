/** @jsxImportSource @opentui/solid */
// altimate_change — dialog-level actions with in-dialog keybinds (#1328).
//
// The Skills browser's "Actions" picker was reachable only through a plugin-registered
// global keymap layer, which the open dialog's own layer (and its focused filter input)
// outranked, so ctrl+a never opened it. Declared as DialogSelect `actions` with `bindings`
// the chord is handled inside the dialog. This mounts a real DialogSelect in the provider
// stack and presses the key.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(
  opts: { bindings?: { key: string; cmd: string }[]; globalLayer?: boolean; via?: "core" | "adapter" } = {},
) {
  const [
    { DialogProvider, useDialog },
    { DialogSelect: CoreDialogSelect },
    { createTuiApiAdapters },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { KVProvider },
    { ArgsProvider },
    { ToastProvider },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/ui/dialog-select"),
    import("../../src/plugin/adapters"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/keymap"),
    import("../../src/context/kv"),
    import("../../src/context/args"),
    import("../../src/ui/toast"),
  ])
  const triggered: string[] = []

  // The plugin-API shape, exactly as skill-ops.tsx declares it: a function-valued
  // `disabled` (the synthetic Install row must not open the picker), and New / Install
  // `standalone` so they fire with no highlighted row.
  const actions = [
    {
      command: "altimate.skill.actions",
      title: "Actions",
      disabled: (o: { value: string } | undefined) => o === undefined || o.value === "__install__",
      onTrigger: (o: { value: string } | undefined) => triggered.push(`actions:${o?.value}`),
    },
    { command: "altimate.skill.create", title: "New", standalone: true, onTrigger: () => triggered.push("create") },
    { command: "altimate.skill.install", title: "Install", standalone: true, onTrigger: () => triggered.push("install") },
  ]
  const bindings = opts.bindings ?? [
    { key: "ctrl+a", cmd: "altimate.skill.actions" },
    { key: "ctrl+e", cmd: "altimate.skill.create" },
    { key: "ctrl+g", cmd: "altimate.skill.install" },
  ]
  const options = [
    { title: "alpha", value: "alpha" },
    { title: "beta", value: "beta" },
  ]

  function Opener() {
    const dialog = useDialog()
    if (opts.via === "adapter") {
      // Through the plugin API adapter — the seam skill-ops.tsx really goes through —
      // so a dropped `actions`/`bindings`/`standalone` forward fails here. The adapter's
      // DialogSelect reads only its props, so the rest of the input is not needed.
      const api = createTuiApiAdapters({
        version: "0",
        tuiConfig: { keybinds: { gather: () => [], get: () => [] } },
        keymap: { registerLayer: () => () => {} },
        dialog,
      } as never)
      dialog.replace(() => <api.ui.DialogSelect title="Skills" options={options} actions={actions} bindings={bindings} />)
      return <box />
    }
    dialog.replace(() => (
      <CoreDialogSelect
        title="Skills"
        options={options}
        actions={actions.map((a) => ({ ...a, standalone: a.standalone === true }))}
        bindings={bindings}
      />
    ))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    // The plugin's global layer, as skill-ops.tsx registers it at plugin init: the same
    // command name, bound to the same chord, active everywhere.
    if (opts.globalLayer) {
      const offGlobal = keymap.registerLayer({
        commands: [
          {
            name: "altimate.skill.actions",
            title: "Skill actions",
            run() {
              triggered.push("global")
            },
          },
        ],
        bindings: [{ key: "ctrl+a", cmd: "altimate.skill.actions" }],
      })
      onCleanup(offGlobal)
    }
    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <ThemeProvider mode="dark">
                    <DialogProvider>
                      <Opener />
                    </DialogProvider>
                  </ThemeProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />)
  await Bun.sleep(50)
  return { app, triggered }
}

test("ctrl+a inside an open DialogSelect triggers the declared action for the highlighted row", async () => {
  const { app, triggered } = await mount()
  try {
    app.mockInput.pressKey("a", { ctrl: true })
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["actions:alpha"])
  } finally {
    app.renderer.destroy()
  }
})

test("the action follows the highlight: Down then ctrl+a names the second row", async () => {
  const { app, triggered } = await mount()
  try {
    app.mockInput.pressKey("ARROW_DOWN")
    await Bun.sleep(20)
    app.mockInput.pressKey("a", { ctrl: true })
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["actions:beta"])
  } finally {
    app.renderer.destroy()
  }
})

test("a second action with its own chord fires independently", async () => {
  const { app, triggered } = await mount()
  try {
    app.mockInput.pressKey("e", { ctrl: true })
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["create"])
  } finally {
    app.renderer.destroy()
  }
})

test("without a binding the chord does nothing — the test proves the binding is what carries it", async () => {
  const { app, triggered } = await mount({ bindings: [] })
  try {
    app.mockInput.pressKey("a", { ctrl: true })
    await Bun.sleep(150)
    expect(triggered).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("REPRO: with the plugin's global layer registering the same command name, the dialog action is what fires", async () => {
  const { app, triggered } = await mount({ globalLayer: true })
  try {
    app.mockInput.pressKey("a", { ctrl: true })
    await Bun.sleep(200)
    expect(triggered).toEqual(["actions:alpha"])
  } finally {
    app.renderer.destroy()
  }
})

test("the actions render as footer buttons with their chords, so the picker is discoverable without one", async () => {
  const { app } = await mount({ globalLayer: true })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Actions")
    expect(frame).toContain("New")
    expect(frame).toMatch(/ctrl\+a|\^a/i)
  } finally {
    app.renderer.destroy()
  }
})

// Install is ctrl+g because ctrl+i is Tab on the wire for most terminals (byte 0x09), and
// Tab is the footer's own key. A Tab press must move footer focus, not run Install; the
// chord that runs it must be one no terminal folds into Tab. (bot review on #1342)
test("Tab walks the footer (Enter then activates the focused button) and does not run Install; ctrl+g does", async () => {
  const { app, triggered } = await mount()
  try {
    app.mockInput.pressKey("TAB")
    await Bun.sleep(150)
    expect(triggered).toEqual([])
    // Tab moved focus to the first footer button (Actions); Enter activates it.
    app.mockInput.pressKey("RETURN")
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["actions:alpha"])
    app.mockInput.pressKey("g", { ctrl: true })
    await wait(() => triggered.length > 1)
    expect(triggered).toEqual(["actions:alpha", "install"])
  } finally {
    app.renderer.destroy()
  }
})

// codex on #1342: New and Install need no highlighted row. Typing a name that matches no
// installed skill and pressing ctrl+e is the create-from-filter flow, and it did nothing.
test("with nothing matching the filter, ctrl+e still creates and ctrl+a (row-bound) does nothing", async () => {
  const { app, triggered } = await mount()
  try {
    for (const ch of "zzz") app.mockInput.pressKey(ch)
    await Bun.sleep(50)
    app.mockInput.pressKey("a", { ctrl: true })
    await Bun.sleep(100)
    expect(triggered).toEqual([])
    app.mockInput.pressKey("e", { ctrl: true })
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["create"])
  } finally {
    app.renderer.destroy()
  }
})

test("through the plugin API adapter: chords fire, standalone survives the mapping, row-bound gate holds", async () => {
  const { app, triggered } = await mount({ via: "adapter" })
  try {
    app.mockInput.pressKey("a", { ctrl: true })
    await wait(() => triggered.length > 0)
    expect(triggered).toEqual(["actions:alpha"])
    for (const ch of "zzz") app.mockInput.pressKey(ch)
    await Bun.sleep(50)
    app.mockInput.pressKey("a", { ctrl: true })
    await Bun.sleep(100)
    expect(triggered).toEqual(["actions:alpha"])
    app.mockInput.pressKey("g", { ctrl: true })
    await wait(() => triggered.length > 1)
    expect(triggered).toEqual(["actions:alpha", "install"])
  } finally {
    app.renderer.destroy()
  }
})

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

async function mount(opts: { bindings?: { key: string; cmd: string }[]; globalLayer?: boolean } = {}) {
  const [
    { DialogProvider, useDialog },
    { DialogSelect },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { KVProvider },
    { ArgsProvider },
    { ToastProvider },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/ui/dialog-select"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/keymap"),
    import("../../src/context/kv"),
    import("../../src/context/args"),
    import("../../src/ui/toast"),
  ])
  const triggered: string[] = []

  function Opener() {
    const dialog = useDialog()
    dialog.replace(() => (
      <DialogSelect
        title="Skills"
        options={[
          { title: "alpha", value: "alpha" },
          { title: "beta", value: "beta" },
        ]}
        actions={[
          {
            command: "altimate.skill.actions",
            title: "Actions",
            // A function-valued `disabled`, as the Skills browser passes (the synthetic
            // Install row must not open the picker).
            disabled: (o) => o === undefined || o.value === "__install__",
            onTrigger: (o) => triggered.push(`actions:${o.value}`),
          },
          { command: "altimate.skill.create", title: "New", onTrigger: () => triggered.push("create") },
        ]}
        bindings={
          opts.bindings ?? [
            { key: "ctrl+a", cmd: "altimate.skill.actions" },
            { key: "ctrl+e", cmd: "altimate.skill.create" },
          ]
        }
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

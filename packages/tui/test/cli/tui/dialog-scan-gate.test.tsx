/** @jsxImportSource @opentui/solid */
// altimate_change — AI-7778 coverage for the post-setup "Scan your environment?"
// gate. Mounts DialogScanGate in the real dialog stack and verifies the copy plus
// the three ways a user resolves it: `y`→scan, `n`→skip, and Enter on the default
// (Yes) selection→scan. Each choice must clear the dialog and hand the matching
// `/onboard-connect` arg to the injected onChoose callback.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountGate(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogScanGate },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-scan-gate"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  const chosen: Array<"scan" | "skip"> = []

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogScanGate onChoose={(arg) => chosen.push(arg)} />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
  return {
    app,
    chosen,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("scan gate renders the prompt copy and both choices", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    const frame = gate.app.captureCharFrame()
    expect(frame).toContain("Scan your environment?")
    expect(frame).toContain("I'll look for your dbt project and warehouses.")
    expect(frame).toContain("Yes")
    expect(frame).toContain("No")
    expect(frame).toContain("(Recommended)")
  } finally {
    await gate.cleanup()
  }
})

test("scan gate: pressing y chooses scan", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    gate.app.mockInput.pressKey("y")
    await wait(() => gate.chosen.length > 0)
    expect(gate.chosen).toEqual(["scan"])
  } finally {
    await gate.cleanup()
  }
})

test("scan gate: pressing n chooses skip", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    gate.app.mockInput.pressKey("n")
    await wait(() => gate.chosen.length > 0)
    expect(gate.chosen).toEqual(["skip"])
  } finally {
    await gate.cleanup()
  }
})

test("scan gate: Enter selects the default (Yes) and chooses scan", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    gate.app.mockInput.pressEnter()
    await wait(() => gate.chosen.length > 0)
    expect(gate.chosen).toEqual(["scan"])
  } finally {
    await gate.cleanup()
  }
})

// altimate_change — the gate submits `/onboard-connect` and records the funnel choice, so a
// double-fire both double-counts the event and runs the command twice. Keyboard and mouse
// handlers call run() directly with nothing between them and the dialog unmounting.
test("scan gate: a rapid second keypress does not choose twice", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    gate.app.mockInput.pressKey("y")
    gate.app.mockInput.pressKey("y")
    await wait(() => gate.chosen.length > 0)
    await Bun.sleep(50)
    expect(gate.chosen).toEqual(["scan"])
  } finally {
    await gate.cleanup()
  }
})

test("scan gate: y then n keeps the first choice", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGate(tmp.path)
  try {
    gate.app.mockInput.pressKey("y")
    gate.app.mockInput.pressKey("n")
    await wait(() => gate.chosen.length > 0)
    await Bun.sleep(50)
    expect(gate.chosen).toEqual(["scan"])
  } finally {
    await gate.cleanup()
  }
})

// altimate_change start — funnel wiring, mounted the way app.tsx actually mounts it.
//
// mountGate() above renders the gate as a plain child of DialogProvider, which is why every test
// there passed while the recorded outcome was wrong in the product: app.tsx mounts it through
// `dialog.replace(fn, onClose)` and registers a latched dismissal recorder as that onClose. The
// gate's run() calls dialog.clear() — which fires onClose synchronously — so an outcome recorded
// after the clear loses to the dismissal latch. This harness reproduces that wiring exactly.
async function mountGateAsApp(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogScanGate },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-scan-gate"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  const chosen: Array<"scan" | "skip"> = []
  const recorded: Array<"scan" | "skip" | "dismissed"> = []

  // Same latch as app.tsx: the close handler must not overwrite a real choice.
  let latched = false
  function record(outcome: "scan" | "skip" | "dismissed") {
    if (latched) return
    latched = true
    recorded.push(outcome)
  }

  function Opener() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(
        () => <DialogScanGate onOutcome={record} onChoose={(arg) => chosen.push(arg)} />,
        () => record("dismissed"),
      )
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Opener />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
  return { app, chosen, recorded, async cleanup() { app.renderer.destroy() } }
}

test("scan gate wired as app.tsx does: a real choice is recorded as the choice, not a dismissal", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGateAsApp(tmp.path)
  try {
    gate.app.mockInput.pressKey("y")
    await wait(() => gate.chosen.length > 0)
    await Bun.sleep(50)
    expect(gate.chosen).toEqual(["scan"])
    // The regression: dialog.clear() inside run() fires the close handler, so recording the
    // outcome after the clear reported "dismissed" for every Yes and every No.
    expect(gate.recorded).toEqual(["scan"])
  } finally {
    await gate.cleanup()
  }
})

test("scan gate wired as app.tsx does: skip is recorded as skip", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGateAsApp(tmp.path)
  try {
    gate.app.mockInput.pressKey("n")
    await wait(() => gate.chosen.length > 0)
    await Bun.sleep(50)
    expect(gate.recorded).toEqual(["skip"])
  } finally {
    await gate.cleanup()
  }
})

test("scan gate wired as app.tsx does: escape records exactly one dismissal", async () => {
  await using tmp = await tmpdir()
  const gate = await mountGateAsApp(tmp.path)
  try {
    // Escape is handled by DialogProvider, never by the gate's own handlers — the close handler
    // is the only thing that can see it.
    gate.app.mockInput.pressKey("ESCAPE")
    await wait(() => gate.recorded.length > 0)
    await Bun.sleep(50)
    expect(gate.recorded).toEqual(["dismissed"])
    expect(gate.chosen).toEqual([])
  } finally {
    await gate.cleanup()
  }
})
// altimate_change end

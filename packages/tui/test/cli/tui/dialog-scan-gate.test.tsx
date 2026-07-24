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
import { onCleanup } from "solid-js"
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

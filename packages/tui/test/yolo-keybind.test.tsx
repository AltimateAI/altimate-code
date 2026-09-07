/** @jsxImportSource @opentui/solid */
// altimate_change — the ctrl+y binding contract for YOLO mode.
//
// The scoping rules are covered in test/util/yolo.test.ts; this file covers the
// half that lives in config, i.e. that the shortcut the ticket specifies actually
// resolves to the toggle command and can be remapped like any other binding.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap } from "../src/keymap"

const COMMAND = "session.yolo.toggle"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

async function strokesFor(overrides: TuiKeybind.KeybindOverrides = {}) {
  const captured: { sequence: string[][] } = { sequence: [] }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig(overrides)
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [{ name: COMMAND, run() {} }],
      bindings: config.keybinds.gather("session", [COMMAND]),
    })
    const bindings = keymap.getCommandBindings({ visibility: "registered", commands: [COMMAND] })
    captured.sequence =
      bindings.get(COMMAND)?.map((binding) =>
        binding.sequence.map((part) => {
          const stroke = part.stroke
          return [stroke.ctrl ? "ctrl" : "", stroke.name].filter(Boolean).join("+")
        }),
      ) ?? []
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    return captured.sequence
  } finally {
    app.renderer.destroy()
  }
}

test("yolo toggle is bound to ctrl+y by default", async () => {
  expect(await strokesFor()).toEqual([["ctrl+y"]])
})

test("yolo toggle can be remapped like any other binding", async () => {
  expect(await strokesFor({ session_yolo_toggle: "ctrl+g" })).toEqual([["ctrl+g"]])
})

test("yolo toggle can be disabled entirely", async () => {
  expect(await strokesFor({ session_yolo_toggle: "none" })).toEqual([])
})

test("ctrl+y is not claimed by another session-scope command", async () => {
  // Scoped deliberately to session_* bindings rather than every definition: this
  // codebase intentionally reuses the same stroke across different layers (ctrl+f is
  // session_pin_toggle, model_favorite_toggle, input_move_right AND
  // permission.prompt.fullscreen), so a global "nothing else may use ctrl+y" assertion
  // would fire on a perfectly legitimate future binding in an unrelated dialog. The
  // real ambiguity risk is two commands in the SAME layer.
  const conflicts = Object.entries(TuiKeybind.Definitions)
    .filter(([name]) => name.startsWith("session_") && name !== "session_yolo_toggle")
    .filter(([, definition]) => {
      const value = definition.default
      const values = Array.isArray(value) ? value : [value]
      return values.some((item) => typeof item === "string" && item.split(",").includes("ctrl+y"))
    })
    .map(([name]) => name)
  expect(conflicts).toEqual([])
})

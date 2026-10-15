// ALT-P02
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { getOwner } from "solid-js"
import type { PromptRef } from "../src/component/prompt"
import { Keymap } from "../src/context/keymap"
import { PromptRefProvider, usePromptRef } from "../src/context/prompt"
import { createPluginContext, type Dispose, type Registry, type usePluginHost } from "../src/plugin/api"
import { emptyPrompt } from "../src/prompt/history"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function setup() {
  const owned: Dispose[] = []
  let context!: Context
  let prompt!: ReturnType<typeof usePromptRef>
  let editor!: TextareaRenderable
  let current: PromptRef["current"] = {
    ...emptyPrompt(),
    text: "draft",
    agents: [{ name: "build", mention: { start: 0, end: 5, text: "draft" } }],
    pasted: [{ text: "expanded text", source: { start: 0, end: 5, text: "draft" } }],
  }
  const ref: PromptRef = {
    get current() {
      return current
    },
    get focused() {
      return editor.focused
    },
    mode: "normal",
    setMode() {},
    set(value) {
      current = value
      editor.setText(value.text)
    },
    reset() {},
    blur: () => editor.blur(),
    focus: () => editor.focus(),
    submit() {},
  }

  function Probe() {
    prompt = usePromptRef()
    prompt.set(ref)
    // Other host services are unused; exercise the real prompt registry and keymap.
    const host = {
      owner: getOwner(),
      app: {},
      client: {},
      keymap: Keymap.use(),
      shortcuts: Keymap.useShortcuts(),
      keymapState: Keymap.useState(),
      sessionTabs: {},
      prompt,
    } as unknown as ReturnType<typeof usePluginHost>
    const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => true }
    context = createPluginContext({ host, id: "test", options: undefined, owned, registry })
    context.keymap.layer(() => ({
      commands: [
        {
          id: "test.rewrite",
          title: "Rewrite draft",
          run: () => {
            context.ui.composer.set(`${context.ui.composer.get()} rewritten`)
            context.ui.composer.focus()
          },
        },
      ],
    }))
    return <textarea ref={editor} initialValue="draft" />
  }

  const app = await testRender(
    () => (
      <Keymap.Provider config={createTuiResolvedConfig()}>
        <PromptRefProvider>
          <Probe />
        </PromptRefProvider>
      </Keymap.Provider>
    ),
    { width: 80, height: 10 },
  )
  await app.renderOnce()
  return {
    ...app,
    context,
    prompt,
    ref,
    editor,
    async [Symbol.asyncDispose]() {
      await Promise.all(owned.map((dispose) => dispose()))
      app.renderer.destroy()
    },
  }
}

test("a plugin command reads, replaces, and focuses the active composer", async () => {
  await using fixture = await setup()
  const before = fixture.context.ui.composer.get()
  expect(before).toBe("draft")

  fixture.context.keymap.dispatch("test.rewrite")
  await fixture.renderOnce()

  expect(before).toBe("draft")
  expect(fixture.context.ui.composer.get()).toBe("draft rewritten")
  expect(fixture.ref.current).toEqual({ ...emptyPrompt(), text: "draft rewritten" })
  expect(fixture.captureCharFrame()).toContain("draft rewritten")
  expect(fixture.editor.focused).toBe(true)
})

test("composer methods follow the current prompt and report an absent composer", async () => {
  await using fixture = await setup()
  fixture.prompt.set(undefined)

  expect(fixture.context.ui.composer.get()).toBeUndefined()
  expect(fixture.context.ui.composer.set("ignored")).toBe(false)
  expect(fixture.context.ui.composer.focus()).toBe(false)
  expect(fixture.ref.current.text).toBe("draft")

  fixture.prompt.set(fixture.ref)
  expect(fixture.context.ui.composer.set("")).toBe(true)
  expect(fixture.context.ui.composer.get()).toBe("")
  expect(fixture.context.ui.composer.focus()).toBe(true)

  fixture.editor.blur()
  fixture.editor.focusable = false
  expect(fixture.context.ui.composer.focus()).toBe(false)
})

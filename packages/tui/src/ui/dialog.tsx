import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createEffect, onCleanup, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { useTheme } from "../context/theme"
import { MouseButton, Renderable, RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { useClipboard } from "../context/clipboard"

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  let dismiss = false
  const width = () => {
    if (props.size === "xlarge") return 116
    if (props.size === "large") return 88
    return 60
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
    size: "medium" as "medium" | "large" | "xlarge",
  })

  const renderer = useRenderer()
  const modeStack = useOpencodeModeStack()
  // altimate_change start — allow a modal to veto every dialog replacement/close path. `reason`
  // distinguishes a user dismissal (Escape, via `closeTop("dismiss")`) from a programmatic close
  // (`clear()`/`replace()`, whether that is this same dialog closing itself, a click-away, or an
  // unrelated feature — command palette, session list — taking over the dialog stack) from a
  // Ctrl+C interrupt (via `closeTop("interrupt")`, PR review round 3: Ctrl+C is a "get me out"
  // gesture, distinct from Escape's "I decline this dialog specifically" — a guard that treated
  // them the same made quitting with Ctrl+C twice while the migration dialog was open persist a
  // refusal the user never made, since the guard queued the decline+picker on the FIRST Ctrl+C).
  let closeGuard: ((reason: "dismiss" | "interrupt" | "programmatic") => boolean) | undefined

  function canClose(reason: "dismiss" | "interrupt" | "programmatic") {
    return closeGuard?.(reason) ?? true
  }
  // altimate_change end

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = modeStack.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  // altimate_change start — centralize guarded single-dialog close behavior. `reason` defaults to
  // "dismiss" (Escape's behavior before Ctrl+C got its own reason below) but every caller now
  // passes explicitly.
  function closeTop(reason: "dismiss" | "interrupt" = "dismiss") {
    if (!canClose(reason)) return false
    const current = store.stack.at(-1)
    current?.onClose?.()
    setStore("stack", store.stack.slice(0, -1))
    refocus()
    return true
  }
  // altimate_change end

  useBindings(() => ({
    enabled: store.stack.length > 0 && !renderer.getSelection()?.getSelectedText(),
    bindings: [
      {
        key: "escape",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          // altimate_change start — preserve selection when the active close guard vetoes Escape
          if (!closeTop("dismiss")) return
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          // altimate_change end
        },
      },
      {
        key: "ctrl+c",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          // altimate_change start — preserve selection when the active close guard vetoes Ctrl-C.
          // PR review round 3: "interrupt", not "dismiss" — Ctrl+C is a "get me out" gesture, not
          // a refusal of whatever dialog happens to be open (see the guard's declaration above).
          if (!closeTop("interrupt")) return
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          // altimate_change end
        },
      },
    ],
  }))

  // altimate_change start — fixes #1301 (Codex review round 2, P2): shared body for `clear()`
  // (a "programmatic" close — used all over the codebase, including a dialog closing itself) and
  // `dismiss()` (a "dismiss" close — the ONE caller is the backdrop click, which is just as much
  // a user dismissal as Escape/Ctrl+C and must be reported to the guard the same way).
  function clearAll(reason: "dismiss" | "programmatic") {
    if (!canClose(reason)) return false
    for (const item of store.stack) {
      if (item.onClose) item.onClose()
    }
    batch(() => {
      setStore("size", "medium")
      setStore("stack", [])
    })
    refocus()
    return true
  }
  // altimate_change end

  return {
    // altimate_change start — fixes #1301 (Codex review round 2, P2): `clear()` is the
    // programmatic close path; `dismiss()` is the backdrop click only, wired in
    // `DialogProvider`'s `<Dialog onClose={...}>` below — see `clearAll` above.
    clear() {
      return clearAll("programmatic")
    },
    dismiss() {
      return clearAll("dismiss")
    },
    // altimate_change end
    replace(input: any, onClose?: () => void) {
      // altimate_change start — replacement is a close path and must obey the same guard
      if (!canClose("programmatic")) return false
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "medium")
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
      return true
      // altimate_change end
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
    // altimate_change start — install and safely dispose the active close guard
    guardClose(guard: (reason: "dismiss" | "interrupt" | "programmatic") => boolean) {
      closeGuard = guard
      return () => {
        if (closeGuard === guard) closeGuard = undefined
      }
    },
    // altimate_change end
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()

  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text || !clipboard.write) return false
    void clipboard.write(text).then(
      () => toast.show({ message: "Copied to clipboard", variant: "info" }),
      (error) => toast.error(error),
    )
    renderer.clearSelection()
    return true
  }

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: number; preventDefault(): void; stopPropagation(): void }) => {
          if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copySelection()) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? copySelection : undefined}
      >
        <Show when={value.stack.length}>
          {/* altimate_change start — fixes #1301: backdrop click is a USER dismissal, same as
              Escape/Ctrl+C. `dismiss()` reports "dismiss" to the close guard, unlike every other
              `clear()`/`replace()` call site (self-close, or an unrelated feature taking over
              the stack), which stays "programmatic". */}
          <Dialog onClose={() => value.dismiss()} size={value.size}>
            {value.stack.at(-1)!.element}
          </Dialog>
          {/* altimate_change end */}
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

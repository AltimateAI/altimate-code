import { createSignal, For, Show, onMount } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

// altimate_change — interactive onboarding activation menu. Renders the option
// labels the agent composed (handed over via TuiEvent.ActivationMenuShow) as an
// arrow-selectable picker, matching the rest of the TUI (model picker, scan gate).
// Selecting a row submits that label as the user's next message via `onChoose`,
// so the agent's existing routing (start the chosen job) is unchanged.
//
// `onChoose` is injected by App (which lives inside PromptRefProvider); this
// dialog is mounted above that provider, so it cannot resolve the prompt ref
// itself and must be handed the submit callback.
export function DialogActivationMenu(props: {
  intro?: string
  options: string[]
  onChoose: (option: string) => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(0)

  onMount(() => {
    dialog.setSize("large")
    // altimate_change — anchor at the bottom (near the input) so it reads as a
    // continuation of the chat, like the text menu it replaced, not a centered modal.
    dialog.setAlign("bottom")
  })

  function choose(option: string) {
    dialog.clear()
    props.onChoose(option)
  }

  useKeyboard((evt) => {
    const count = props.options.length
    if (evt.name === "up") {
      setSelected((prev) => (prev - 1 + count) % count)
      evt.preventDefault()
      return
    }
    if (evt.name === "down") {
      setSelected((prev) => (prev + 1) % count)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      choose(props.options[selected()])
      return
    }
    // Number keys still work (1..N), preserving the old muscle memory.
    const n = Number.parseInt(evt.name, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= count) {
      evt.preventDefault()
      choose(props.options[n - 1])
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" What would you like to do? "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Pick a starting point
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <Show when={props.intro}>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            {props.intro}
          </text>
        </Show>
        <box>
          <For each={props.options}>
            {(option, index) => {
              const active = () => selected() === index()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseMove={() => setSelected(index())}
                  onMouseUp={() => choose(option)}
                >
                  <text flexShrink={0} fg={theme.primary}>
                    {active() ? "❯" : " "}
                  </text>
                  <box
                    width={3}
                    flexShrink={0}
                    alignItems="center"
                    backgroundColor={active() ? theme.primary : transparent}
                  >
                    <text fg={active() ? selFg : theme.textMuted}>{index() + 1}</text>
                  </box>
                  <box flexGrow={1}>
                    <text
                      fg={active() ? theme.text : theme.textMuted}
                      wrapMode="word"
                      width="100%"
                      attributes={active() ? TextAttributes.BOLD : undefined}
                    >
                      {option}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </box>
  )
}

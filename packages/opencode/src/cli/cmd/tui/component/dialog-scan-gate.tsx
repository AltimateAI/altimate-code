import { createSignal, For, onMount } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

// altimate_change — Part 2 scan gate. Shown once, immediately after Part 1
// completes (a model is ready and chat is live). We do NOT auto-scan; the user
// chooses. Yes/No each submit the hidden `/onboard-connect` command (scan|skip),
// which starts a session and lets the agent run the branch flow. Help text is
// verbatim from the locked spec.
//
// `onChoose` is injected by App (which lives inside PromptRefProvider); the dialog
// overlay is mounted above that provider, so the gate cannot resolve the prompt
// ref itself — it must be handed in.
export function DialogScanGate(props: { onChoose: (arg: "scan" | "skip") => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(0) // 0 = Yes (default, per spec ❯)

  onMount(() => dialog.setSize("large"))

  function run(arg: "scan" | "skip") {
    dialog.clear()
    props.onChoose(arg)
  }

  const options = [
    {
      label: "Yes",
      run: () => run("scan"),
      help:
        "Reads config files and env vars already on this machine (dbt profiles, warehouse settings) to " +
        "find your dbt project and warehouse connections. Nothing leaves your computer; no credentials " +
        "are entered yet.",
    },
    {
      label: "No",
      run: () => run("skip"),
      help: "Skip for now — tell me what you're working on and I'll help set it up when you're ready. You can run /discover anytime.",
    },
  ]

  useKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "down") {
      setSelected((prev) => (prev + 1) % 2)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      options[selected()].run()
      return
    }
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      run("scan")
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      run("skip")
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Scan your environment?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>I'll look for your dbt project and warehouses.</text>
      <box gap={1}>
        <For each={options}>
          {(option, index) => {
            const active = () => selected() === index()
            return (
              <box flexDirection="row" gap={1} onMouseMove={() => setSelected(index())} onMouseUp={() => option.run()}>
                <text flexShrink={0} fg={theme.primary}>
                  {active() ? "❯" : " "}
                </text>
                <box
                  width={6}
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : transparent}
                >
                  <text fg={active() ? selFg : theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
                    {option.label}
                  </text>
                </box>
                <box flexGrow={1}>
                  <text fg={theme.textMuted} wrapMode="word" width="100%">
                    {option.help}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

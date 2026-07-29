import { createSignal, For, onMount } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog } from "../ui/dialog"

// altimate_change — Part 2 scan gate. Shown once, immediately after Part 1
// completes (a model is ready and chat is live). We do NOT auto-scan; the user
// chooses. Yes/No each submit the hidden `/onboard-connect` command (scan|skip),
// which starts a session and lets the agent run the branch flow. Yes carries a
// "(Recommended)" tag (theme.success, matching the model picker's house style).
//
// `onChoose` is injected by App (which lives inside PromptRefProvider); the dialog
// overlay is mounted above that provider, so the gate cannot resolve the prompt
// ref itself — it must be handed in.
export function DialogScanGate(props: { onChoose: (arg: "scan" | "skip") => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(0) // 0 = Yes (default, per spec ❯)

  onMount(() => dialog.setSize("large"))

  // altimate_change — keyboard (return / y / n) and mouse handlers all call run() directly, and
  // nothing stops two firing before the dialog unmounts. Without this guard a fast double-press
  // submits `/onboard-connect` twice and double-counts the funnel choice.
  let chosen = false

  function run(arg: "scan" | "skip") {
    if (chosen) return
    chosen = true
    dialog.clear()
    props.onChoose(arg)
  }

  const options = [
    {
      label: "Yes",
      recommended: true,
      run: () => run("scan"),
      help: "Reads local config and env vars. Nothing leaves your computer; no credentials needed.",
    },
    {
      label: "No",
      recommended: false,
      run: () => run("skip"),
      help: "Skip for now. Run /discover anytime.",
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
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" Step 2 of 2 "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
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
                  <text wrapMode="word" width="100%">
                    {option.recommended ? <span style={{ fg: theme.success }}>(Recommended) </span> : null}
                    <span style={{ fg: theme.textMuted }}>{option.help}</span>
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

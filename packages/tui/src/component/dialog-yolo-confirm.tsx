import { createSignal, For, onMount } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog } from "../ui/dialog"

// altimate_change — YOLO mode confirmation gate (ctrl+y).
//
// Shown only when ENABLING. Disabling is immediate and unconfirmed, because
// turning a dangerous mode off should never have friction.
//
// The copy deliberately states what stays protected as well as what stops
// asking. Yolo can only auto-answer prompts the SERVER chose to raise:
// Permission.ask (packages/opencode/src/permission/index.ts) evaluates the
// ruleset first and refuses "deny" matches outright without emitting an event,
// so the configured guardrails (DROP DATABASE / DROP SCHEMA / TRUNCATE, on both
// bash and sql_execute_write — see packages/opencode/src/agent/agent.ts) are
// unreachable from here. Overstating the risk would be as misleading as
// understating it, so we name both halves.
//
// Defaults to "No" — unlike the scan gate, the safe choice is the passive one.
export function DialogYoloConfirm(props: { onChoose: (enable: boolean) => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(1) // 1 = No (safe default)

  onMount(() => dialog.setSize("large"))

  function run(enable: boolean) {
    dialog.clear()
    props.onChoose(enable)
  }

  const options = [
    {
      label: "Yes",
      run: () => run(true),
      help: "Stop asking for this conversation and its subagents.",
    },
    {
      label: "No",
      run: () => run(false),
      help: "Keep asking before each action.",
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
      run(true)
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      run(false)
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.warning}
        title=" YOLO mode "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Turn on YOLO mode for this session?
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word" width="100%">
          The agent will run actions without asking you first — including editing files, running shell commands like{" "}
          <span style={{ fg: theme.text }}>rm -rf</span> and{" "}
          <span style={{ fg: theme.text }}>git push --force</span>, and reading .env files.
        </text>
        <text fg={theme.textMuted} wrapMode="word" width="100%">
          <span style={{ fg: theme.success }}>Still blocked: </span>
          your configured guardrails stay in force. DROP DATABASE, DROP SCHEMA and TRUNCATE remain denied and are not
          auto-approved.
        </text>
        <text fg={theme.textMuted} wrapMode="word" width="100%">
          Applies to this conversation and any subagents it spawns, and turns off when you quit. Press{" "}
          <span style={{ fg: theme.text }}>ctrl+y</span> again to turn it off.
        </text>
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

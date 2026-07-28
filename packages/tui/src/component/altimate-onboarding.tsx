// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Big
// Pickle interstitial. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createMemo, createSignal, For, Show, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"

// Session-scoped "setup complete" flag. Set when the user picks a ready model,
// chooses the free Big Pickle option, or finishes the gateway flow. Combined with
// useConnected() (real credentials) via useReady(), it gates the first-run chat
// lock. Module-global so it is shared across the app and resets on every process
// launch (so a fresh relaunch is a clean fresh-user state).
const [setupComplete, setSetupComplete] = createSignal(false)
export function markSetupComplete() {
  setSetupComplete(true)
}
// Cleared on /logout so first-run tips don't keep showing "you're all set" after
// the credential is gone.
export function resetSetupComplete() {
  setSetupComplete(false)
}
export function useReady() {
  const connected = useConnected()
  return createMemo(() => connected() || setupComplete())
}

// First-run welcome picker (presentation only; reuses the same action handlers as
// DialogModel/createDialogProviderOptions). A curated six: five recommended
// providers + a "Search all providers…" row that hands off to the full DialogModel
// picker. The long tail stays behind search.
const NAME_W = 24
type WelcomeTone = "success" | "warning" | "muted"

interface WelcomeRow {
  name: string
  note: string
  tone: WelcomeTone
  activate: () => void
  // Identifies the row for the "currently selected" tick. providerID alone matches
  // any model of that provider; add modelID to match a specific model (Big Pickle).
  providerID?: string
  modelID?: string
}

export function DialogModelWelcome(props: { intro?: string }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const providers = createDialogProviderOptions()
  const [selected, setSelected] = createSignal(0)

  onMount(() => dialog.setSize("large"))

  function connectProvider(id: string) {
    // Reuse the exact provider onSelect (gateway flow for altimate-backend,
    // auth-method screens for the BYOK providers).
    providers()
      .find((o) => o.value === id)
      ?.onSelect?.()
  }

  function chooseBigPickle() {
    dialog.replace(() => <DialogBigPickleConfirm origin="welcome" />)
  }

  function openFullCatalog() {
    dialog.replace(() => <DialogModel />)
  }

  const rows = createMemo<WelcomeRow[]>(() => [
    {
      name: "Altimate LLM Gateway",
      note: "Recommended · best for data work · 10M free tokens",
      tone: "success",
      providerID: "altimate-backend",
      activate: () => connectProvider("altimate-backend"),
    },
    {
      name: "Anthropic (Claude)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "anthropic",
      activate: () => connectProvider("anthropic"),
    },
    {
      name: "OpenAI (GPT)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "openai",
      activate: () => connectProvider("openai"),
    },
    {
      name: "Google (Gemini)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "google",
      activate: () => connectProvider("google"),
    },
    {
      name: "Big Pickle",
      note: "free · less reliable for data work",
      tone: "warning",
      providerID: "opencode",
      modelID: "big-pickle",
      activate: chooseBigPickle,
    },
    { name: "Search all providers…", note: "/", tone: "muted", activate: openFullCatalog },
  ])

  // The currently active model → drives the green "selected" tick.
  const current = createMemo(() => local.model.current())
  const isCurrent = (row: WelcomeRow) => {
    const c = current()
    if (!row.providerID || !c || c.providerID !== row.providerID) return false
    return row.modelID ? c.modelID === row.modelID : true
  }

  // Indices 0-4 are providers, 5 is the search row (rendered below a divider).
  const COUNT = 6
  function move(direction: number) {
    setSelected((prev) => (prev + direction + COUNT) % COUNT)
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) return move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) return move(1)
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      rows()[selected()].activate()
      return
    }
    // "/", ctrl+a, or any letter/number reveals the full searchable catalog.
    if (evt.name === "/" || (evt.ctrl && evt.name === "a") || /^[a-z0-9]$/i.test(evt.name ?? "")) {
      evt.preventDefault()
      openFullCatalog()
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  const noteColor = (tone: WelcomeTone) =>
    tone === "success" ? theme.success : tone === "warning" ? theme.warning : theme.textMuted

  const Row = (props: { row: WelcomeRow; index: number }) => {
    const active = createMemo(() => selected() === props.index)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseMove={() => setSelected(props.index)}
        onMouseUp={() => props.row.activate()}
      >
        <text flexShrink={0} fg={theme.primary}>
          {active() ? "›" : " "}
        </text>
        <box
          width={NAME_W}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={active() ? theme.primary : transparent}
        >
          <text
            fg={active() ? selFg : theme.text}
            attributes={active() ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {props.row.name}
          </text>
        </box>
        {/* bright green so it reads clearly even where ANSI green renders dim */}
        <text flexShrink={0} fg={theme.diffHighlightAdded} attributes={TextAttributes.BOLD}>
          {isCurrent(props.row) ? "✓" : " "}
        </text>
        <text flexGrow={1} fg={noteColor(props.row.tone)} wrapMode="none">
          {isCurrent(props.row) ? `${props.row.note} · selected` : props.row.note}
        </text>
      </box>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <Show when={props.intro}>
        <box paddingBottom={1} paddingLeft={1}>
          <text fg={theme.textMuted}>{props.intro}</text>
        </box>
      </Show>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" Altimate Code "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <text wrapMode="none">
          <span style={{ fg: theme.text }}>
            <b>Select a provider</b>
          </span>
          <span style={{ fg: theme.textMuted }}> — you can change this anytime with /model</span>
        </text>
        <box gap={0}>
          <For each={rows().slice(0, 5)}>{(row, i) => <Row row={row} index={i()} />}</For>
        </box>
        <box border={["top"]} borderColor={theme.border} />
        <Row row={rows()[5]} index={5} />
      </box>
    </box>
  )
}

// Big Pickle interstitial — one confirm, default No. Custom component (not
// DialogSelect) so the full warning wraps instead of clipping; y/n keys work,
// enter accepts the highlighted row (No by default).
export function DialogBigPickleConfirm(props: { origin: "welcome" | "model" }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)

  function no() {
    dialog.replace(() => (props.origin === "welcome" ? <DialogModelWelcome /> : <DialogModel />))
  }
  function yes() {
    dialog.clear()
    local.model.set({ providerID: "opencode", modelID: "big-pickle" }, { recent: true })
    markSetupComplete()
  }
  const options = [
    { label: "No — pick something else", hint: "(default)", run: no },
    { label: "Yes — continue with Big Pickle", hint: "", run: yes },
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
      yes()
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      no()
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Use Big Pickle?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        Big Pickle works for chat but often fails at data tasks. The Gateway is free to start (10M tokens). Continue?
        [y/N]
      </text>
      <box>
        <For each={options}>
          {(option, index) => (
            <box flexDirection="row" gap={1} onMouseMove={() => setSelected(index())} onMouseUp={() => option.run()}>
              <text flexShrink={0} fg={theme.primary}>
                {selected() === index() ? "›" : " "}
              </text>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected() === index() ? theme.primary : transparent}
              >
                <text
                  fg={selected() === index() ? selFg : theme.text}
                  attributes={selected() === index() ? TextAttributes.BOLD : undefined}
                >
                  {option.label}
                </text>
              </box>
              <Show when={option.hint}>
                <text fg={theme.textMuted}>{option.hint}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

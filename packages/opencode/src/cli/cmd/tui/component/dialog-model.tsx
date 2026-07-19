import { createMemo, createSignal, For, Show, onMount } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider, WARNLIST } from "./dialog-provider"
import { useKeybind } from "../context/keybind"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

// altimate_change start — session-scoped "setup complete" flag. Set when the user
// picks a ready model, chooses the free Big Pickle option, or finishes the gateway
// flow. Combined with useConnected() (real credentials) via useReady(), it gates the
// first-run chat lock. Module-global so it is shared across the app and resets on every
// process launch (so PROTO_FRESH relaunch is a clean fresh-user state).
const [setupComplete, setSetupComplete] = createSignal(false)
export function markSetupComplete() {
  setSetupComplete(true)
}
export function useReady() {
  const connected = useConnected()
  return createMemo(() => connected() || setupComplete())
}
// altimate_change end

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  // A provider is "ready" (usable now) when it has valid credentials: it is present
  // in the live provider list with at least one model — and, for the free OpenCode
  // provider, with at least one paid model (a Zen key entered).
  function providerReady(id: string) {
    const p = sync.data.provider.find((x) => x.id === id)
    if (!p) return false
    if (id === "opencode") return Object.values(p.models).some((m) => m.cost?.input !== 0)
    return Object.keys(p.models).length > 0
  }

  const options = createMemo(() => {
    const needle = query().trim()
    const favorites = local.model.favorite()

    // READY — models from providers that already have valid credentials. Selecting
    // one switches instantly.
    const readyOptions = pipe(
      sync.data.provider,
      filter((provider) => providerReady(provider.id)),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([modelID, info]) => {
            const warn = WARNLIST[modelID]
            const isFav = favorites.some((f) => f.providerID === provider.id && f.modelID === modelID)
            return {
              value: { providerID: provider.id, modelID } as { providerID: string; modelID: string } | string,
              title: info.name ?? modelID,
              description: warn ? `${provider.name} · ${warn}` : provider.name,
              category: "READY",
              footer: isFav ? "★" : undefined,
              onSelect() {
                dialog.clear()
                local.model.set({ providerID: provider.id, modelID }, { recent: true })
                markSetupComplete()
              },
            }
          }),
          sortBy((x) => x.title),
        ),
      ),
    )

    // NEEDS SETUP — providers without valid credentials (selecting routes into their
    // auth flow first), plus the free Big Pickle option. Hidden when scoped to one
    // provider (post-connect model list).
    const setupOptions = props.providerID
      ? []
      : (() => {
          const list = providers()
            .filter((o) => !providerReady(o.value))
            .map((o) => ({
              value: o.value as { providerID: string; modelID: string } | string,
              title: o.title,
              description: o.description,
              category: "NEEDS SETUP",
              footer: undefined as string | undefined,
              onSelect: o.onSelect,
            }))
          const bigPickle = {
            value: "big-pickle" as { providerID: string; modelID: string } | string,
            title: "Big Pickle",
            description: "free, no signup — slower, unreliable tool-calling",
            category: "NEEDS SETUP",
            footer: undefined as string | undefined,
            async onSelect() {
              dialog.replace(() => <DialogBigPickleConfirm origin="model" />)
            },
          }
          // Big Pickle sits at priority 4 — just above OpenCode Zen (priority 5).
          const zenIdx = list.findIndex((o) => o.value === "opencode")
          if (zenIdx === -1) list.push(bigPickle)
          else list.splice(zenIdx, 0, bigPickle)
          return list
        })()

    if (needle) {
      return [
        ...fuzzysort.go(needle, readyOptions, { keys: ["title", "description"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, setupOptions, { keys: ["title", "description"] }).map((x) => x.obj),
      ]
    }

    return [...readyOptions, ...setupOptions]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => provider()?.name ?? "Select model")

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

// altimate_change start — first-run welcome picker (presentation only; reuses the
// same action handlers as DialogModel/createDialogProviderOptions). A curated six:
// five recommended providers + a "Search all providers…" row that hands off to the
// full DialogModel picker. The long tail stays behind search.
const NAME_W = 24
type WelcomeTone = "success" | "warning" | "muted"

interface WelcomeRow {
  name: string
  note: string
  tone: WelcomeTone
  activate: () => void
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
      note: "Recommended · best tool-calling · 10M free tokens",
      tone: "success",
      activate: () => connectProvider("altimate-backend"),
    },
    { name: "Anthropic (Claude)", note: "bring your own API key", tone: "muted", activate: () => connectProvider("anthropic") },
    { name: "OpenAI (GPT)", note: "bring your own API key", tone: "muted", activate: () => connectProvider("openai") },
    { name: "Google (Gemini)", note: "bring your own API key", tone: "muted", activate: () => connectProvider("google") },
    {
      name: "Big Pickle",
      note: "free, no signup — slower, unreliable tool-calling",
      tone: "warning",
      activate: chooseBigPickle,
    },
    { name: "Search all providers…", note: "/", tone: "muted", activate: openFullCatalog },
  ])

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
      <box flexDirection="row" gap={1} onMouseMove={() => setSelected(props.index)} onMouseUp={() => props.row.activate()}>
        <text flexShrink={0} fg={theme.primary}>
          {active() ? "›" : " "}
        </text>
        <box width={NAME_W} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={active() ? theme.primary : transparent}>
          <text fg={active() ? selFg : theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none">
            {props.row.name}
          </text>
        </box>
        <text flexGrow={1} fg={noteColor(props.row.tone)} wrapMode="none">
          {props.row.note}
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
        title=" Step 1 of 2 "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        {/* the "What is Altimate Code" copy renders ONCE, in the boot box behind
            this dialog — the picker stays a clean curated list */}
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
            <box
              flexDirection="row"
              gap={1}
              onMouseMove={() => setSelected(index())}
              onMouseUp={() => option.run()}
            >
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
// altimate_change end

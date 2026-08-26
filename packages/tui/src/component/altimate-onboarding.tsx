// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Big
// Pickle interstitial. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"
// altimate_change — onboarding funnel telemetry seam
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"

// Session-scoped "setup complete" flag. Set when the user picks a ready model,
// chooses the free Big Pickle option, or finishes the gateway flow. Combined with
// useConnected() (real credentials) via useReady(), it gates the first-run chat
// lock. Module-global so it is shared across the app and resets on every process
// launch (so a fresh relaunch is a clean fresh-user state).
const [setupComplete, setSetupComplete] = createSignal(false)

// Whether a first run is in progress. Set when the first-run gate opens the picker, cleared once
// setup completes. The full model catalogue (dialog-model.tsx) is shared with /model and routine
// model switching, so it consults this before emitting any funnel event — otherwise every model
// change for the life of the product would look like an onboarding provider choice.
const [firstRunActive, setFirstRunActive] = createSignal(false)
export function markFirstRunActive() {
  setFirstRunActive(true)
}
/**
 * Clear without marking setup complete.
 *
 * Needed for exactly one shape: the user HAS credentials but never chose a model, so
 * markSetupComplete() — the normal clear — will not run. The gateway's connected-but-no-usable-
 * model branch is the real instance (dialog-provider.tsx). Leaving the flag set there made later
 * routine /model use emit funnel events for the rest of the session.
 *
 * NOT for ordinary dismissals. A user who closes the picker without setting anything up is still
 * mid-first-run, and their next provider pick genuinely is the onboarding one.
 */
export function clearFirstRunActive() {
  setFirstRunActive(false)
}
export function useFirstRunActive() {
  return firstRunActive
}

export function markSetupComplete() {
  setSetupComplete(true)
  setFirstRunActive(false)
}
// Cleared on /logout so first-run tips don't keep showing "you're all set" after
// the credential is gone.
export function resetSetupComplete() {
  setSetupComplete(false)
  setFirstRunActive(false)
}
export function useReady() {
  const connected = useConnected()
  return createMemo(() => connected() || setupComplete())
}

/**
 * Setup completion ONLY — deliberately without the `connected()` term.
 *
 * `connected()` flips as soon as a provider appears in sync data, which happens inside
 * `await sync.bootstrap()` in the BYOK confirm handlers — before those handlers go on to open the
 * model picker. Anything driven off `useReady()` therefore fires while the user still has no model
 * selected, and is then immediately replaced by that picker. Use this accessor for "the user has
 * finished setting up", and `useReady()` only for "is chat usable at all".
 */
export function useSetupComplete() {
  return setupComplete
}

// First-run welcome picker (presentation only; reuses the same action handlers as
// DialogModel/createDialogProviderOptions). A curated seven: six recommended
// rows (five providers + the local model) + a "Search all providers…" row that
// hands off to the full DialogModel picker. The long tail stays behind search.
const NAME_W = 24
type WelcomeTone = "success" | "warning" | "muted"

interface WelcomeRow {
  name: string
  note: string
  tone: WelcomeTone
  activate: () => boolean
  // altimate_change — funnel: the "search all" row has no provider of its own; every other row
  // is identified by its raw providerID/modelID below and classified host-side.
  analyticsSearchAll?: boolean
  // Identifies the row for the "currently selected" tick. providerID alone matches
  // any model of that provider; add modelID to match a specific model (Big Pickle).
  providerID?: string
  modelID?: string
}

export function DialogModelWelcome(props: {
  intro?: string
  // altimate_change — funnel: which path opened the picker. It also opens from /connect, from
  // declining Big Pickle, and from the prompt gate, so without this every impression would read
  // as a fresh first run. Defaults to the /connect case since that is the only caller that does
  // not pass one explicitly.
  trigger?: "first_run" | "connect_command" | "big_pickle_back" | "local_model_back" | "prompt_gate"
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const providers = createDialogProviderOptions()
  const [selected, setSelected] = createSignal(0)
  // altimate_change start — funnel: picker impression + provider choice
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  // model_picker_shown carries a `trigger`, so a /connect impression is already distinguishable and
  // is kept. The choice events below are not distinguishable and are gated instead.
  onMount(() => trackOnboarding({ name: "model_picker_shown", trigger: props.trigger ?? "connect_command" }))
  // altimate_change end

  onMount(() => dialog.setSize("large"))

  /**
   * Reuse the exact provider onSelect (gateway flow for altimate-backend, auth-method screens for
   * the BYOK providers). Returns whether an action was actually dispatched: the server filters
   * providers via `enabled_providers` / `disabled_providers` while these curated rows are hardcoded,
   * so a row can legitimately have no matching option and this would otherwise no-op in silence.
   */
  function connectProvider(id: string): boolean {
    const option = providers().find((o) => o.value === id)
    if (!option?.onSelect) return false
    option.onSelect()
    return true
  }

  function chooseBigPickle(): boolean {
    dialog.replace(() => <DialogBigPickleConfirm origin="welcome" />)
    return true
  }

  function chooseLocalModel(): boolean {
    dialog.replace(() => <DialogLocalModelInfo />)
    return true
  }

  function openFullCatalog(): boolean {
    // altimate_change — viaSearch marks this as the genuine search path; the catalogue's other
    // entry points must not inherit it.
    dialog.replace(() => <DialogModel viaSearch />)
    return true
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
    {
      name: "Local model",
      note: "no account · runs on this machine",
      tone: "muted",
      providerID: "local",
      activate: chooseLocalModel,
    },
    {
      name: "Search all providers…",
      note: "/",
      tone: "muted",
      activate: openFullCatalog,
      analyticsSearchAll: true,
    },
  ])

  // The currently active model → drives the green "selected" tick.
  const current = createMemo(() => local.model.current())
  const isCurrent = (row: WelcomeRow) => {
    const c = current()
    if (!row.providerID || !c || c.providerID !== row.providerID) return false
    return row.modelID ? c.modelID === row.modelID : true
  }

  // altimate_change — funnel: single choke point for row activation so keyboard and mouse
  // cannot diverge. Fires on selection, before auth resolves: a cancelled or failed sign-in
  // still counts as a provider having been chosen, which is what the funnel step means.
  // Guarded: keyboard return and mouse-up both reach here, and nothing stops two firing before
  // the dialog unmounts — a fast double input would both double-count and start the provider
  // flow twice. Per instance, so re-opening the picker is a genuinely new selection.
  let activated = false
  function activateRow(row: WelcomeRow) {
    if (activated) return
    // Claim the latch only once the action actually dispatched. Setting it first bricked the
    // dialog: `connectProvider` silently no-ops for a provider the server has filtered out, and
    // every later Enter, `/` and mouse-up then returned early — on the first-run gate, before the
    // user has any model at all.
    const dispatched = row.activate()
    if (!dispatched) return
    activated = true
    // Funnel-only: /connect opens this same picker for an established user, and provider_selected
    // carries no trigger, so an ungated emit would contaminate that launch's funnel.
    if (firstRunActive())
      trackOnboarding({
      name: "provider_selected",
      ...(row.analyticsSearchAll
        ? { searchAll: true }
        : { providerID: row.providerID, modelID: row.modelID }),
      })
  }

  // Indices 0-5 are providers, 6 is the search row (rendered below a divider).
  const COUNT = 7
  function move(direction: number) {
    setSelected((prev) => (prev + direction + COUNT) % COUNT)
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) return move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) return move(1)
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      activateRow(rows()[selected()])
      return
    }
    // "/", ctrl+a, or any letter/number reveals the full searchable catalog.
    if (evt.name === "/" || (evt.ctrl && evt.name === "a") || /^[a-z0-9]$/i.test(evt.name ?? "")) {
      evt.preventDefault()
      // altimate_change — the "/" shortcut is the same intent as the "Search all providers…"
      // row, so it routes through the same guarded path.
      activateRow(rows()[6])
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  const noteColor = (tone: WelcomeTone) =>
    tone === "success" ? theme.success : tone === "warning" ? theme.warning : theme.textMuted

  const Row = (props: { row: WelcomeRow; index: number; onActivate: (row: WelcomeRow) => void }) => {
    const active = createMemo(() => selected() === props.index)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseMove={() => setSelected(props.index)}
        onMouseUp={() => props.onActivate(props.row)}
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
          <For each={rows().slice(0, 6)}>{(row, i) => <Row row={row} index={i()} onActivate={activateRow} />}</For>
        </box>
        <box border={["top"]} borderColor={theme.border} />
        <Row row={rows()[6]} index={6} onActivate={activateRow} />
      </box>
    </box>
  )
}

// Big Pickle interstitial — one confirm, default No. Custom component (not
// DialogSelect) so the full warning wraps instead of clipping; y/n keys work,
// enter accepts the highlighted row (No by default).
export function DialogBigPickleConfirm(props: {
  origin: "welcome" | "model"
  /** altimate_change — funnel: carried only so the `no()` return path can hand it back to
   *  DialogModel. Cancelling out of Big Pickle does not leave the catalogue the user reached
   *  through "Search all providers…", but dropping it here re-created the next pick as
   *  via_search:false. */
  viaSearch?: boolean
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)
  // altimate_change start — funnel: interstitial impression + decision.
  // `decided` guards against a double-submit: keyboard and mouse handlers both call yes()/no()
  // directly, and nothing prevents two firing before the dialog unmounts.
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  let decided = false
  // Funnel-only: /model reaches this interstitial with origin="model" for an established user.
  onMount(() => {
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_confirm_shown", origin: props.origin })
  })
  // Every close that is not y/n is still a decision not to take Big Pickle, and the funnel showed
  // an impression with no choice for all of them. onCleanup (rather than the inline `esc` control)
  // is what makes this cover ALL of them — the Escape key and click-away are handled by
  // DialogProvider and never reach this component's own handlers. `decided` keeps yes()/no() from
  // double-emitting when their dialog.clear()/replace() unmounts us.
  onCleanup(() => {
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "cancel" })
  })
  // altimate_change end

  function no() {
    // altimate_change start
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "cancel" })
    // altimate_change end
    dialog.replace(() =>
      props.origin === "welcome" ? (
        <DialogModelWelcome trigger="big_pickle_back" />
      ) : (
        <DialogModel viaSearch={props.viaSearch} />
      ),
    )
  }
  function yes() {
    // altimate_change start
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "accept" })
    // altimate_change end
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

// Local-model interstitial — the picker cannot run the multi-minute `altimate local`
// setup (model download + certification is a CLI-side flow), so this explains what
// it is and hands the user the one command. Mirrors DialogBigPickleConfirm's
// structure, keyboard handling, and funnel-telemetry discipline.
export function DialogLocalModelInfo() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(0) // 0 = Got it (default)
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  let decided = false
  onMount(() => {
    if (firstRunActive()) trackOnboarding({ name: "local_model_info_shown" })
  })
  // Escape / click-away never reach this component's handlers (DialogProvider owns them),
  // so onCleanup is the only hook that sees every undecided close.
  onCleanup(() => {
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "local_model_choice", choice: "cancel" })
  })

  function acknowledge() {
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "local_model_choice", choice: "acknowledge" })
    dialog.clear()
  }
  function back() {
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "local_model_choice", choice: "back" })
    dialog.replace(() => <DialogModelWelcome trigger="local_model_back" />)
  }
  const options = [
    { label: "Got it — I'll run `altimate local`", hint: "(default)", run: acknowledge },
    { label: "Back — pick something else", hint: "", run: back },
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
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Run a local model?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        No account, no API key — a certified open model runs on this machine, and web tools ask before anything
        leaves it. Needs Apple Silicon or a 24GB+ GPU, plus a one-time ~16GB download. Exit and run:
      </text>
      <text fg={theme.text} wrapMode="word" width="100%">
        {"  altimate local"}
      </text>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        Then start altimate again — the local model will be selected automatically.
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

// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Altimate
// Base disclosure. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createEffect, createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useLocal, isLegacyBigPickleModel } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"
import { useSDK } from "../context/sdk"
// altimate_change — the consent-gated registration operation lives outside the public SDK
// context; see context/altimate-base-consent.tsx.
import { useAltimateBaseConsent, type AltimateBaseRegistration } from "../context/altimate-base-consent"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
// altimate_change — onboarding funnel telemetry seam
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"
// altimate_change — the Base consent disclosure has one definition, shared with the HTTP route
import { ALTIMATE_BASE_DISCLOSURE, ALTIMATE_BASE_HINT } from "@opencode-ai/core/altimate-base-disclosure"

// Session-scoped "setup complete" flag. Set when the user picks a ready model,
// chooses Altimate Base, or finishes the gateway flow. Combined with
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
  // altimate_change start — fixes #1301 (Codex review, P2): a free public Zen model the user
  // either chose on purpose or already declined migrating away from is a legitimate way to use
  // the product, not "un-onboarded." Without this term, a returning free-default user who is
  // explicit or already said No gets treated as not-ready on every relaunch — the first-run
  // welcome picker reopens (see the first-run effect in app.tsx) and prompt submission itself
  // reopens the picker and discards whatever was typed (see `useReady()`'s callers in
  // component/prompt/index.tsx). `LocalProvider` wraps the whole app above `DialogProvider` (see
  // app.tsx), so `useLocal()` is always available to every caller of `useReady()`.
  const local = useLocal()
  // altimate_change — Codex HOLD finding 1: `hasUsableFreeDefault()` can now return `"pending"`
  // (kv not hydrated yet, see its declaration in local.tsx) as well as a boolean. Every consumer
  // of `useReady()` EXCEPT the prompt submit gate only needs a plain boolean (display text,
  // whether a command is enabled, the first-run chat lock) — `"pending"` collapses to `false` for
  // all of them, the same conservative default this code had before kv.ready-awareness existed.
  // `useReadyPending()` below is the ONE seam the submit gate uses to see the pending state
  // itself, so it can defer instead of discarding.
  return createMemo(() => connected() || setupComplete() || local.model.hasUsableFreeDefault() === true)
  // altimate_change end
}

// altimate_change start — Codex HOLD finding 1: true only when overall readiness cannot be
// decided YET — none of `connected()`/`setupComplete()` are already true, and the free-default
// predicate is specifically `"pending"` (kv still hydrating), not a settled `false`. The prompt
// submit gate (component/prompt/index.tsx) is the one caller that needs this: `useReady()` alone
// cannot distinguish "genuinely not usable, show the picker" from "don't know yet, kv is still
// loading" — both read as `false` there by design (see `useReady()`'s comment above), which is
// the right default for every OTHER consumer (display text, command enablement) but wrong for a
// submit gate whose `false` branch discards the typed prompt. This predicate lets the submit
// gate keep the prompt and retry once kv resolves, instead of guessing either way.
export function useReadyPending() {
  const connected = useConnected()
  const local = useLocal()
  return createMemo(() => !connected() && !setupComplete() && local.model.hasUsableFreeDefault() === "pending")
}
// altimate_change end

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
// DialogModel/createDialogProviderOptions). A curated six: five recommended
// providers + a "Search all providers…" row that hands off to the full DialogModel
// picker. The long tail stays behind search.
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
  // any model of that provider; add modelID to match a specific model.
  providerID?: string
  modelID?: string
}

export function DialogModelWelcome(props: {
  intro?: string
  // altimate_change — funnel: which path opened the picker. It also opens from /connect, from
  // declining Altimate Base, and from the prompt gate, so without this every impression would read
  // as a fresh first run. Defaults to the /connect case since that is the only caller that does
  // not pass one explicitly.
  trigger?: "first_run" | "connect_command" | "altimate_base_back" | "prompt_gate"
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
   * providers via `enabled_providers` / `disabled_providers` while these five rows are hardcoded,
   * so a row can legitimately have no matching option and this would otherwise no-op in silence.
   */
  function connectProvider(id: string): boolean {
    const option = providers().find((o) => o.value === id)
    if (!option?.onSelect) return false
    option.onSelect()
    return true
  }

  function chooseAltimateBase(): boolean {
    if (!providers().some((provider) => provider.value === "altimate-free")) return false
    dialog.replace(() => <DialogAltimateBaseConfirm origin="welcome" />)
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
    ...(providers().some((provider) => provider.value === "altimate-free")
      ? [
          {
            name: "Altimate Base",
            note: ALTIMATE_BASE_HINT,
            tone: "warning" as const,
            providerID: "altimate-free",
            modelID: "altimate-base",
            activate: chooseAltimateBase,
          },
        ]
      : []),
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

  const searchIndex = createMemo(() => rows().length - 1)
  createEffect(() => {
    const last = rows().length - 1
    if (selected() > last) setSelected(Math.max(0, last))
  })
  function move(direction: number) {
    const count = rows().length
    setSelected((prev) => (prev + direction + count) % count)
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
      activateRow(rows()[searchIndex()])
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
          <For each={rows().slice(0, searchIndex())}>
            {(row, i) => <Row row={row} index={i()} onActivate={activateRow} />}
          </For>
        </box>
        <box border={["top"]} borderColor={theme.border} />
        <Row row={rows()[searchIndex()]} index={searchIndex()} onActivate={activateRow} />
      </box>
    </box>
  )
}

// altimate_change start — surfaced in the DialogAltimateBaseConfirm consent gate below before any
// Base credential is minted. This is the text a user actually consents against before any
// registration request, so it states the core data terms up front: requests/responses may be
// logged and used to improve Altimate's products (including the model), so users should not send
// secrets. The persistent per-install-id linkage detail is disclosed in
// docs/docs/configure/providers.md ("Data handling"), not repeated in this gate; keep the core
// terms in sync with that note.
//
// Defined once in core (imported at the top of this file) and re-exported here for existing
// consumers, so this dialog and the HTTP disclosure route (packages/opencode, for hosts that
// render their own dialog) cannot drift apart — a copy change like #1268 now lands on both.
export { ALTIMATE_BASE_DISCLOSURE }
// altimate_change end

type RegisterOutcome =
  | { ok: true }
  | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }

const REGISTER_FAILURE_MESSAGE = "Could not set up Altimate Base. Try again, or pick another provider."

async function registerAltimateBase(register: AltimateBaseRegistration | undefined): Promise<RegisterOutcome> {
  if (!register) return { ok: false, result: "error", message: REGISTER_FAILURE_MESSAGE }
  try {
    const data = await register()
    if (data.ok) return { ok: true }
    return {
      ok: false,
      result: data.result,
      message: data.message || REGISTER_FAILURE_MESSAGE,
    }
  } catch {
    return { ok: false, result: "network", message: REGISTER_FAILURE_MESSAGE }
  }
}

// Consent disclosure and registration flow. The default remains No, and no identifier is minted
// until the user explicitly accepts.
export function DialogAltimateBaseConfirm(props: {
  // altimate_change — returning Big Pickle users reuse the same disclosure before migration
  origin: "welcome" | "model" | "migration"
  viaSearch?: boolean
  onDecline?: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  // altimate_change — the actual registration call, read from its own dedicated context rather
  // than the public SDK context; see context/altimate-base-consent.tsx.
  const altimateBaseConsent = useAltimateBaseConsent()
  const sync = useSync()
  const toast = useToast()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  // altimate_change — PR #1302 review (Cursor "Accept can skip default rewrite", medium, real):
  // captured HERE, ONCE, before `yes()` can run any registration — `local.model.launchDefault()`
  // is a live memo (`fallbackModel()`), and registration + `sync.bootstrap()` can make
  // `altimate-free/altimate-base` the first live provider, moving `fallbackModel()` to Base
  // itself by the time `yes()` would otherwise re-read it. Passed to `migrateLegacyDefault({
  // from })` below so eligibility is re-checked against what the launch default WAS, not what it
  // has since become.
  const launchDefault = local.model.launchDefault()
  // altimate_change start — cubic review round 5, P2: same snapshot reasoning as
  // `launchDefault` above, applied to its display name too. `launchDefaultDisplay()` is a LIVE
  // memo over the same `fallbackModel()` — calling it from JSX (as the disclosure copy used to)
  // re-reads it on every re-render, so once `yes()`'s registration makes Altimate Base the new
  // `fallbackModel()`, the disclosure still on screen (`yes()` awaits registration before the
  // dialog closes) could rename itself to "Altimate Base" mid-sentence in copy that is
  // specifically explaining why the CURRENT default is being replaced. Snapshotting here, once,
  // alongside `launchDefault`, keeps the copy naming the model that was actually true when the
  // dialog opened.
  const launchDefaultDisplay = local.model.launchDefaultDisplay()
  // altimate_change end
  let decided = false
  let choiceRecorded = false
  let disposed = false
  // altimate_change start — Cursor/CodeRabbit/cubic review round 5: `recordChoice`'s
  // `lastCloseReason !== "programmatic" && lastCloseReason !== "interrupt"` check treated
  // `lastCloseReason === undefined` as "record it" — but `undefined` is also what a genuine
  // top-level quit (process exit, Ctrl+C at the top of the app disposing the whole Solid root)
  // leaves behind, since that teardown runs `onCleanup` without the close guard ever being
  // consulted. That silently counted app quits as declines in `altimate_base_choice` telemetry.
  // `chosen` is the positive signal instead: it is set ONLY inside `no()`/`yes()`, i.e. only when
  // the user (or the guard's `queueMicrotask(no)` for a genuine dismiss) actually reached a
  // decision. `onCleanup`'s unconditional `recordChoice("cancel")` fallback now records nothing
  // for migration unless a decision was actually made.
  let chosen = false
  // altimate_change end
  // altimate_change start — fixes #1301: the migration origin never entered the first-run funnel
  // at all (it was gated on `firstRunActive()`, which migration never sets), so the disclosure
  // that matters most for measuring the fix was invisible to telemetry. Migration is still not
  // FIRST-RUN onboarding, so it stays out of the `firstRunActive()`-gated events below, but it
  // gets its own unconditional emission with `origin: "migration"` on every event.
  //
  // `lastCloseReason` remembers which kind of close the guard most recently PERMITTED (`"dismiss"`
  // for Escape/the backdrop click — `dialog.tsx`'s `dismiss()`, wired to the backdrop
  // specifically; `"programmatic"` for this dialog's own `clear()`/`replace()` or an unrelated
  // feature's; `"interrupt"` for Ctrl+C — see `ui/dialog.tsx`) so the `onCleanup` fallback below
  // can tell them apart too.
  let lastCloseReason: "dismiss" | "interrupt" | "programmatic" | undefined
  const releaseCloseGuard = dialog.guardClose((reason) => {
    // altimate_change — Kilo review round 6 (3986171185): a dismiss attempted WHILE `busy()`
    // (registration in flight) is VETOED below — the close does not happen, no decision is made,
    // `no()` is deliberately not queued. Recording `lastCloseReason` before that veto check used
    // to leave it set to `"dismiss"` anyway, as a side effect of an attempt that never actually
    // went through. If the app was then torn down before the guard was consulted again (mid
    // registration, then a hard quit — the exact guard-free teardown path `onCleanup`'s fallback
    // below exists for), that stale `"dismiss"` made the fallback persist a decline nobody
    // actually made. Bail out before recording anything whenever the close is going to be
    // vetoed for being busy — `lastCloseReason` now only ever reflects a close the guard
    // actually PERMITTED (or explicitly routed to `no()`, below).
    if (busy()) return false
    lastCloseReason = reason
    // Escape closes through `DialogProvider`'s keymap binding (`closeTop("dismiss")`), which
    // calls this guard BEFORE the dialog's own `useKeyboard` below ever sees the key — so
    // intercepting in `useKeyboard` alone would be too late; the dialog would already be gone.
    // The backdrop click reaches here the same way, via `dialog.tsx`'s `dismiss()` (fixes #1301,
    // Codex review round 2, P2: it used to call `clear()`, i.e. "programmatic", so clicking
    // outside the dialog silently skipped both the decline AND the picker that keyboard Escape
    // gets). This dialog's own visible "esc" label calls `no()` directly instead of going through
    // the guard at all — see its `onMouseUp` below. For a migration DISMISSAL from any of these,
    // veto the close and run the same routing `no()` does (persist the decline, open the picker)
    // on a microtask instead of a bare dismissal, which the retired Big Pickle model cannot
    // silently fall back to. `no()` sets `decided = true` before its own `dialog.replace`, so
    // that replace passes this same guard on its re-check (reason "programmatic", by then
    // decided) and this queued call cannot double-fire.
    //
    // Ctrl+C closes through the same binding but with reason "interrupt" (PR review round 3):
    // Ctrl+C is a "get me out" gesture (quitting the app, or backing out of whatever's on
    // screen), not "I decline Altimate Base specifically" the way Escape on THIS dialog is. Before
    // this distinction existed, quitting with Ctrl+C twice while the migration dialog was open
    // queued `no()` on the FIRST Ctrl+C (persist + picker takeover) before the second one could
    // quit — recording a refusal the user never made. "interrupt" is deliberately NOT matched
    // below, so it falls through to the same handling as a PROGRAMMATIC close: the close
    // succeeds, nothing is persisted, and the disclosure is simply offered again next launch.
    //
    // A PROGRAMMATIC close (this dialog's own `clear()`/`replace()`, or an unrelated feature —
    // command palette, session list — replacing the dialog stack out from under this one) is left
    // alone here too. Neither it nor an interrupt is the user declining Altimate Base, so forcing
    // `no()` for them turned harmless UI navigation (or quitting) into a persisted refusal plus an
    // unwanted picker takeover. The `onCleanup` fallback below only persists a decline for the
    // reasons this guard could not itself resolve into a decision.
    if (reason === "dismiss" && props.origin === "migration" && !decided) {
      queueMicrotask(no)
      return false
    }
    return true
  })
  // altimate_change end

  function recordChoice(choice: "accept" | "cancel") {
    if (choiceRecorded) return
    choiceRecorded = true
    // altimate_change — Cursor/CodeRabbit/cubic review round 5: see `chosen`'s declaration above.
    // `lastCloseReason === "dismiss"` is kept alongside `chosen` defensively (a genuine dismiss
    // always routes through `no()`, which sets `chosen` first, but this keeps the condition
    // correct even if that ordering ever changes) — it is `undefined` (top-level quit) and
    // `"programmatic"`/`"interrupt"` (unrelated close, Ctrl+C) that must NOT record a choice.
    if (props.origin === "migration" ? chosen || lastCloseReason === "dismiss" : firstRunActive()) {
      trackOnboarding({ name: "altimate_base_choice", choice, origin: props.origin })
    }
  }

  onMount(() => {
    // altimate_change — fixes #1301: see the block comment on `releaseCloseGuard` above
    if (props.origin === "migration" || firstRunActive()) {
      trackOnboarding({ name: "altimate_base_confirm_shown", origin: props.origin })
    }
  })
  onCleanup(() => {
    releaseCloseGuard()
    disposed = true
    // altimate_change start — PR #1302 review (CodeRabbit + cubic, both flagged this; Kilo review
    // round 6, 3986171185, corrected further): a genuine user DISMISSAL — keyboard Escape or the
    // backdrop click, which `dialog.tsx` reports as `dismiss()` (reason "dismiss") — is normally
    // fully handled above via `queueMicrotask(no)`, which sets `decided` before this ever runs,
    // same as this dialog's own visible "esc" label (see its `onMouseUp` above, which calls
    // `no()` directly). Ctrl+C is a separate "interrupt" reason, never "dismiss" — see the guard
    // above. So this branch does not double an ORDINARY dismissal. It is not purely
    // documentation, though: it is the actual safety net for a dismiss attempted WHILE `busy()`
    // was true (registration in flight) followed by teardown before the guard is consulted
    // again — the guard above now bails out BEFORE recording anything in that case, so
    // `lastCloseReason` stays whatever it was before the vetoed attempt (typically `undefined`,
    // since a legitimate prior close would already have set `decided`), and this condition
    // correctly stays false for it too. A true positive here (a real, unqueued dismiss reaching
    // teardown) would be an ordering bug elsewhere; this remains a deliberate belt-and-suspenders
    // check, not dead code.
    //
    // The bug this also fixes: renderer teardown (process exit, Ctrl+C-to-quit at the TOP level,
    // not this dialog's own Ctrl+C binding) runs this cleanup WITHOUT the guard ever having been
    // consulted, so `lastCloseReason` stays `undefined`. The previous `!== "programmatic"` check
    // treated "no reason at all" the same as "dismissed", persisting a refusal the user never
    // made just from quitting the app. Requiring the reason to be the observed, positive
    // "dismiss" — not merely "not programmatic" — excludes both `undefined` and "programmatic"
    // (this dialog's own `clear()`/`replace()`, or an unrelated feature replacing the dialog
    // stack out from under this one — neither is the user declining Altimate Base either).
    if (!decided && props.origin === "migration" && lastCloseReason === "dismiss") props.onDecline?.()
    // altimate_change end
    decided = true
    recordChoice("cancel")
  })

  function no() {
    if (decided || busy()) return
    decided = true
    // altimate_change — Cursor/CodeRabbit/cubic review round 5: see `chosen`'s declaration above
    chosen = true
    recordChoice("cancel")
    // altimate_change — a migration decline no longer just leaves the dialog cleared: Big Pickle
    // is retired, so "pick something else" must actually route somewhere. `onDecline` still
    // persists the refusal first, so this prompt is not shown again on a later launch.
    if (props.origin === "migration") props.onDecline?.()
    dialog.replace(() =>
      props.origin === "model" ? (
        <DialogModel viaSearch={props.viaSearch} />
      ) : (
        <DialogModelWelcome trigger="altimate_base_back" />
      ),
    )
  }

  async function yes() {
    if (decided || busy()) return
    // altimate_change — Cursor/CodeRabbit/cubic review round 5: see `chosen`'s declaration above
    chosen = true
    recordChoice("accept")
    setBusy(true)
    setError(undefined)
    const outcome = await registerAltimateBase(altimateBaseConsent)
    if (disposed) return
    // altimate_change — fixes #1301: see the block comment on `releaseCloseGuard` above
    if (props.origin === "migration" || firstRunActive()) {
      trackOnboarding({
        name: "altimate_base_register_result",
        result: outcome.ok ? "success" : outcome.result,
        origin: props.origin,
      })
    }
    if (!outcome.ok) {
      setBusy(false)
      setError(outcome.message)
      toast.show({ variant: "error", message: outcome.message })
      return
    }

    await sdk.client.instance.dispose().catch(() => {})
    if (disposed) return
    await sync.bootstrap().catch(() => {})
    if (disposed) return
    const available = sync.data.provider.some(
      (provider) => provider.id === "altimate-free" && Boolean(provider.models?.["altimate-base"]),
    )
    if (!available) {
      const message = "Altimate Base was registered, but the model is not ready yet. Try again in a moment."
      setBusy(false)
      setError(message)
      toast.show({ variant: "error", message })
      return
    }

    decided = true
    setBusy(false)
    if (props.origin === "migration") {
      // A migration also removes the retired implicit model from recents. Re-check eligibility
      // after registration so a project allowlist or explicit model change made while the dialog
      // was open cannot be overwritten by the returning-user migration. `from: launchDefault`
      // (captured on mount, before registration) — see its declaration above — keeps this
      // re-check from being defeated by `fallbackModel()` itself having moved to Base by now.
      const migrated = local.model.migrateLegacyDefault({ from: launchDefault })
      if (!migrated) {
        // Registration succeeded, but migration is no longer eligible — the user is still on the
        // retired Big Pickle model. Route to the picker instead of marking setup complete for a
        // model this session no longer treats as usable.
        dialog.replace(() => <DialogModelWelcome trigger="altimate_base_back" />)
        return
      }
    } else {
      local.model.set({ providerID: "altimate-free", modelID: "altimate-base" }, { recent: true })
    }
    dialog.clear()
    markSetupComplete()
  }

  const options = [
    {
      label: "No — pick something else",
      hint: "(default)",
      run: no,
    },
    { label: "Yes — use Altimate Base", hint: "", run: () => void yes() },
  ]

  useKeyboard((evt) => {
    if (busy()) {
      if (evt.name === "escape" || (evt.ctrl && evt.name === "c")) {
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }
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
      void yes()
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
          Use Altimate Base?
        </text>
        {/* altimate_change start — fixes #1301 (Codex review round 2, P2): this visible label is
            a user dismissal too, exactly like the keyboard key and the backdrop click — for
            migration it must route through `no()` (persist the decline, open the picker), not a
            bare `dialog.clear()`, or clicking it silently leaves the next server launch free to
            pick Base again after a partial registration. */}
        <text
          fg={theme.textMuted}
          onMouseUp={() => {
            if (busy()) return
            if (props.origin === "migration") {
              no()
              return
            }
            dialog.clear()
          }}
        >
          esc
        </text>
        {/* altimate_change end */}
      </box>
      {/* altimate_change start — fixes #1301: migration now also covers implicit free public
          Zen defaults besides the retired Big Pickle id, so the copy must name whichever model
          is actually being moved rather than always naming Big Pickle specifically.
          PR #1302 review (CodeRabbit + cubic, both flagged this): this must describe the LAUNCH
          default (the captured `launchDefault`/`launchDefaultDisplay` snapshots above, = what
          `fallbackModel()` resolved to when the dialog opened) — the model migration eligibility
          and `migrateLegacyDefault()` actually reason about — not `local.model.current()`/
          `parsed()` (a session-restored model on `restoreSession`/`--continue`) NOR the live
          `local.model.launchDefault()`/`launchDefaultDisplay()` memos themselves (cubic review
          round 5: those can change mid-dialog once `yes()`'s registration makes Altimate Base
          the new live fallback, renaming this copy out from under the user while it explains why
          the OLD default is being replaced). */}
      <Show when={props.origin === "migration"}>
        <Show
          when={isLegacyBigPickleModel(launchDefault)}
          fallback={
            <text fg={theme.text} wrapMode="word" width="100%">
              {`Your default model, ${launchDefaultDisplay.model}, is a public free model. Altimate Base is the free model Altimate hosts for data work.`}
            </text>
          }
        >
          <text fg={theme.text} wrapMode="word" width="100%">
            Big Pickle has been retired.
          </text>
        </Show>
      </Show>
      {/* altimate_change end */}
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        {ALTIMATE_BASE_DISCLOSURE}
      </text>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word" width="100%">
          {error()!}
        </text>
      </Show>
      <Show when={busy()}>
        <text fg={theme.textMuted}>Setting up…</text>
      </Show>
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

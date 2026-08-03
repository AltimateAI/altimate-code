import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
// altimate_change start — PROVIDER_PRIORITY orders the READY section like the curated picker;
// CUSTOM_PROVIDER_OPTION_VALUE identifies the "Other" row, which must not record a provider
// choice before the user has supplied one.
import {
  createDialogProviderOptions,
  DialogProvider,
  WARNLIST,
  PROVIDER_PRIORITY,
  CUSTOM_PROVIDER_OPTION_VALUE,
} from "./dialog-provider"
// altimate_change end
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
// altimate_change — onboarding helpers (readiness state, welcome picker, Big Pickle
// interstitial) live in the altimate-owned ./altimate-onboarding to keep this
// upstream file's rebase surface small. markSetupComplete / DialogBigPickleConfirm
// are used by the restructured DialogModel below.
import { markSetupComplete, useFirstRunActive, DialogBigPickleConfirm } from "./altimate-onboarding"
// altimate_change — funnel: provider identity for a pick made from the full catalogue
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"

// altimate_change start — DialogModel restructured from the upstream flat
// favorites/recent/provider list into READY / NEEDS-SETUP sections with a Big Pickle
// fallback. This is an in-place rewrite of the upstream component; on an upstream
// merge, expect a conflict here and re-apply the READY/NEEDS-SETUP shaping.
export function DialogModel(props: {
  providerID?: string
  /** altimate_change — funnel: true only when opened from the curated picker's "Search all
   *  providers…" row. The catalogue is also opened by the gateway no-usable-model branch and the
   *  BYOK success branch (dialog-provider.tsx), and hardcoding `true` recorded the most common
   *  non-gateway first run as having gone through search — which is precisely the distinction
   *  via_search exists to make. */
  viaSearch?: boolean
}) {
  // altimate_change — funnel seam (no-op outside a first run, and when no host tracker exists)
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()
  // altimate_change — one-shot submit latch. DialogSelect.submit() has no guard of its own, and
  // the NEEDS-SETUP rows record the choice and THEN await an async provider action, so a second
  // Enter (or a mouse-up landing during the await) emitted provider_selected twice and started a
  // second authorization flow. The curated picker has the same latch; this catalogue is one
  // dialog further on and had none.
  let activated = false

  // A provider is "ready" (usable now) when it has valid credentials: it is present
  // in the live provider list with at least one model — and, for the free OpenCode
  // provider, with at least one paid model (a Zen key entered).
  function providerReady(id: string) {
    const p = sync.data.provider.find((x) => x.id === id)
    if (!p) return false
    if (id === "opencode") return Object.values(p.models).some((m) => m.cost?.input != null && m.cost.input !== 0)
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
      // altimate_change — order ready providers by the same PROVIDER_PRIORITY as the
      // welcome/NEEDS-SETUP lists so the Altimate LLM Gateway leads the full list too.
      sortBy((provider) => PROVIDER_PRIORITY[provider.id] ?? 99),
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
                if (activated) return
                activated = true
                // altimate_change — go through the shared onSelect(providerID, modelID)
                // helper so a ready pick also honors the model-variant follow-up flow,
                // and mark setup complete so the first-run chat lock lifts.
                // altimate_change — funnel: record which provider was actually chosen.
                // The curated picker's "Search all providers…" row emits provider_selected with
                // `search_all` and then hands off here, so without this the real choice is never
                // recorded and "which provider did people pick?" is unanswerable for everyone who
                // used search — which is precisely the long-tail providers, since the curated
                // five never need it.
                //
                // Gated on firstRunActive: this catalogue is also /model and routine model
                // switching, and emitting unconditionally would make every model change for the
                // life of the product look like an onboarding provider choice.
                if (firstRunActive()) {
                  trackOnboarding({
                    name: "provider_selected",
                    providerID: provider.id,
                    modelID,
                    via_search: props.viaSearch ?? false,
                  })
                }
                onSelect(provider.id, modelID)
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
              // altimate_change — funnel: record the choice here too. READY means "already holds
              // valid credentials", which on a first run is empty or near-empty, so instrumenting
              // only that section missed every long-tail provider — the exact population the
              // search path was added to capture. Emitted before the auth flow runs, matching the
              // documented promise that a sign-in later cancelled still counts as a selection.
              onSelect: () => {
                if (activated) return
                activated = true
                // The "Other" row prompts for a provider id and the user can cancel it, so there
                // is no choice to record yet — emitting here classified an abandoned prompt as a
                // real `other` selection. Every other row dispatches a concrete provider, where
                // recording before the auth flow is deliberate (a sign-in later cancelled still
                // counts as a selection).
                if (firstRunActive() && o.value !== CUSTOM_PROVIDER_OPTION_VALUE) {
                  trackOnboarding({
                    name: "provider_selected",
                    providerID: o.value,
                    via_search: props.viaSearch ?? false,
                  })
                }
                return o.onSelect?.()
              },
            }))
          const bigPickle = {
            value: "big-pickle" as { providerID: string; modelID: string } | string,
            title: "Big Pickle",
            description: "free, no signup — slower, unreliable tool-calling",
            category: "NEEDS SETUP",
            footer: undefined as string | undefined,
            async onSelect() {
              if (activated) return
              activated = true
              // altimate_change — Big Pickle reached through the catalogue emitted its confirm
              // events but never a provider_selected, so the choice was invisible.
              if (firstRunActive()) {
                trackOnboarding({
                  name: "provider_selected",
                  providerID: "opencode",
                  modelID: "big-pickle",
                  via_search: props.viaSearch ?? false,
                })
              }
              dialog.replace(() => <DialogBigPickleConfirm origin="model" viaSearch={props.viaSearch} />)
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
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            // altimate_change — NEEDS-SETUP rows carry plain string values (provider
            // ids / "big-pickle"); only real {providerID, modelID} rows are favoritable.
            if (typeof option.value === "string") return
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
// altimate_change end

// altimate_change — kept for packages/tui/test/cli/cmd/tui/model-options.test.ts;
// no longer used internally by DialogModel above (see READY/NEEDS-SETUP shaping),
// but preserved as a public export so the existing upstream test keeps passing.
export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    (option) => option.title,
  )
}

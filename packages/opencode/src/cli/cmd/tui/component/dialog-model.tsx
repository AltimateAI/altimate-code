import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider, WARNLIST } from "./dialog-provider"
import { useKeybind } from "../context/keybind"
import * as fuzzysort from "fuzzysort"
// altimate_change — onboarding helpers (readiness state, welcome picker, Big Pickle
// interstitial) live in the altimate-owned ./altimate-onboarding to keep this
// upstream file's rebase surface small. markSetupComplete / DialogBigPickleConfirm
// are used by the restructured DialogModel below.
import { markSetupComplete, DialogBigPickleConfirm } from "./altimate-onboarding"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

// altimate_change start — DialogModel restructured from the upstream flat
// favorites/recent/provider list into READY / NEEDS-SETUP sections with a Big Pickle
// fallback. This is an in-place rewrite of the upstream component; on an upstream
// merge, expect a conflict here and re-apply the READY/NEEDS-SETUP shaping.
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
// altimate_change end

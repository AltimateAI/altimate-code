import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider, WARNLIST, PROVIDER_PRIORITY } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
// altimate_change — onboarding helpers (readiness state, welcome picker, Big Pickle
// interstitial) live in the altimate-owned ./altimate-onboarding to keep this
// upstream file's rebase surface small. markSetupComplete / DialogBigPickleConfirm
// are used by the restructured DialogModel below.
import { markSetupComplete, DialogBigPickleConfirm } from "./altimate-onboarding"

// altimate_change start — DialogModel restructured from the upstream flat
// favorites/recent/provider list into READY / NEEDS-SETUP sections with a Big Pickle
// fallback. This is an in-place rewrite of the upstream component; on an upstream
// merge, expect a conflict here and re-apply the READY/NEEDS-SETUP shaping.
export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

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
                // altimate_change — go through the shared onSelect(providerID, modelID)
                // helper so a ready pick also honors the model-variant follow-up flow,
                // and mark setup complete so the first-run chat lock lifts.
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
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}

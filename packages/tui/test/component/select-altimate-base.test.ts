// altimate_change start — coverage for the no-dialog Altimate Base picker flow (replaces
// DialogAltimateBaseConfirm). Exercises `selectAltimateBase()` directly with hand-built fakes for
// its collaborators, rather than mounting the full picker component tree: the pickers all funnel
// through this one shared function (dialog-provider.tsx, dialog-model.tsx, the welcome picker in
// this same file), so testing it here covers every call site's outcome without needing an `agent`
// in the render harness (selectModel()'s underlying local.model.set() is agent-scoped, which the
// component-mount fixtures used elsewhere in this package don't set up).
import { describe, expect, test } from "bun:test"
import type { useSDK } from "../../src/context/sdk"
import type { useSync } from "../../src/context/sync"
import type { useLocal } from "../../src/context/local"
import type { useToast } from "../../src/ui/toast"
import type { useDialog } from "../../src/ui/dialog"
import { selectAltimateBase } from "../../src/component/altimate-onboarding"

function fakeCollaborators(options: {
  registerAltimateBase?: () => Promise<{ ok: true } | { ok: false; result: "network" | "error"; message: string }>
  fetchImpl?: typeof fetch
  /** Whether the provider list gains the Base model once bootstrap() runs — the real flow's
   *  "the credential was minted, but the catalogue hasn't caught up yet" edge case sets this to
   *  false. */
  becomesAvailableAfterBootstrap?: boolean
}) {
  const modelSetCalls: unknown[] = []
  let dialogClearCount = 0
  let dialogReplaceCount = 0
  const toastCalls: { variant: string; message: string }[] = []
  let disposed = false
  let bootstrapped = false
  const becomesAvailable = options.becomesAvailableAfterBootstrap ?? true
  const providerState: { id: string; models: Record<string, unknown> }[] = []

  const sdk = {
    client: {
      instance: {
        dispose: async () => {
          disposed = true
        },
      },
    },
    fetch: options.fetchImpl ?? (async () => new Response("should not be called", { status: 500 })),
    url: "http://test",
    registerAltimateBase: options.registerAltimateBase,
  } as unknown as ReturnType<typeof useSDK>

  const sync = {
    bootstrap: async () => {
      bootstrapped = true
      if (becomesAvailable) {
        providerState.push({ id: "altimate-free", models: { "altimate-base": { id: "altimate-base" } } })
      }
    },
    data: { provider: providerState },
  } as unknown as ReturnType<typeof useSync>

  const local = {
    model: {
      set: (...args: unknown[]) => {
        modelSetCalls.push(args)
      },
    },
  } as unknown as ReturnType<typeof useLocal>

  const toast = {
    show: (toastOptions: { variant: string; message: string }) => {
      toastCalls.push(toastOptions)
    },
  } as unknown as ReturnType<typeof useToast>

  const dialog = {
    clear: () => {
      dialogClearCount++
    },
    replace: (..._args: unknown[]) => {
      dialogReplaceCount++
      return true
    },
  } as unknown as ReturnType<typeof useDialog>

  return {
    sdk,
    sync,
    local,
    toast,
    dialog,
    modelSetCalls,
    toastCalls,
    get disposed() {
      return disposed
    },
    get bootstrapped() {
      return bootstrapped
    },
    get dialogClearCount() {
      return dialogClearCount
    },
    get dialogReplaceCount() {
      return dialogReplaceCount
    },
  }
}

describe("selectAltimateBase", () => {
  test("registers, refreshes provider state, and selects the model — no dialog is ever opened", async () => {
    const fakes = fakeCollaborators({ registerAltimateBase: async () => ({ ok: true }) })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(true)
    expect(fakes.disposed).toBe(true)
    expect(fakes.bootstrapped).toBe(true)
    expect(fakes.modelSetCalls).toEqual([
      [{ providerID: "altimate-free", modelID: "altimate-base" }, { recent: true }],
    ])
    expect(fakes.dialogClearCount).toBe(1)
    // The whole point of this replacement: nothing ever opens a confirm/consent dialog.
    expect(fakes.dialogReplaceCount).toBe(0)
    expect(fakes.toastCalls).toHaveLength(0)
  })

  test("an attached TUI (no host-injected registerAltimateBase) falls back to the HTTP route", async () => {
    const calls: string[] = []
    const fakes = fakeCollaborators({
      registerAltimateBase: undefined,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(true)
    expect(calls).toEqual(["http://test/altimate/base/register"])
    expect(fakes.modelSetCalls).toHaveLength(1)
    expect(fakes.dialogReplaceCount).toBe(0)
  })

  test("a registration failure shows the toast and leaves the model unchanged", async () => {
    const fakes = fakeCollaborators({
      registerAltimateBase: async () => ({ ok: false, result: "network", message: "offline" }),
    })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(false)
    expect(fakes.toastCalls).toEqual([{ variant: "error", message: "offline" }])
    // Nothing past the failed register() call ran: no instance disposal, no bootstrap, no selection.
    expect(fakes.disposed).toBe(false)
    expect(fakes.bootstrapped).toBe(false)
    expect(fakes.modelSetCalls).toHaveLength(0)
    expect(fakes.dialogClearCount).toBe(0)
    expect(fakes.dialogReplaceCount).toBe(0)
  })

  test("a registration that reports ok but never actually surfaces the model shows an error and leaves the model unchanged", async () => {
    // registerAltimateBase() can succeed (a credential was minted) while the provider list still
    // hasn't caught up — bootstrap() runs, but the catalogue never gains the Base model.
    const fakes = fakeCollaborators({
      registerAltimateBase: async () => ({ ok: true }),
      becomesAvailableAfterBootstrap: false,
    })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(false)
    expect(fakes.toastCalls).toHaveLength(1)
    expect(fakes.toastCalls[0].variant).toBe("error")
    expect(fakes.modelSetCalls).toHaveLength(0)
    expect(fakes.dialogClearCount).toBe(0)
  })
})
// altimate_change end

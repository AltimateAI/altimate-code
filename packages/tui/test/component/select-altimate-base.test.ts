// altimate_change start — coverage for the no-dialog Altimate Base picker flow (replaces
// DialogAltimateBaseConfirm). Exercises `selectAltimateBase()` directly with hand-built fakes for
// its collaborators, rather than mounting the full picker component tree: the pickers all funnel
// through this one shared function (dialog-provider.tsx, dialog-model.tsx, the welcome picker in
// this same file), so testing it here covers every call site's outcome without needing an `agent`
// in the render harness (selectModel()'s underlying local.model.set() is agent-scoped, which the
// component-mount fixtures used elsewhere in this package don't set up).
import { afterEach, describe, expect, test } from "bun:test"
import type { useSDK } from "../../src/context/sdk"
import type { useSync } from "../../src/context/sync"
import type { useLocal } from "../../src/context/local"
import type { useToast } from "../../src/ui/toast"
import type { useDialog } from "../../src/ui/dialog"
import { selectAltimateBase, resetSetupComplete } from "../../src/component/altimate-onboarding"

// altimate_change start — Codex/CodeRabbit review finding: `selectAltimateBase()` calls
// `markSetupComplete()` on every successful path, which flips the module-global `setupComplete`
// solid-js signal declared in altimate-onboarding.tsx. That signal is shared with
// `test/context/local.test.ts` (imported there too, and reset around every `markSetupComplete()`
// call it makes) and read by every other suite through `useReady()`/`useSetupComplete()` — Bun's
// test runner shares one module registry across every test file in the run, so a test here left
// it `true` for whichever suite runs next. Restoring it here mirrors local.test.ts's own pattern.
afterEach(() => {
  resetSetupComplete()
})
// altimate_change end

function fakeCollaborators(options: {
  registerAltimateBase?: () => Promise<{ ok: true } | { ok: false; result: "network" | "error"; message: string }>
  fetchImpl?: typeof fetch
  /** Whether the provider list gains the Base model once bootstrap() runs — the real flow's
   *  "the credential was minted, but the catalogue hasn't caught up yet" edge case sets this to
   *  false. */
  becomesAvailableAfterBootstrap?: boolean
  // altimate_change — the Basic-auth headers an attached, password-protected server needs (see
  // cli/cmd/attach.ts + context/sdk.tsx's `headers`).
  headers?: RequestInit["headers"]
}) {
  const modelSetCalls: unknown[] = []
  let dialogClearCount = 0
  let dialogReplaceCount = 0
  const toastCalls: { variant: string; message: string }[] = []
  let disposed = false
  let bootstrapped = false
  const becomesAvailable = options.becomesAvailableAfterBootstrap ?? true
  const providerState: { id: string; models: Record<string, unknown> }[] = []

  // altimate_change start — Codex review finding: `selectAltimateBase()`'s liveness guard compares
  // `dialog.stack.at(-1)` by reference before and after each await. The fake stack starts as a
  // single "the originating picker" item; `simulateDismiss()`/`simulateReplace()` let a test swap
  // it out mid-flight, exactly as a real Escape/backdrop dismissal or an unrelated feature taking
  // over the dialog stack would.
  let stack: { readonly id: string }[] = [{ id: "originating-picker" }]
  // altimate_change end

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
    headers: options.headers, // altimate_change — see the option's declaration above
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
      stack = [] // altimate_change — mirrors the real clearAll()'s empty stack
    },
    replace: (..._args: unknown[]) => {
      dialogReplaceCount++
      stack = [{ id: "replaced" }] // altimate_change — mirrors the real replace()'s new sole item
      return true
    },
    get stack() {
      // altimate_change — see `stack`'s declaration above
      return stack
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
    // altimate_change start — see `stack`'s declaration above
    simulateDismiss() {
      stack = []
    },
    simulateReplace() {
      stack = [{ id: "something-else" }]
    },
    // altimate_change end
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

  // altimate_change start — Codex review finding: the HTTP fallback used a bare `sdk.fetch` call
  // with no auth headers, so it 401ed against an attached, password-protected server (`opencode
  // attach` — cli/cmd/attach.ts) even though `sdk.headers` (the same Basic-auth headers
  // `createOpencodeClient` bakes into every typed SDK call) was one merge away.
  test("an attached TUI's HTTP fallback sends the SDK's auth headers", async () => {
    let seenHeaders: Headers | undefined
    const fakes = fakeCollaborators({
      registerAltimateBase: undefined,
      headers: { Authorization: "Basic dGVzdDpwYXNz" },
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers)
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(true)
    expect(seenHeaders?.get("Authorization")).toBe("Basic dGVzdDpwYXNz")
    expect(seenHeaders?.get("Content-Type")).toBe("application/json")
  })
  // altimate_change end

  test("reports the registration outcome for the onboarding funnel", async () => {
    const results: string[] = []
    const ok = fakeCollaborators({ registerAltimateBase: async () => ({ ok: true }) })
    await selectAltimateBase({ ...ok, onRegisterResult: (r) => results.push(r) })
    const failed = fakeCollaborators({
      registerAltimateBase: async () => ({ ok: false, result: "network", message: "offline" }),
    })
    await selectAltimateBase({ ...failed, onRegisterResult: (r) => results.push(r) })
    expect(results).toEqual(["success", "network"])
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

  // altimate_change start — Codex review finding: registration and bootstrap are both async;
  // if the originating picker went away (dismissed, or replaced by something else) while either
  // was in flight, `selectAltimateBase()` must not select the model or call `dialog.clear()` —
  // that `clear()` would close whatever the user has open NOW, not the picker that started this.
  test("does not select the model or clear the dialog if the picker was dismissed while registration was in flight", async () => {
    const fakes = fakeCollaborators({
      registerAltimateBase: async () => {
        // The user pressed Escape while this await was pending.
        fakes.simulateDismiss()
        return { ok: true }
      },
    })

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(false)
    expect(fakes.modelSetCalls).toHaveLength(0)
    expect(fakes.dialogClearCount).toBe(0)
    expect(fakes.disposed).toBe(false)
    expect(fakes.bootstrapped).toBe(false)
    expect(fakes.toastCalls).toHaveLength(0)
  })

  test("does not select the model or clear the dialog if something else replaced the dialog during bootstrap", async () => {
    const fakes = fakeCollaborators({
      registerAltimateBase: async () => ({ ok: true }),
    })
    const realBootstrap = fakes.sync.bootstrap
    fakes.sync.bootstrap = async () => {
      const result = await realBootstrap()
      // A different feature (e.g. the command palette) took over the dialog stack while this
      // await was pending.
      fakes.simulateReplace()
      return result
    }

    const result = await selectAltimateBase(fakes)

    expect(result).toBe(false)
    expect(fakes.modelSetCalls).toHaveLength(0)
    expect(fakes.dialogClearCount).toBe(0)
    expect(fakes.toastCalls).toHaveLength(0)
  })
  // altimate_change end
})
// altimate_change end

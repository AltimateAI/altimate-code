/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex HOLD finding 1 (+ re-review round 8): coverage for the kv.ready
// "pending" defer path.
//
// `hasUsableFreeDefaultGated`'s own unit test (local.test.ts) proves the pure gate itself reports
// `"pending"` (not a boolean guess either way) while kv is unready. This file proves the
// CONSEQUENCE: a submit attempted while `useReadyPending()` is true must be neither sent early
// (Codex's finding — skips onboarding/migration) nor discarded (Kilo's original finding), but
// deferred and automatically retried once pending resolves — using `createDeferredRetry`
// (util/signal.ts), the SAME production primitive `component/prompt/index.tsx`'s submit gate
// calls, against a manually-controlled signal standing in for `useReadyPending()`/`useReady()`.
//
// Codex re-review round 8: this file originally re-implemented its own copy of the defer+retry
// flag/effect shape rather than importing the real one — meaning reverting the actual fix in
// prompt/index.tsx left this test passing regardless, since it never touched production code at
// all. `createDeferredRetry` was extracted specifically to close that gap: `DeferThenRetryHarness`
// below now calls it directly, so a regression in the SHARED primitive (or its removal from the
// real submit gate) is exactly what this test would need to still be testing anything.
//
// Mounted via `testRender` (a bare component, no context providers) rather than a plain
// `createRoot()` call: bare `solid-js` imported outside `@opentui/solid`'s render pipeline
// resolves to its SSR build in this test environment, whose effects run once at creation and
// never re-fire on a later signal write — `testRender` is what gives this file the real,
// client-reactive `solid-js` runtime the production code actually runs under.
//
// IMPORTANT — this is deliberately NOT an end-to-end mount of `<Prompt>` inside the real provider
// tree, and that is a documented finding, not an oversight: `KVProvider` and `LocalProvider` are
// both built on `createSimpleContext` (context/helper.tsx), whose `provider` wraps `children` in
// `<Show when={init.ready === undefined || init.ready === true}>`. Since both providers expose a
// `ready` getter, NEITHER renders its children — and `<App>`/`<Home>`/`<Prompt>` sit nested inside
// both, per app.tsx's provider tree — until `kv.ready` AND `local.model.ready` are already true.
// Verified empirically while writing this test: a capture component mounted inside the real
// `<KVProvider><LocalProvider>` tree never observes `kv.ready === false` — it simply never renders
// until `kv.ready` is already true, because `Show` withholds its children rather than rendering
// them and letting a child branch on readiness itself. That means the exact "prompt gate fires
// while kv is still hydrating" window Kilo originally flagged is very likely NOT reachable through
// the actual interactive Prompt path in the current codebase — reported alongside this file. The
// fix is kept anyway (a `"pending"` third state is a more honest contract than guessing a boolean
// either way, costs nothing, and is defense-in-depth against this invariant ever changing), and
// this test validates the MECHANISM directly — via the real shared primitive — rather than
// asserting an end-to-end scenario that cannot currently be constructed through the real provider
// tree.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createDeferredRetry } from "../../src/util/signal"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

/** Mirrors component/prompt/index.tsx's `submitInner()` gate, built on the SAME shared
 * `createDeferredRetry` primitive the real submit gate uses (see this file's header comment). */
function DeferThenRetryHarness(props: {
  ready: () => boolean
  pending: () => boolean
  promptText: () => string
  setPromptText: (value: string) => void
  onSend: (value: string) => void
  onDiscard: () => void
  exposeSubmit: (fn: () => boolean) => void
}) {
  function attemptSubmit() {
    if (!props.promptText()) return false
    if (!props.ready()) {
      if (props.pending()) {
        deferredSubmit.defer()
        return false
      }
      props.setPromptText("")
      props.onDiscard()
      return false
    }
    props.onSend(props.promptText())
    props.setPromptText("")
    return true
  }
  const deferredSubmit = createDeferredRetry(props.pending, () => void attemptSubmit())
  props.exposeSubmit(attemptSubmit)
  return null
}

async function mountHarness(options: { initialPending: boolean; willBeReady: boolean; promptText?: string }) {
  const [pending, setPending] = createSignal(options.initialPending)
  const ready = () => !pending() && options.willBeReady
  const [promptText, setPromptText] = createSignal(options.promptText ?? "hello from before kv.ready")
  const submitSpy: string[] = []
  let discarded = false
  let submit: (() => boolean) | undefined

  const app = await testRender(() => (
    <DeferThenRetryHarness
      ready={ready}
      pending={pending}
      promptText={promptText}
      setPromptText={setPromptText}
      onSend={(value) => submitSpy.push(value)}
      onDiscard={() => {
        discarded = true
      }}
      exposeSubmit={(fn) => {
        submit = fn
      }}
    />
  ))
  await app.renderOnce()
  await waitUntil(() => submit !== undefined)

  return {
    attemptSubmit: () => submit!(),
    setPending,
    promptText,
    submitSpy,
    discarded: () => discarded,
    cleanup() {
      app.renderer.destroy()
    },
  }
}

test.serial(
  "defer-then-retry: a submit issued while pending is neither sent nor lost, and resolves once pending clears (usable)",
  async () => {
    const h = await mountHarness({ initialPending: true, willBeReady: true })
    try {
      // The submit attempted while pending: deferred, not sent, not discarded.
      expect(h.attemptSubmit()).toBe(false)
      expect(h.submitSpy).toEqual([])
      expect(h.promptText()).toBe("hello from before kv.ready")

      // kv resolves ("declined" — usable): the retry effect fires automatically, with no second
      // `attemptSubmit()` call from the test — proving the RETRY is automatic, not manual.
      h.setPending(false)
      await waitUntil(() => h.submitSpy.length > 0)
      expect(h.submitSpy).toEqual(["hello from before kv.ready"])
      expect(h.promptText()).toBe("")
    } finally {
      h.cleanup()
    }
  },
)

test.serial(
  "defer-then-retry: a submit issued while pending is neither sent nor lost, and is correctly discarded once pending clears (not usable)",
  async () => {
    const h = await mountHarness({ initialPending: true, willBeReady: false })
    try {
      expect(h.attemptSubmit()).toBe(false)
      expect(h.submitSpy).toEqual([])
      expect(h.promptText()).toBe("hello from before kv.ready")
      expect(h.discarded()).toBe(false)

      // kv resolves to "not declined", and nothing else makes this launch ready — the deferred
      // retry re-evaluates `ready()` fresh and correctly finds it still false, taking the
      // discard branch (matching the real gate's picker-reopen path) rather than sending stale
      // input through.
      h.setPending(false)
      await waitUntil(() => h.discarded())
      expect(h.submitSpy).toEqual([])
      expect(h.promptText()).toBe("")
    } finally {
      h.cleanup()
    }
  },
)

test.serial("defer-then-retry: a submit issued once already ready sends immediately, no defer", async () => {
  const h = await mountHarness({ initialPending: false, willBeReady: true, promptText: "hello, already ready" })
  try {
    expect(h.attemptSubmit()).toBe(true)
    expect(h.submitSpy).toEqual(["hello, already ready"])
    expect(h.promptText()).toBe("")
    expect(h.discarded()).toBe(false)
  } finally {
    h.cleanup()
  }
})
// altimate_change end

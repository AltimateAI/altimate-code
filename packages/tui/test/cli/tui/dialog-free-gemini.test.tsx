/** @jsxImportSource @opentui/solid */
// altimate_change — consent gate for the free Gemini Flash tier.
//
// The load-bearing property is ORDER: the disclosure is on screen before anything identifying
// the install reaches the gateway. Registration happens opencode-side over
// POST /altimate/free/register, so "did we call the gateway" is observable here as "did the TUI
// hit that endpoint" — and it must not, until the user says yes.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import type { OnboardingTelemetryEvent } from "../../../src/context/onboarding-telemetry"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const REGISTER_PATH = "/altimate/free/register"

// altimate_change — `dispose` and `provider` are gateable independently of `register` so a test
// can dismiss the dialog DURING each awaited step. Gating only registration cannot exercise the
// post-dispose or post-bootstrap latches: by the time registration resolves the dialog is already
// gone, the first check returns, and removing the later checks changes nothing.
type Handler = Response | (() => Response | Promise<Response>)
async function mountConfirm({
  register = json({ ok: true }),
  dispose,
  provider,
}: { register?: Handler; dispose?: Handler; provider?: Handler } = {}) {
  const [
    { DialogProvider },
    { DialogFreeGeminiConfirm, FREE_GEMINI_DISCLOSURE, resetSetupComplete, markFirstRunActive, useSetupComplete },
    { OnboardingTelemetryProvider },
    { ArgsProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider },
    { LocalProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { ExitProvider },
    { RouteProvider },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/altimate-onboarding"),
    import("../../../src/context/onboarding-telemetry"),
    import("../../../src/context/args"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/context/sdk"),
    import("../../../src/context/project"),
    import("../../../src/context/sync"),
    import("../../../src/context/local"),
    import("../../../src/keymap"),
    import("../../../src/context/exit"),
    import("../../../src/context/route"),
  ])

  resetSetupComplete()
  markFirstRunActive()

  const events: OnboardingTelemetryEvent[] = []
  const requests: string[] = []

  const inner = createFetch((url) => {
    if (url.pathname === REGISTER_PATH) return typeof register === "function" ? register() : register
    if (url.pathname === "/instance/dispose") return dispose ? (typeof dispose === "function" ? dispose() : dispose) : json({})
    if (url.pathname === "/provider" && provider) return typeof provider === "function" ? provider() : provider
    if (url.pathname === "/provider")
      return json({
        all: [{ id: "altimate-free", name: "Altimate Free", models: {}, env: [] }],
        default: {},
        connected: [],
      })
    return undefined
  })
  // Wrapped so requests the shared fixture answers itself are recorded too — the assertion that
  // matters is a negative one, and it has to see every request the dialog made.
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
    return inner.fetch(input, init)
  }) as typeof globalThis.fetch

  const source = createEventSource()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts>
        <ExitProvider exit={() => {}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={resolvedConfig}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <SDKProvider url="http://test" directory={directory} fetch={fetch} events={source.source}>
                        <ProjectProvider>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <OnboardingTelemetryProvider
                                  track={(e) => {
                                    events.push(e)
                                  }}
                                >
                                  <DialogProvider>
                                    <DialogFreeGeminiConfirm origin="welcome" />
                                  </DialogProvider>
                                </OnboardingTelemetryProvider>
                              </LocalProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ProjectProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await app.renderOnce()
  await Bun.sleep(50)
  await app.renderOnce()
  return {
    app,
    events,
    requests,
    disclosure: FREE_GEMINI_DISCLOSURE,
    registrations: () => requests.filter((p) => p === REGISTER_PATH),
    // altimate_change — module-level signal, readable outside the component. The success path
    // ends with markSetupComplete(); it staying false is how a test sees that a dismissed
    // continuation did NOT run to completion.
    setupComplete: useSetupComplete(),
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("the disclosure text is the exact notice users were promised", async () => {
  const confirm = await mountConfirm()
  try {
    expect(confirm.disclosure).toBe(
      "Free model — requests and responses are logged and may be used to improve Altimate's products and services. Don't send secrets or confidential code. No signup required.",
    )
  } finally {
    await confirm.cleanup()
  }
})

test("the dialog shows the disclosure and defaults to No, with nothing sent to the gateway", async () => {
  const confirm = await mountConfirm()
  try {
    const frame = confirm.app.captureCharFrame()
    expect(frame).toContain("Gemini Flash (Free)")
    // Fragments rather than the whole sentence: the notice is word-wrapped across frame lines.
    expect(frame).toContain("requests and responses are logged")
    expect(frame).toContain("No signup required.")
    expect(frame).toContain("No — pick something else")
    expect(frame).toContain("(default)")

    // The whole point of the consent gate.
    expect(confirm.registrations()).toHaveLength(0)
    expect(confirm.events).toEqual([{ name: "free_gemini_confirm_shown", origin: "welcome" }])
  } finally {
    await confirm.cleanup()
  }
})

test("declining records a cancel and still sends nothing", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("n")
    await wait(() => confirm.events.some((e) => e.name === "free_gemini_choice"))
    await Bun.sleep(50)

    expect(confirm.events).toContainEqual({ name: "free_gemini_choice", choice: "cancel" })
    expect(confirm.registrations()).toHaveLength(0)
  } finally {
    await confirm.cleanup()
  }
})

test("accepting registers exactly once and records the outcome", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.events.some((e) => e.name === "free_gemini_register_result"))
    await Bun.sleep(50)

    expect(confirm.events).toContainEqual({ name: "free_gemini_choice", choice: "accept" })
    expect(confirm.events).toContainEqual({ name: "free_gemini_register_result", result: "success" })
    expect(confirm.registrations()).toHaveLength(1)
    // The accept path must not also emit the cleanup cancel when the dialog closes.
    expect(confirm.events.filter((e) => e.name === "free_gemini_choice")).toHaveLength(1)
  } finally {
    await confirm.cleanup()
  }
})

test("one user records one choice, however the dialog ends", async () => {
  // The dialog outlives the decision on the failure path, so the accept latch and the "dialog is
  // finished" latch are not the same thing: a retry, and the dismissal that eventually follows,
  // must not each add another choice for the same user.
  const confirm = await mountConfirm({
    register: () => json({ ok: false, message: "Too many sign-ups", status: 429 }),
  })
  try {
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.events.some((e) => e.name === "free_gemini_register_result"))
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.registrations().length === 2)
    await confirm.cleanup()
    await Bun.sleep(50)

    const choices = confirm.events.filter((e) => e.name === "free_gemini_choice")
    expect(choices).toEqual([{ name: "free_gemini_choice", choice: "accept" }])
  } finally {
    confirm.app.renderer.destroy()
  }
})

test("a rejection delivered as a non-2xx is still classified, not reported as a network failure", async () => {
  // The route answers 200 with ok:false, but a non-2xx from anywhere else in the stack puts the
  // body on the client's error channel. Reading only `data` turned every such rejection into
  // `network`, which is the one classification that tells an operator nothing.
  const confirm = await mountConfirm({
    register: () => json({ ok: false, message: "Too many sign-ups", status: 429 }, { status: 502 }),
  })
  try {
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.events.some((e) => e.name === "free_gemini_register_result"))
    expect(confirm.events).toContainEqual({ name: "free_gemini_register_result", result: "rate_limited" })
  } finally {
    await confirm.cleanup()
  }
})

test("escaping mid-registration does not switch the model out from under the user", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const confirm = await mountConfirm({ register: async () => (await gate, json({ ok: true })) })
  try {
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.registrations().length === 1)
    await confirm.cleanup()
    release!()
    await Bun.sleep(100)

    // The credential is stored either way — the user can pick the model from the picker. What must
    // not happen is a dialog we no longer own being cleared, or the model being switched.
    expect(confirm.requests.filter((p) => p === "/instance/dispose")).toHaveLength(0)
  } finally {
    release!()
    confirm.app.renderer.destroy()
  }
})

test("a rejected registration is visible and leaves the dialog open to retry", async () => {
  const confirm = await mountConfirm({
    register: () => json({ ok: false, message: "Too many sign-ups", status: 429 }),
  })
  try {
    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.events.some((e) => e.name === "free_gemini_register_result"))
    await confirm.app.renderOnce()

    expect(confirm.events).toContainEqual({ name: "free_gemini_register_result", result: "rate_limited" })
    // Failing silently would leave the user staring at an unchanged dialog.
    expect(confirm.app.captureCharFrame()).toContain("Too many sign-ups")

    confirm.app.mockInput.pressKey("y")
    await wait(() => confirm.registrations().length === 2)
  } finally {
    await confirm.cleanup()
  }
})

// altimate_change — the accept path awaits THREE things: registration, instance dispose, and
// sync bootstrap. The pre-existing test dismisses during registration only, which is caught by
// the first `disposed` check; removing the two later checks leaves it green. These dismiss during
// each of the later awaits, so each latch has a test that fails without it.

test("escaping during instance dispose stops before bootstrap", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const confirm = await mountConfirm({ dispose: async () => (await gate, json({})) })
  try {
    confirm.app.mockInput.pressKey("y")
    // Registration completed and the dialog is now blocked inside instance.dispose.
    await wait(() => confirm.requests.filter((p) => p === "/instance/dispose").length === 1)

    const providerCallsBefore = confirm.requests.filter((p) => p === "/provider").length
    await confirm.cleanup()
    release!()
    await Bun.sleep(100)

    // Without the post-dispose latch the continuation proceeds into sync.bootstrap(), which
    // fetches /provider. Nothing after the dismissal should have reached it.
    expect(confirm.requests.filter((p) => p === "/provider").length).toBe(providerCallsBefore)
    expect(confirm.setupComplete()).toBe(false)
  } finally {
    release!()
    confirm.app.renderer.destroy()
  }
})

test("escaping during sync bootstrap does not complete setup or switch the model", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  // SyncProvider fetches /provider once at mount too. Blocking that one would stall the mount
  // before the dialog is interactive, so only the bootstrap-time call is gated.
  let blockProvider = false
  const confirm = await mountConfirm({
    provider: async () => {
      if (blockProvider) await gate
      return json({
        all: [{ id: "altimate-free", name: "Altimate Free", models: { "gemini-flash-free": {} }, env: [] }],
        default: {},
        connected: [],
      })
    },
  })
  try {
    blockProvider = true
    confirm.app.mockInput.pressKey("y")
    // Past registration and past instance.dispose, now blocked inside sync.bootstrap().
    await wait(() => confirm.requests.filter((p) => p === "/instance/dispose").length === 1)
    await wait(() => confirm.requests.filter((p) => p === "/provider").length >= 2)

    await confirm.cleanup()
    release!()
    await Bun.sleep(150)

    // The provider IS available in this fixture, so without the post-bootstrap latch the
    // continuation runs to the end: dialog.clear(), local.model.set(), markSetupComplete().
    // setupComplete staying false is the observable that the continuation stopped.
    expect(confirm.setupComplete()).toBe(false)
  } finally {
    release!()
    confirm.app.renderer.destroy()
  }
})

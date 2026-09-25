/** @jsxImportSource @opentui/solid */
// altimate_change — onboarding funnel coverage for the curated first-run picker.
//
// Mounts DialogModelWelcome in the real provider stack with a capturing telemetry tracker, and
// checks that a user action produces the event an analyst would expect.
//
// The fake SDK must serve real provider options. An earlier version served an empty list, which
// put the dialog in exactly the degenerate state where `connectProvider` finds nothing and
// silently no-ops — so the tests passed while asserting nothing about whether the row worked.
// `availableProviders` controls that list so the filtered-provider case can be exercised too: the
// server legitimately filters providers via enabled_providers/disabled_providers while the picker
// renders five hardcoded rows.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import type { OnboardingTelemetryEvent } from "../../../src/context/onboarding-telemetry"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** Pinned to the real event union, so a renamed trigger breaks this test at compile time. */
type PickerTrigger = Extract<OnboardingTelemetryEvent, { name: "model_picker_shown" }>["trigger"]

const ALL_PROVIDER_IDS = ["altimate-backend", "anthropic", "openai", "google", "opencode"]

async function mountPicker(
  trigger?: PickerTrigger,
  availableProviders: string[] = ALL_PROVIDER_IDS,
  // altimate_change — `registerOutcomes` scripts the Altimate Base register endpoint (consumed
  // one outcome per call, "ok" once exhausted) so the retry test below can force a failure.
  { firstRun = true, registerOutcomes = [] as Array<"ok" | "error"> }: { firstRun?: boolean; registerOutcomes?: Array<"ok" | "error"> } = {},
) {
  const [
    { DialogProvider },
    { DialogModelWelcome },
    { OnboardingTelemetryProvider },
    { ArgsProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, useToast },
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

  // The choice events are funnel-only: /connect and /model open these same dialogs for an
  // established user, so they are gated on an active first run. Simulate that here, and see the
  // last test for the ungated case.
  const onboarding = await import("../../../src/component/altimate-onboarding")
  onboarding.resetSetupComplete()
  if (firstRun) onboarding.markFirstRunActive()

  // altimate_change — repo rule: tests must not touch real global state. Without this, every
  // test in this file shared the SAME default `/tmp/opencode/state` (TestTuiContexts's hardcoded
  // fallback) for both `kv.tsx`'s `kv.json` file (`paths.state`) and the `Flock.withLock` it takes
  // while reading/writing that file (keyed off `Global.Path.state`, overridden separately via
  // `OPENCODE_TEST_STATE_HOME` — see context/cycle-stability.test.tsx's comment on the same
  // isolation) — resource contention across concurrently-running test files/suites.
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  process.env.OPENCODE_TEST_STATE_HOME = tmp.path

  const events: OnboardingTelemetryEvent[] = []
  // altimate_change — see `registerOutcomes` above
  let registerCallCount = 0
  const outcomes = [...registerOutcomes]
  // altimate_change — the retry test below polls this instead of a fixed sleep to know when the
  // failed selection's promise chain (register -> toast) has actually settled.
  const toastMessages: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/provider") {
      return Response.json({
        all: availableProviders.map((id) => ({ id, name: id, models: {}, env: [] })),
        default: {},
        connected: [],
      })
    }
    if (url.pathname === "/altimate/base/register") {
      registerCallCount++
      const outcome = outcomes.shift() ?? "ok"
      return Response.json(
        outcome === "ok" ? { ok: true } : { ok: false, result: "network", message: "offline" },
      )
    }
    return undefined
  })
  const source = createEventSource()

  // altimate_change — see `toastMessages` above
  function ToastProbe() {
    const toast = useToast()
    createEffect(() => {
      const message = toast.currentToast?.message
      if (message) toastMessages.push(message)
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <ToastProbe />
                  <RouteProvider>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={source.source}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            {/* above DialogProvider, mirroring app.tsx */}
                            <OnboardingTelemetryProvider track={(e) => { events.push(e) }}>
                              <DialogProvider>
                                <DialogModelWelcome trigger={trigger} />
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
    // altimate_change — see `registerOutcomes` above
    get registerCallCount() {
      return registerCallCount
    },
    // altimate_change — see `toastMessages` above
    get toastShown() {
      return toastMessages.length > 0
    },
    async cleanup() {
      app.renderer.destroy()
      // altimate_change — see the state-isolation comment above
      if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
      else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("picker records an impression with the trigger that opened it", async () => {
  const picker = await mountPicker("first_run")
  try {
    await wait(() => picker.events.length > 0)
    expect(picker.events[0]).toEqual({ name: "model_picker_shown", trigger: "first_run" })
  } finally {
    await picker.cleanup()
  }
})

test("picker opened without an explicit trigger is attributed to /connect", async () => {
  const picker = await mountPicker()
  try {
    await wait(() => picker.events.length > 0)
    expect(picker.events[0]).toEqual({ name: "model_picker_shown", trigger: "connect_command" })
  } finally {
    await picker.cleanup()
  }
})

test("choosing the first row records the gateway provider", async () => {
  const picker = await mountPicker("first_run")
  try {
    await wait(() => picker.events.length > 0)
    picker.app.mockInput.pressEnter()
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))

    // Raw ids: the host classifies them against its public-provider allowlist.
    const selected = picker.events.filter((e) => e.name === "provider_selected")
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ providerID: "altimate-backend" })
  } finally {
    await picker.cleanup()
  }
})

test("a rapid second Enter does not record two selections", async () => {
  const picker = await mountPicker("first_run")
  try {
    await wait(() => picker.events.length > 0)
    picker.app.mockInput.pressEnter()
    picker.app.mockInput.pressEnter()
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))
    await Bun.sleep(50)

    expect(picker.events.filter((e) => e.name === "provider_selected")).toHaveLength(1)
  } finally {
    await picker.cleanup()
  }
})

test("the / shortcut records the same choice as the search row", async () => {
  const picker = await mountPicker("first_run")
  try {
    await wait(() => picker.events.length > 0)
    picker.app.mockInput.pressKey("/")
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))

    const searched = picker.events.filter((e) => e.name === "provider_selected")
    expect(searched).toHaveLength(1)
    expect(searched[0]).toMatchObject({ searchAll: true })
  } finally {
    await picker.cleanup()
  }
})

test("outside a first run the picker records an impression but not a choice", async () => {
  // /connect opens this exact dialog for an established user. `model_picker_shown` carries a
  // trigger so it stays distinguishable, but `provider_selected` does not — an ungated emit would
  // contaminate that launch's funnel with a returning user's routine provider switch.
  const picker = await mountPicker("connect_command", ALL_PROVIDER_IDS, { firstRun: false })
  try {
    await wait(() => picker.events.length > 0)
    picker.app.mockInput.pressEnter()
    await Bun.sleep(150)

    expect(picker.events.map((e) => e.name)).toEqual(["model_picker_shown"])
  } finally {
    await picker.cleanup()
  }
})

// altimate_change start — Codex review finding: `chooseAltimateBase()` returned `true`
// synchronously right after firing the (unawaited) `selectAltimateBase()` call, so `activateRow()`
// claimed the one-shot latch before the registration attempt was known to have failed. On the
// first-run welcome picker — the one shown to users with no model at all — a failed Base
// registration then bricked Enter, `/` and mouse-up for the rest of the dialog session. Confirms
// the fix: the same row can be retried after a failure, and the register attempt actually re-fires.
// It covers the re-fire only: the mocked `/provider` never lists Base's model, so the second
// attempt cannot complete a selection here (selectAltimateBase's success path is tested directly).
test("a failed Altimate Base selection on the welcome picker re-fires registration when retried", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "altimate-free"], {
    registerOutcomes: ["error", "ok"],
  })
  try {
    // Rows: gateway, anthropic, openai, google, Altimate Base, search — four Down presses lands on
    // the Base row.
    for (let i = 0; i < 4; i++) picker.app.mockInput.pressKey("ARROW_DOWN")
    picker.app.mockInput.pressEnter()
    await wait(() => picker.registerCallCount === 1)
    // `chooseAltimateBase()` fires `selectAltimateBase()` without awaiting it, so the latch reset
    // (on the failure branch) lands a beat after the register call itself resolves. Poll for the
    // failure toast — the last thing `selectAltimateBase()` does before returning `false` — rather
    // than a fixed sleep, so this doesn't race under load.
    await wait(() => picker.toastShown)

    // Before the fix, the row's one-shot latch stayed set after the failed attempt above, so this
    // second Enter would silently no-op — registerCallCount would stay at 1 forever.
    picker.app.mockInput.pressEnter()
    await wait(() => picker.registerCallCount === 2)

    expect(picker.registerCallCount).toBe(2)
  } finally {
    await picker.cleanup()
  }
})
// altimate_change end

test("a row for a provider the server filtered out does not brick the dialog", async () => {
  // The server filters providers via enabled_providers/disabled_providers while this picker renders
  // five hardcoded rows. Selecting a filtered-out row used to claim the double-submit latch before
  // dispatching anything, leaving the first-run gate permanently inert.
  const picker = await mountPicker("first_run", ["anthropic"])
  try {
    await wait(() => picker.events.length > 0)
    picker.app.mockInput.pressEnter() // row 1 = gateway, absent from the server list
    await Bun.sleep(150)
    expect(picker.events.some((e) => e.name === "provider_selected")).toBe(false)

    // The dialog must still respond afterwards. Before the fix the latch was claimed on that
    // failed press, so every later key returned early and the first-run gate was stuck for good.
    picker.app.mockInput.pressKey("/")
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))
    expect(picker.events.filter((e) => e.name === "provider_selected")[0]).toMatchObject({
      searchAll: true,
    })
  } finally {
    await picker.cleanup()
  }
})

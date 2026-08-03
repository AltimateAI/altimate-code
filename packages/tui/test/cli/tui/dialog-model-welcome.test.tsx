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
import { onCleanup } from "solid-js"
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
  { firstRun = true }: { firstRun?: boolean } = {},
) {
  const [
    { DialogProvider },
    { DialogModelWelcome },
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

  // The choice events are funnel-only: /connect and /model open these same dialogs for an
  // established user, so they are gated on an active first run. Simulate that here, and see the
  // last test for the ungated case.
  const onboarding = await import("../../../src/component/altimate-onboarding")
  onboarding.resetSetupComplete()
  if (firstRun) onboarding.markFirstRunActive()

  const events: OnboardingTelemetryEvent[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/provider") {
      return Response.json({
        all: availableProviders.map((id) => ({ id, name: id, models: {}, env: [] })),
        default: {},
        connected: [],
      })
    }
    return undefined
  })
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
    async cleanup() {
      app.renderer.destroy()
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

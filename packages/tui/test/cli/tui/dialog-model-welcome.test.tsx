/** @jsxImportSource @opentui/solid */
// altimate_change — onboarding funnel coverage for the curated first-run picker.
//
// Mounts DialogModelWelcome in the real provider stack with a capturing telemetry tracker, and
// checks that a user action produces the event an analyst would expect. The fake SDK serves an
// empty provider list, which is fine here: the curated rows are hardcoded, and the funnel event
// is recorded at the moment of choice — before the provider lookup that would act on it.
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

async function mountPicker(trigger?: PickerTrigger) {
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

  const events: OnboardingTelemetryEvent[] = []
  const calls = createFetch()
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
                            <OnboardingTelemetryProvider track={(e) => events.push(e)}>
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

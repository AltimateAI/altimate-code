/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import type { OnboardingTelemetryEvent } from "../../../src/context/onboarding-telemetry"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountConfirm(
  input: {
    registration?:
      | { ok: true }
      | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }
      | (() => Promise<
          { ok: true } | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }
        >)
    modelAvailable?: boolean
    origin?: "welcome" | "migration"
  } = {},
) {
  const [
    { DialogProvider, useDialog },
    {
      DialogAltimateBaseConfirm,
      ALTIMATE_BASE_DISCLOSURE,
      resetSetupComplete,
      markFirstRunActive,
      useSetupComplete,
    },
    { OnboardingTelemetryProvider },
    { ArgsProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { SDKProvider },
    { AltimateBaseConsentProvider },
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
    // altimate_change — the registration operation is provided through this dedicated context,
    // not through SDKProvider; see context/altimate-base-consent.tsx.
    import("../../../src/context/altimate-base-consent"),
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
  const registrations: true[] = []
  const declines: true[] = []
  let replaceDialog = () => false
  const model = {
    id: "altimate-base",
    providerID: "altimate-free",
    name: "Altimate Base",
    family: "altimate",
    status: "active",
    capabilities: {},
    cost: { input: 0, output: 0 },
    limit: { context: 65_536, output: 4_096 },
  }
  const provider = { id: "altimate-free", name: "Altimate", models: { "altimate-base": model }, env: [] }
  const bigPickle = {
    ...model,
    id: "big-pickle",
    providerID: "opencode",
    name: "Big Pickle",
    family: "glm",
  }
  const openCodeProvider = { id: "opencode", name: "Legacy Zen", models: { "big-pickle": bigPickle }, env: [] }
  const inner = createFetch((url) => {
    if (url.pathname === "/instance/dispose") return json({})
    if (url.pathname === "/config/providers") {
      return json({
        providers: input.modelAvailable === false ? [openCodeProvider] : [provider, openCodeProvider],
        default: {},
      })
    }
    if (url.pathname === "/provider") {
      return json({
        all: [provider, openCodeProvider],
        default: {},
        connected: input.modelAvailable === false ? ["opencode"] : ["altimate-free", "opencode"],
      })
    }
    return undefined
  })
  const source = createEventSource()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1_000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    function OpenConfirm() {
      const dialog = useDialog()
      replaceDialog = () => dialog.replace(() => <text>Session list replacement</text>)
      onMount(() =>
        dialog.replace(() => (
          <DialogAltimateBaseConfirm origin={input.origin ?? "welcome"} onDecline={() => declines.push(true)} />
        )),
      )
      return null
    }

    return (
      <TestTuiContexts>
        <ExitProvider exit={() => {}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={resolvedConfig}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <SDKProvider url="http://test" directory={directory} fetch={inner.fetch} events={source.source}>
                        <AltimateBaseConsentProvider
                          value={async () => {
                            registrations.push(true)
                            return typeof input.registration === "function"
                              ? input.registration()
                              : (input.registration ?? { ok: true })
                          }}
                        >
                          <ProjectProvider>
                            <SyncProvider>
                              <ThemeProvider mode="dark">
                                <LocalProvider>
                                  <OnboardingTelemetryProvider
                                    track={(event) => {
                                      events.push(event)
                                    }}
                                  >
                                    <DialogProvider>
                                      <OpenConfirm />
                                    </DialogProvider>
                                  </OnboardingTelemetryProvider>
                                </LocalProvider>
                              </ThemeProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </AltimateBaseConsentProvider>
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
    disclosure: ALTIMATE_BASE_DISCLOSURE,
    setupComplete: useSetupComplete(),
    registrations: () => registrations,
    declines: () => declines,
    replaceDialog: () => replaceDialog(),
    cleanup() {
      app.renderer.destroy()
      resetSetupComplete()
    },
  }
}

test.serial("Altimate Base shows the privacy disclosure before registration and defaults to No", async () => {
  const confirm = await mountConfirm()
  try {
    const frame = confirm.app.captureCharFrame()
    expect(confirm.disclosure).toContain("Requests and responses may be logged")
    expect(frame).toContain("Use Altimate Base?")
    expect(frame.replace(/\s+/g, " ")).toContain("Requests and responses may be logged and used")
    expect(frame).toContain("No — pick something else")
    expect(frame).toContain("(default)")
    expect(confirm.registrations()).toHaveLength(0)
    expect(confirm.events).toEqual([{ name: "altimate_base_confirm_shown", origin: "welcome" }])
  } finally {
    confirm.cleanup()
  }
})

test.serial(
  "the Big Pickle migration reuses consent, stays out of first-run telemetry, and routes No to the picker",
  async () => {
    const confirm = await mountConfirm({ origin: "migration" })
    try {
      const frame = confirm.app.captureCharFrame()
      expect(frame).toContain("No — pick something else")
      expect(frame.replace(/\s+/g, " ")).toContain("Requests and responses may be logged and used")
      expect(confirm.events).toEqual([])

      confirm.app.mockInput.pressKey("n")
      await waitUntil(() => confirm.declines().length === 1)
      expect(confirm.registrations()).toHaveLength(0)
      // altimate_change — "No — pick something else" must actually route somewhere: Big Pickle is
      // retired, so declining the migration prompt lands the user in the curated picker instead of
      // silently leaving the dialog cleared (the label used to promise a re-pick that never
      // happened).
      await waitUntil(() => confirm.events.some((event) => event.name === "model_picker_shown"))
      expect(confirm.events).toEqual([{ name: "model_picker_shown", trigger: "altimate_base_back" }])
      await confirm.app.renderOnce()
      expect(confirm.app.captureCharFrame()).toContain("Altimate LLM Gateway")
    } finally {
      confirm.cleanup()
    }
  },
)

test.serial("declining Altimate Base makes no registration request, and Big Pickle is not offered as a new pick", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("n")
    await waitUntil(() => confirm.events.some((event) => event.name === "altimate_base_choice"))
    expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "cancel" })
    expect(confirm.registrations()).toHaveLength(0)
    confirm.app.mockInput.pressKey("/")
    await confirm.app.renderOnce()
    // altimate_change — Big Pickle is retired as a NEW selectable option: the full catalog opened
    // via search must not offer it, even though the fixture still wires up an "opencode" provider
    // (used elsewhere to prove the migration path still recognizes a legacy selection).
    expect(confirm.app.captureCharFrame()).not.toContain("Big Pickle")
    expect(confirm.registrations()).toHaveLength(0)
  } finally {
    confirm.cleanup()
  }
})

test.serial("accepting registers once through the private host operation and completes setup", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("y")
    await waitUntil(() => confirm.setupComplete())
    expect(confirm.registrations()).toHaveLength(1)
    expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "accept" })
    expect(confirm.events).toContainEqual({ name: "altimate_base_register_result", result: "success" })
    expect(confirm.events.filter((event) => event.name === "altimate_base_choice")).toHaveLength(1)
  } finally {
    confirm.cleanup()
  }
})

test.serial("registration without a usable model remains incomplete and visibly recoverable", async () => {
  const confirm = await mountConfirm({ modelAvailable: false })
  try {
    confirm.app.mockInput.pressKey("y")
    await waitUntil(() => confirm.events.some((event) => event.name === "altimate_base_register_result"))
    await Bun.sleep(50)
    await confirm.app.renderOnce()
    expect(confirm.setupComplete()).toBe(false)
    expect(confirm.app.captureCharFrame()).toContain("ready yet. Try again")
  } finally {
    confirm.cleanup()
  }
})

test.serial("rate-limited registration stays recoverable and reports a typed outcome", async () => {
  const message = "Too many Altimate Base registrations from this network right now. Try again later."
  const confirm = await mountConfirm({
    registration: { ok: false, result: "rate_limited", message },
  })
  try {
    confirm.app.mockInput.pressKey("y")
    await waitUntil(() => confirm.events.some((event) => event.name === "altimate_base_register_result"))
    await confirm.app.renderOnce()
    expect(confirm.setupComplete()).toBe(false)
    expect(confirm.registrations()).toHaveLength(1)
    expect(confirm.events).toContainEqual({ name: "altimate_base_register_result", result: "rate_limited" })
    expect(confirm.app.captureCharFrame()).toContain("Too many Altimate Base")
  } finally {
    confirm.cleanup()
  }
})

test.serial("dismissal keys and backdrop clicks are ignored while registration is in flight", async () => {
  let finish!: (result: { ok: true }) => void
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<{ ok: true }>((resolve) => {
    finish = resolve
  })
  const confirm = await mountConfirm({
    registration: async () => {
      started()
      return pending
    },
  })
  try {
    confirm.app.mockInput.pressKey("y")
    await began
    expect(confirm.replaceDialog()).toBe(false)
    await confirm.app.renderOnce()
    expect(confirm.app.captureCharFrame()).not.toContain("Session list replacement")
    confirm.app.mockInput.pressKey("escape")
    await confirm.app.renderOnce()
    expect(confirm.app.captureCharFrame()).toContain("Setting up…")
    confirm.app.mockInput.pressKey("c", { ctrl: true })
    await confirm.app.renderOnce()
    expect(confirm.app.captureCharFrame()).toContain("Setting up…")
    await confirm.app.mockMouse.click(0, 0)
    await confirm.app.renderOnce()
    expect(confirm.app.captureCharFrame()).toContain("Setting up…")

    finish({ ok: true })
    await waitUntil(() => confirm.setupComplete())
  } finally {
    confirm.cleanup()
  }
})

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
  {
    firstRun = true,
    registerOutcomes = [] as Array<"ok" | "error">,
    subscriptions = [] as Array<string | { subscription: string; source: string }>,
    subscriptionsDelayMs = 0,
  }: {
    firstRun?: boolean
    registerOutcomes?: Array<"ok" | "error">
    subscriptions?: Array<string | { subscription: string; source: string }>
    subscriptionsDelayMs?: number
  } = {},
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
    // altimate_change — subscription logins the server reports as already on this machine
    if (url.pathname === "/altimate/provider/subscriptions") {
      if (subscriptionsDelayMs)
        return Bun.sleep(subscriptionsDelayMs).then(() =>
          Response.json({ ok: true, found: subscriptions.map((item) => (typeof item === "string" ? { subscription: item, source: "altimate" } : item)) }),
        )
      return Response.json({ ok: true, found: subscriptions.map((item) => (typeof item === "string" ? { subscription: item, source: "altimate" } : item)) })
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
test("Altimate Base is offered only under Search all providers, not on the welcome list", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "altimate-free"])
  try {
    await wait(() => picker.events.length > 0)
    await picker.app.renderOnce()
    const frame = picker.app.captureCharFrame()
    expect(frame).toContain("Search all providers")
    expect(frame).not.toContain("Altimate Base")
  } finally {
    await picker.cleanup()
  }
})
// altimate_change end

test("rows for providers the server filtered out are not shown, so the first row always works", async () => {
  // The server filters providers via enabled_providers/disabled_providers. A row for a filtered-out
  // provider used to render and do nothing on Enter; such rows are now left out.
  const picker = await mountPicker("first_run", ["anthropic"])
  try {
    await wait(() => picker.events.length > 0)
    await picker.app.renderOnce()
    expect(picker.app.captureCharFrame()).not.toContain("Altimate LLM Gateway")
    picker.app.mockInput.pressEnter()
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))
    expect(picker.events.filter((e) => e.name === "provider_selected")[0]).toMatchObject({ providerID: "anthropic" })
  } finally {
    await picker.cleanup()
  }
})

test("the Claude subscription row appears when the server lists Claude Agent, and records its provider", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent"])
  try {
    await wait(() => picker.events.length > 0)
    // Rows: gateway, Claude subscription, … — one Down press lands on it.
    picker.app.mockInput.pressKey("ARROW_DOWN")
    picker.app.mockInput.pressEnter()
    await wait(() => picker.events.some((e) => e.name === "provider_selected"))
    expect(picker.events.filter((e) => e.name === "provider_selected")[0]).toMatchObject({
      providerID: "claude-agent",
    })
  } finally {
    await picker.cleanup()
  }
})

const suggested = (frame: string) =>
  [
    "Altimate LLM Gateway",
    "Claude subscription",
    "ChatGPT subscription",
    "GitHub Copilot",
    "Grok subscription",
    "GitLab Duo",
    "Anthropic (Claude)",
    "OpenAI (GPT)",
    "Google (Gemini)",
  ]
    .map((name) => ({ name, at: frame.indexOf(name) }))
    .filter((row) => row.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((row) => row.name)

test("with nothing found, the list is the gateway, both subscriptions and two API-key rows", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent"])
  try {
    await wait(() => picker.events.length > 0)
    await picker.app.renderOnce()
    expect(suggested(picker.app.captureCharFrame())).toEqual([
      "Altimate LLM Gateway",
      "Claude subscription",
      "ChatGPT subscription",
      "Anthropic (Claude)",
      "OpenAI (GPT)",
    ])
  } finally {
    await picker.cleanup()
  }
})

test("subscriptions found on this machine come first, marked, and the list stays at five", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent", "github-copilot", "xai"], {
    subscriptions: ["copilot", "supergrok", "claude"],
  })
  try {
    await wait(() => picker.events.length > 0)
    await Bun.sleep(50)
    await picker.app.renderOnce()
    const frame = picker.app.captureCharFrame()
    expect(suggested(frame)).toEqual([
      "Altimate LLM Gateway",
      "Claude subscription",
      "GitHub Copilot",
      "Grok subscription",
      "ChatGPT subscription",
    ])
    expect(frame).toContain("Copilot plan · found on this machine")
    expect(frame).toContain("Search all providers")
  } finally {
    await picker.cleanup()
  }
})

test("a found subscription whose provider the server does not list is left out", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent"], { subscriptions: ["copilot"] })
  try {
    await wait(() => picker.events.length > 0)
    await Bun.sleep(50)
    await picker.app.renderOnce()
    expect(suggested(picker.app.captureCharFrame())).not.toContain("GitHub Copilot")
  } finally {
    await picker.cleanup()
  }
})

test("slow detection holds the suggested rows, then shows the defaults without reordering later", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent"], {
    subscriptions: ["chatgpt"],
    subscriptionsDelayMs: 2_000,
  })
  try {
    await wait(() => picker.events.length > 0)
    await picker.app.renderOnce()
    const early = picker.app.captureCharFrame()
    expect(early).toContain("Checking for subscriptions")
    expect(suggested(early)).toEqual([])
    // Arrows are ignored while the rows are hidden, and an Enter waits for them.
    picker.app.mockInput.pressArrow("down")
    picker.app.mockInput.pressEnter()
    await Bun.sleep(100)
    expect(picker.events.some((event) => event.name === "provider_selected")).toBe(false)
    await wait(() => picker.events.some((event) => event.name === "provider_selected"))
    await picker.app.renderOnce()
    const settled = picker.app.captureCharFrame()
    expect(settled).not.toContain("Checking for subscriptions")
    expect(settled).not.toContain("found on this machine")
    expect(suggested(settled)[0]).toBe("Altimate LLM Gateway")
    // The queued Enter picked the first row, not the row the ignored arrow would have moved to.
    expect(picker.events.find((event) => event.name === "provider_selected")).toMatchObject({
      providerID: "altimate-backend",
    })
    // The late response (2 s) does not reorder the rows the user already sees.
    await Bun.sleep(1_800)
    await picker.app.renderOnce()
    expect(picker.app.captureCharFrame()).not.toContain("found on this machine")
  } finally {
    await picker.cleanup()
  }
})

test("a Codex or Copilot editor login is suggested, but says the user signs in here", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent", "github-copilot"], {
    subscriptions: [
      { subscription: "chatgpt", source: "codex" },
      { subscription: "copilot", source: "copilot" },
      { subscription: "claude", source: "claude-code" },
    ],
  })
  try {
    await wait(() => picker.events.length > 0)
    await Bun.sleep(50)
    await picker.app.renderOnce()
    const frame = picker.app.captureCharFrame()
    expect(frame).toContain("Claude Pro/Max · found on this machine")
    expect(frame).toContain("ChatGPT Plus/Pro · Codex login · sign in")
    expect(frame).toContain("Copilot plan · editor login · sign in")
  } finally {
    await picker.cleanup()
  }
})

test("picking the ChatGPT subscription row records which subscription it was", async () => {
  const picker = await mountPicker("first_run", [...ALL_PROVIDER_IDS, "claude-agent"])
  try {
    await wait(() => picker.events.length > 0)
    await Bun.sleep(50)
    await picker.app.renderOnce()
    picker.app.mockInput.pressArrow("down")
    picker.app.mockInput.pressArrow("down")
    picker.app.mockInput.pressEnter()
    await wait(() => picker.events.some((event) => event.name === "provider_selected"))
    expect(picker.events.find((event) => event.name === "provider_selected")).toMatchObject({
      providerID: "openai",
      subscription: "chatgpt",
    })
  } finally {
    await picker.cleanup()
  }
})

test("the selected tick for a shared provider follows the saved login", async () => {
  const { tickRow } = await import("../../../src/component/altimate-onboarding")
  const subscription = { providerID: "openai", subscription: "chatgpt" }
  const apiKey = { providerID: "openai" }
  expect(tickRow([subscription, apiKey], "openai")).toBe(apiKey)
  const saved = { ...subscription, savedLogin: true }
  expect(tickRow([saved, apiKey], "openai")).toBe(saved)
  const claude = { providerID: "claude-agent", subscription: "claude" }
  expect(tickRow([claude, apiKey], "claude-agent")).toBe(claude)
  expect(tickRow([apiKey], "anthropic")).toBeUndefined()
})

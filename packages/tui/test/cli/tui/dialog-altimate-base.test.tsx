/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
// altimate_change — fixes #1301 (Codex review round 2, D): the harness now performs REAL
// kv/model.json writes (see `declinedInKv`/`declinedInModel` below), so it needs a per-mount
// isolated state directory — `TestTuiContexts`'s default `state` path is a single fixed
// `/tmp/opencode/state` shared by every test in the process (see `dialog-scan-gate.test.tsx` for
// the same pattern with a real DialogProvider + kv fixture).
import { tmpdir } from "../../fixture/fixture"
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
    // altimate_change start — fixes #1301: broadened migration eligibility test support
    // Whether the harness marks first-run active before mounting. Every prior test relied on this
    // always being true; migration's telemetry must now also fire when it is NOT (migration is
    // reachable on a returning launch, which is never "first run").
    markFirstRun?: boolean
    // The free public Zen model presented as the (sole, when `modelAvailable: false`) opencode
    // provider model — defaults to the retired Big Pickle id so every existing test is unaffected.
    // Swap it to prove the migration copy names whichever free model is actually current.
    zenModel?: { id: string; name: string; family?: string }
    // altimate_change end
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
    { KVProvider, useKV },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { SDKProvider },
    { AltimateBaseConsentProvider },
    { ProjectProvider },
    { SyncProvider },
    // altimate_change — fixes #1301 (Codex review round 2, D): `useLocal`/`ALTIMATE_BASE_MIGRATION_DECLINED_KEY`
    // let the harness assert the ACTUAL persisted decline state (kv + model.json) an app.tsx
    // `onDecline` would produce, instead of only whether a mock callback was invoked.
    { LocalProvider, useLocal, ALTIMATE_BASE_MIGRATION_DECLINED_KEY },
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

  // altimate_change start — fixes #1301 (Codex review round 2, D): isolated per-mount state dir
  // — see the `tmpdir` import comment above. `kv.json` is pre-seeded (matching
  // `dialog-scan-gate.test.tsx`) purely to avoid the harmless-but-noisy "Failed to read KV state"
  // console error `kv.tsx` logs on a missing file; `model.json`'s reader doesn't log at all, so
  // it isn't pre-seeded.
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  // altimate_change end

  resetSetupComplete()
  // altimate_change — fixes #1301: default preserved (every prior test relies on it), but a test
  // can now mount without first-run active to prove migration telemetry fires regardless.
  if (input.markFirstRun ?? true) markFirstRunActive()
  const events: OnboardingTelemetryEvent[] = []
  const registrations: true[] = []
  const declines: true[] = []
  let replaceDialog = () => false
  // altimate_change — fixes #1301 (Codex review round 2, D): populated inside `OpenConfirm` below
  // (rendered inside `KVProvider`/`LocalProvider`), so the harness can assert the actual
  // persisted decline state, not only whether a mock callback fired.
  let declinedInKv = () => false
  let declinedInModel = () => false
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
  // altimate_change — fixes #1301: the opencode-provider free model defaults to the retired Big
  // Pickle id (unchanged for every existing test) but can be swapped to any other free Zen model.
  const zenModel = input.zenModel ?? { id: "big-pickle", name: "Big Pickle", family: "glm" }
  const bigPickle = {
    ...model,
    id: zenModel.id,
    providerID: "opencode",
    name: zenModel.name,
    family: zenModel.family ?? "opencode",
  }
  const openCodeProvider = { id: "opencode", name: "Legacy Zen", models: { [zenModel.id]: bigPickle }, env: [] }
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
      // altimate_change start — fixes #1301 (Codex review round 2, D): mirror app.tsx's REAL
      // migration `onDecline` (kv.set + local.model.declineManagedBaseDefault()) instead of only
      // recording that the callback fired, so tests can assert the actual persisted state a real
      // launch would see — not just that a mock array grew.
      const kv = useKV()
      const local = useLocal()
      declinedInKv = () => kv.get(ALTIMATE_BASE_MIGRATION_DECLINED_KEY, false)
      declinedInModel = () => local.model.declinedManagedBaseDefault()
      replaceDialog = () => dialog.replace(() => <text>Session list replacement</text>)
      onMount(() =>
        dialog.replace(() => (
          <DialogAltimateBaseConfirm
            origin={input.origin ?? "welcome"}
            onDecline={() => {
              declines.push(true)
              kv.set(ALTIMATE_BASE_MIGRATION_DECLINED_KEY, true)
              local.model.declineManagedBaseDefault()
            }}
          />
        )),
      )
      // altimate_change end
      return null
    }

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
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
    // altimate_change — fixes #1301 (Codex review round 2, D): actual persisted decline state.
    declinedInKv: () => declinedInKv(),
    declinedInModel: () => declinedInModel(),
    replaceDialog: () => replaceDialog(),
    async cleanup() {
      app.renderer.destroy()
      resetSetupComplete()
      // altimate_change — fixes #1301 (Codex review round 2, D): `local.model`'s `save()` (and
      // `kv.tsx`'s `set()`) fire-and-forget their disk write (`void writeJsonAtomic(...)`, never
      // awaited by the caller). A decline persisted just before this runs can still have its
      // write in flight; disposing the tmp dir immediately raced the atomic-write temp file
      // against the directory removal (an EINVAL/ENOENT from `writeJsonAtomic`, surfacing as an
      // unhandled rejection misattributed to whichever test happened to be running when it
      // resolved). A short buffer lets any in-flight write actually land first.
      await Bun.sleep(20)
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test.serial("Altimate Base shows the privacy disclosure before registration and defaults to No", async () => {
  const confirm = await mountConfirm()
  try {
    const frame = confirm.app.captureCharFrame()
    const flat = frame.replace(/\s+/g, " ")
    expect(confirm.disclosure).toContain("Requests and responses may be logged and used")
    // The persistent per-install-id linkage line is intentionally not in the gate (it lives in docs).
    expect(confirm.disclosure).not.toContain("per-installation identifier")
    expect(frame).toContain("Use Altimate Base?")
    expect(flat).toContain("Requests and responses may be logged and used")
    // Both options are always visible.
    expect(frame).toContain("No — pick something else")
    expect(frame).toContain("Yes — use Altimate Base")
    // Assert WHICH option is default, not merely that the word appears. The previous version of
    // this test checked only `toContain("(default)")` and the presence of the No label, so it
    // passed both before and after the default was inverted — it asserted its own name away.
    // The cursor glyph marks the selected row, and Return runs it.
    expect(flat).toContain("› No — pick something else (default)")
    expect(flat).not.toContain("› Yes — use Altimate Base")
    expect(confirm.registrations()).toHaveLength(0)
    expect(confirm.events).toEqual([{ name: "altimate_base_confirm_shown", origin: "welcome" }])
  } finally {
    await confirm.cleanup()
  }
})

test.serial("Return declines, because No is the default — it must never register", async () => {
  const confirm = await mountConfirm()
  try {
    // NOTE: KeyInput is `string | keyof typeof KeyCodes`, so a lowercase "return" would be sent as
    // the literal characters r,e,t,u,r,n. The Enter key is the uppercase KeyCodes name — nothing
    // else in this suite exercises it, so this path was previously unverified in either direction.
    confirm.app.mockInput.pressKey("RETURN")
    await waitUntil(() => confirm.events.some((event) => event.name === "altimate_base_choice"))
    expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "cancel", origin: "welcome" })
    // The property that matters: an unread Return cannot opt the installation into request logging.
    expect(confirm.registrations()).toHaveLength(0)
  } finally {
    await confirm.cleanup()
  }
})

test.serial(
  // altimate_change — fixes #1301: migration telemetry is no longer suppressed — see the "even
  // when first-run is not active" variant below for why that matters.
  "the migration disclosure reuses consent, reports its own telemetry, and routes explicit No to the picker",
  async () => {
    const confirm = await mountConfirm({ origin: "migration" })
    try {
      const frame = confirm.app.captureCharFrame()
      expect(frame).toContain("No — pick something else")
      expect(frame.replace(/\s+/g, " ")).toContain("Requests and responses may be logged and used")
      expect(confirm.events).toEqual([{ name: "altimate_base_confirm_shown", origin: "migration" }])

      confirm.app.mockInput.pressKey("n")
      await waitUntil(() => confirm.declines().length === 1)
      expect(confirm.registrations()).toHaveLength(0)
      // altimate_change — fixes #1301 (Codex review round 2, D): assert the ACTUAL persisted
      // state (kv + model.json, both through the real `local.model.declineManagedBaseDefault()`),
      // not only that a mock callback was invoked.
      expect(confirm.declinedInKv()).toBe(true)
      expect(confirm.declinedInModel()).toBe(true)
      expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "cancel", origin: "migration" })
      // altimate_change — "No — pick something else" must actually route somewhere: Big Pickle is
      // retired, so declining the migration prompt lands the user in the curated picker instead of
      // silently leaving the dialog cleared (the label used to promise a re-pick that never
      // happened).
      await waitUntil(() => confirm.events.some((event) => event.name === "model_picker_shown"))
      expect(confirm.events).toContainEqual({ name: "model_picker_shown", trigger: "altimate_base_back" })
      await confirm.app.renderOnce()
      expect(confirm.app.captureCharFrame()).toContain("Altimate LLM Gateway")
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial(
  "migration telemetry fires even when first-run is not active, unlike welcome/model",
  async () => {
    // altimate_change — fixes #1301: migration is reachable on a returning (non-first-run)
    // launch — the whole point of the fix — so its telemetry must not depend on
    // `firstRunActive()` the way "welcome"/"model" origins' does.
    const confirm = await mountConfirm({ origin: "migration", markFirstRun: false })
    try {
      expect(confirm.events).toEqual([{ name: "altimate_base_confirm_shown", origin: "migration" }])
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial(
  "Escape on the migration disclosure persists the decline and opens the welcome picker, not a bare dismissal",
  async () => {
    // altimate_change — fixes #1301: DialogProvider's keymap binding closes the dialog BEFORE the
    // component's own `useKeyboard` ever sees Escape/Ctrl-C, so this must route through the close
    // guard — see `releaseCloseGuard` in altimate-onboarding.tsx.
    const confirm = await mountConfirm({ origin: "migration" })
    try {
      // `pressKey("escape")` (lowercase) types the literal LETTERS e-s-c-a-p-e — it is not the
      // Escape key (see `KeyCodes.ESCAPE`/`resolveKeyInput` in @opentui/core's mock-keys helper).
      // `pressEscape()` sends the actual key.
      confirm.app.mockInput.pressEscape()
      await waitUntil(() => confirm.declines().length === 1)
      expect(confirm.registrations()).toHaveLength(0)
      // altimate_change — fixes #1301 (Codex review round 2, D): the actual persisted state a
      // real launch's `Provider.defaultModel()`/ACP would read, not only the mock callback.
      expect(confirm.declinedInKv()).toBe(true)
      expect(confirm.declinedInModel()).toBe(true)
      await waitUntil(() => confirm.events.some((event) => event.name === "model_picker_shown"))
      await confirm.app.renderOnce()
      const frame = confirm.app.captureCharFrame()
      expect(frame).toContain("Select a provider")
      expect(frame).toContain("Altimate LLM Gateway")
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial(
  "the visible mouse esc label on the migration disclosure persists the decline and opens the picker, same as keyboard Escape",
  async () => {
    // altimate_change — fixes #1301 (Codex review round 2, P2): this visible label used to call a
    // bare `dialog.clear()` for every origin, including migration — so clicking it silently
    // skipped both the decline persistence AND the picker takeover that keyboard Escape produces,
    // leaving a later headless/server launch free to pick Base again after a partial
    // registration. It must now behave exactly like Escape for `origin === "migration"`.
    const confirm = await mountConfirm({ origin: "migration" })
    try {
      const frame = confirm.app.captureCharFrame()
      expect(frame).toContain("esc")
      // The "esc" label sits on the same row as the dialog title, near its right edge.
      const escRow = frame.split("\n").findIndex((line) => line.includes("Use Altimate Base?"))
      expect(escRow).toBeGreaterThanOrEqual(0)
      const escColumn = frame.split("\n")[escRow].indexOf("esc")
      await confirm.app.mockMouse.click(escColumn, escRow)
      await waitUntil(() => confirm.declines().length === 1)
      expect(confirm.registrations()).toHaveLength(0)
      expect(confirm.declinedInKv()).toBe(true)
      expect(confirm.declinedInModel()).toBe(true)
      await waitUntil(() => confirm.events.some((event) => event.name === "model_picker_shown"))
      await confirm.app.renderOnce()
      expect(confirm.app.captureCharFrame()).toContain("Select a provider")
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial(
  "a programmatic replace of the migration dialog succeeds and does not persist a decline",
  async () => {
    // altimate_change — fixes #1301 (Codex review round 2, P2): an unrelated feature (command
    // palette, session list) replacing the dialog stack while the migration disclosure is open is
    // not the user declining Altimate Base — it never dismissed THIS dialog, unlike keyboard
    // Escape/Ctrl+C, the backdrop click (`dialog.tsx`'s `dismiss()`), or the visible mouse "esc"
    // label, all of which now route through `no()` (see the tests above). Before the original
    // fix, the close guard queued `no()` for every guarded close, including this one.
    const confirm = await mountConfirm({ origin: "migration" })
    try {
      expect(confirm.replaceDialog()).toBe(true)
      await confirm.app.renderOnce()
      expect(confirm.app.captureCharFrame()).toContain("Session list replacement")
      expect(confirm.declines()).toHaveLength(0)
      // altimate_change — fixes #1301 (Codex review round 2, D): the actual persisted state,
      // which is what a real headless/server launch would read — not only the mock callback.
      expect(confirm.declinedInKv()).toBe(false)
      expect(confirm.declinedInModel()).toBe(false)
      expect(confirm.registrations()).toHaveLength(0)
      expect(confirm.events.some((event) => event.name === "model_picker_shown")).toBe(false)
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial(
  "the migration copy names the current free model instead of always naming Big Pickle",
  async () => {
    // altimate_change — fixes #1301: migration now also covers implicit free public Zen
    // defaults besides Big Pickle, so the copy must say which model is actually being moved.
    // `modelAvailable: false` makes this swapped-in model the ONLY (hence current) provider
    // entry, sidestepping any ambiguity in which provider the fallback picks first.
    const confirm = await mountConfirm({
      origin: "migration",
      modelAvailable: false,
      zenModel: { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)" },
    })
    try {
      const flat = confirm.app.captureCharFrame().replace(/\s+/g, " ")
      expect(flat).toContain(
        "Your default model, Nemotron 3.5 Lightning (Free), is a public free model. Altimate Base is the free model Altimate hosts for data work.",
      )
      expect(flat).not.toContain("Big Pickle has been retired.")
    } finally {
      await confirm.cleanup()
    }
  },
)

test.serial("declining Altimate Base makes no registration request, and Big Pickle is not offered as a new pick", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("n")
    await waitUntil(() => confirm.events.some((event) => event.name === "altimate_base_choice"))
    expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "cancel", origin: "welcome" })
    expect(confirm.registrations()).toHaveLength(0)
    confirm.app.mockInput.pressKey("/")
    await confirm.app.renderOnce()
    // altimate_change — Big Pickle is retired as a NEW selectable option: the full catalog opened
    // via search must not offer it, even though the fixture still wires up an "opencode" provider
    // (used elsewhere to prove the migration path still recognizes a legacy selection).
    expect(confirm.app.captureCharFrame()).not.toContain("Big Pickle")
    expect(confirm.registrations()).toHaveLength(0)
  } finally {
    await confirm.cleanup()
  }
})

test.serial("accepting registers once through the private host operation and completes setup", async () => {
  const confirm = await mountConfirm()
  try {
    confirm.app.mockInput.pressKey("y")
    await waitUntil(() => confirm.setupComplete())
    expect(confirm.registrations()).toHaveLength(1)
    expect(confirm.events).toContainEqual({ name: "altimate_base_choice", choice: "accept", origin: "welcome" })
    expect(confirm.events).toContainEqual({
      name: "altimate_base_register_result",
      result: "success",
      origin: "welcome",
    })
    expect(confirm.events.filter((event) => event.name === "altimate_base_choice")).toHaveLength(1)
  } finally {
    await confirm.cleanup()
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
    await confirm.cleanup()
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
    expect(confirm.events).toContainEqual({
      name: "altimate_base_register_result",
      result: "rate_limited",
      origin: "welcome",
    })
    expect(confirm.app.captureCharFrame()).toContain("Too many Altimate Base")
  } finally {
    await confirm.cleanup()
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
    // altimate_change — fixes #1301: `pressKey("escape")` (lowercase) sends the literal letters
    // e-s-c-a-p-e, not the Escape key (see the comment on the migration Escape test below); this
    // assertion happened to hold either way since typing those letters while busy is also a
    // no-op, but `pressEscape()` is what actually exercises the key this test is named for.
    confirm.app.mockInput.pressEscape()
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
    await confirm.cleanup()
  }
})

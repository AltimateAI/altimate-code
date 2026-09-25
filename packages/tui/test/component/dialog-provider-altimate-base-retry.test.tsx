/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex review finding: the Altimate Base row's one-shot activation latch
// stayed set forever after a failed selection, permanently bricking that row for the rest of the
// dialog session (the row would silently no-op on every later press). Confirms the fix: the SAME
// row can be selected again after a failure, and the register attempt actually re-fires.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 2_000) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

async function mount(registerOutcomes: Array<"ok" | "error">) {
  const [
    { createDialogProviderOptions },
    { KVProvider },
    { LocalProvider },
    { ArgsProvider },
    { ThemeProvider },
    { ToastProvider, useToast },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider },
    { RouteProvider },
    { ExitProvider },
    { TuiConfigProvider },
    { DialogProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../src/component/dialog-provider"),
    import("../../src/context/kv"),
    import("../../src/context/local"),
    import("../../src/context/args"),
    import("../../src/context/theme"),
    import("../../src/ui/toast"),
    import("../../src/context/sdk"),
    import("../../src/context/project"),
    import("../../src/context/sync"),
    import("../../src/context/route"),
    import("../../src/context/exit"),
    import("../../src/config"),
    import("../../src/ui/dialog"),
    import("../../src/keymap"),
  ])

  // altimate_change — repo rule: tests must not touch real global state. `kv.tsx`'s `kv.json`
  // file is isolated via `paths.state` below, but the `Flock.withLock` it takes while
  // reading/writing that file is keyed off `Global.Path.state` separately (see
  // context/cycle-stability.test.tsx's comment on the same isolation) — without also overriding
  // `OPENCODE_TEST_STATE_HOME`, this test's lock would still land in, and contend with, the real
  // developer/CI-shared state dir every other unisolated test defaults to.
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  process.env.OPENCODE_TEST_STATE_HOME = tmp.path

  let registerCallCount = 0
  const outcomes = [...registerOutcomes]
  const inner = createFetch((url) => {
    if (url.pathname === "/provider") {
      return json({
        all: [{ id: "altimate-free", name: "Altimate", models: {}, env: [] }],
        default: {},
        connected: [],
      })
    }
    if (url.pathname === "/altimate/base/register") {
      registerCallCount++
      const outcome = outcomes.shift() ?? "ok"
      return json(outcome === "ok" ? { ok: true } : { ok: false, result: "network", message: "offline" })
    }
    return undefined
  })
  const source = createEventSource()

  let optionsAccessor: (() => { value: string; onSelect?: () => unknown }[]) | undefined
  let toastAccessor: (() => unknown) | undefined
  function Probe() {
    optionsAccessor = createDialogProviderOptions()
    const toast = useToast()
    toastAccessor = () => toast.currentToast
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <DialogProvider>
          <Probe />
        </DialogProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => (
    <TestTuiContexts directory={directory} paths={{ home: tmp.path, state, worktree: tmp.path }}>
      <ExitProvider exit={() => {}}>
        <ArgsProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider>
                <SDKProvider url="http://test" directory={directory} fetch={inner.fetch} events={source.source}>
                  <TuiConfigProvider config={createTuiResolvedConfig()}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <Harness />
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </TuiConfigProvider>
                </SDKProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ArgsProvider>
      </ExitProvider>
    </TestTuiContexts>
  ))
  await app.renderOnce()
  // The picker's provider list depends on `sync.bootstrap()`'s fetch round-trip; unlike the
  // signals other tests in this package poll (written synchronously inside onMount/effects),
  // this one only becomes visible to a fresh read after an explicit render pump.
  await waitUntil(async () => {
    await app.renderOnce()
    return optionsAccessor !== undefined && optionsAccessor().some((option) => option.value === "altimate-free")
  })

  return {
    getBaseRow: () => optionsAccessor!().find((option) => option.value === "altimate-free")!,
    get registerCallCount() {
      return registerCallCount
    },
    get toastShown() {
      return toastAccessor?.() != null
    },
    renderOnce: () => app.renderOnce(),
    async cleanup() {
      app.renderer.destroy()
      if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
      else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("a failed Altimate Base selection can be retried", async () => {
  const picker = await mount(["error", "ok"])
  try {
    await picker.getBaseRow().onSelect?.()
    await waitUntil(() => picker.registerCallCount === 1)
    // `onSelect` fires `selectAltimateBase()` without awaiting it (so the dialog stays
    // responsive); the row's activation latch only resets once that promise chain (fetch parse +
    // failure toast) fully settles, a beat after the fetch itself resolves. Let it drain, pumping
    // the renderer so the reactive toast store's update actually flushes.
    await waitUntil(async () => {
      await picker.renderOnce()
      return picker.toastShown
    })

    // Before the fix, the row's one-shot latch stayed set after the failed attempt above, so this
    // second selection would silently no-op — registerCallCount would stay at 1 forever.
    await picker.getBaseRow().onSelect?.()
    await waitUntil(() => picker.registerCallCount === 2)

    expect(picker.registerCallCount).toBe(2)
  } finally {
    await picker.cleanup()
  }
})
// altimate_change end

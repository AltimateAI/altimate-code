/** @jsxImportSource @opentui/solid */
// altimate_change start — coverage for `useAltimateBaseDisclosureNotice()`, the non-blocking
// replacement for the old consent dialog's disclosure text: a one-line toast shown once per
// install, the first time Base becomes the active model. Mounts the real provider stack with a
// single "altimate-free" provider (so `fallbackModel()`'s implicit last-resort branch resolves to
// Base with nothing else to configure — see local.tsx), and drives the hook's own kv-persisted
// "already shown" flag exactly the way a real second launch would (a pre-seeded kv.json file), per
// the isolation pattern in context/cycle-stability.test.tsx.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ALTIMATE_BASE_DISCLOSURE } from "@opencode-ai/core/altimate-base-disclosure"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import {
  ALTIMATE_BASE_DISCLOSURE_SHOWN_KEY,
  useAltimateBaseDisclosureNotice,
} from "../../src/component/altimate-onboarding"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

const baseModel = {
  id: "altimate-base",
  providerID: "altimate-free",
  name: "Altimate Base",
  family: "altimate",
  status: "active",
  capabilities: {},
  cost: { input: 0, output: 0 },
  limit: { context: 131_072, output: 65_536 },
}
const baseProvider = { id: "altimate-free", name: "Altimate", models: { "altimate-base": baseModel }, env: [] }

async function mount(options: { preSeedShown: boolean }) {
  const [
    { KVProvider },
    { LocalProvider, useLocal },
    { ArgsProvider },
    { ThemeProvider },
    { ToastProvider, useToast },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider },
    { RouteProvider },
    { ExitProvider },
    { TuiConfigProvider },
  ] = await Promise.all([
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
  ])
  const { createEffect } = await import("solid-js")

  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  if (options.preSeedShown) {
    // Simulates a previous launch already having shown the notice — the state a real restart
    // would find on disk.
    await Bun.write(path.join(state, "kv.json"), JSON.stringify({ [ALTIMATE_BASE_DISCLOSURE_SHOWN_KEY]: true }))
  }

  const inner = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [baseProvider], default: {} })
    if (url.pathname === "/provider") return json({ all: [baseProvider], default: {}, connected: [] })
    if (url.pathname === "/agent") return json([])
    return undefined
  })
  const source = createEventSource()

  let localAccessor: ReturnType<typeof useLocal> | undefined
  let toastAccessor: ReturnType<typeof useToast> | undefined
  const shownMessages: string[] = []
  function Probe() {
    localAccessor = useLocal()
    toastAccessor = useToast()
    useAltimateBaseDisclosureNotice()
    createEffect(() => {
      const message = toastAccessor?.currentToast?.message
      if (message) shownMessages.push(message)
    })
    return null
  }

  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
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
                            <Probe />
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

  return {
    async waitForBaseActive() {
      await waitUntil(() => localAccessor?.model.ready === true)
      await waitUntil(() => localAccessor?.model.current()?.modelID === "altimate-base")
    },
    shownMessages,
    get currentToast() {
      return toastAccessor?.currentToast
    },
    async cleanup() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

/** Isolates kv.tsx's Flock lock (keyed off Global.Path.state) the same way
 *  context/cycle-stability.test.tsx does, so it never touches the real developer state dir. */
async function withIsolatedStateHome(fn: () => Promise<void>) {
  const original = process.env.OPENCODE_TEST_STATE_HOME
  const isolated = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolated.path
  try {
    await fn()
  } finally {
    if (original === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = original
    await isolated[Symbol.asyncDispose]()
  }
}

test("shows once, the first time Base becomes the active model", async () => {
  await withIsolatedStateHome(async () => {
    const mounted = await mount({ preSeedShown: false })
    try {
      await mounted.waitForBaseActive()
      await waitUntil(() => mounted.currentToast?.message === ALTIMATE_BASE_DISCLOSURE)
      expect(mounted.currentToast).toMatchObject({ variant: "info", message: ALTIMATE_BASE_DISCLOSURE })
      expect(mounted.shownMessages).toEqual([ALTIMATE_BASE_DISCLOSURE])
    } finally {
      await mounted.cleanup()
    }
  })
})

test("does not show again after a restart (kv flag already set)", async () => {
  await withIsolatedStateHome(async () => {
    const mounted = await mount({ preSeedShown: true })
    try {
      await mounted.waitForBaseActive()
      // Give the notice effect a real chance to fire before asserting its absence.
      await Bun.sleep(150)
      expect(mounted.currentToast).toBeNull()
      expect(mounted.shownMessages).toEqual([])
    } finally {
      await mounted.cleanup()
    }
  })
})
// altimate_change end

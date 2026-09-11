/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex HOLD finding 2: `cycle()` must traverse a STABLE order.
//
// Passing `{ recent: true }` to `selectModel` (round 6, cubic 3986171198/cursor 3986044810) fixed
// a real cross-surface bug (TUI vs headless/ACP default divergence after a cycle) but, on its
// own, broke `cycle()`'s OWN navigation: reordering `recent` on every pick means the very next
// press reads its "next" index off a list that just reshuffled out from under it. Codex caught
// this by actually executing it: cycling forward through [A, B, C] starting from B went
// B -> A -> B forever instead of visiting every model. The unit test previously at
// test/context/local.test.ts:317 ("cycling persists the launch default via recents order") only
// called `recentModels()` directly — it asserted the persistence half of the fix and would have
// passed on the broken code, never exercising `cycle()` itself. This file calls the REAL
// `local.model.cycle()` three times over three models and asserts the actual visited sequence.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

const MODEL_A = { providerID: "opencode", modelID: "model-a" }
const MODEL_B = { providerID: "opencode", modelID: "model-b" }
const MODEL_C = { providerID: "opencode", modelID: "model-c" }

function makeModel(id: string) {
  return {
    id,
    providerID: "opencode",
    name: id,
    family: "opencode",
    status: "active",
    capabilities: {},
    cost: { input: 0, output: 0 },
    limit: { context: 65_536, output: 4_096 },
  }
}

async function mount() {
  const [
    { KVProvider },
    { LocalProvider, useLocal },
    { ArgsProvider },
    { ThemeProvider },
    { ToastProvider },
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

  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  // Three free models, all persisted as recents in order A, B, C — this is the "order as of TUI
  // launch" `cycle()` must traverse, independent of how it self-reorders `recent` on each pick.
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: [MODEL_A, MODEL_B, MODEL_C] }))

  const openCodeProvider = {
    id: "opencode",
    name: "Legacy Zen",
    models: {
      "model-a": makeModel("model-a"),
      "model-b": makeModel("model-b"),
      "model-c": makeModel("model-c"),
    },
    env: [],
  }
  const agent = {
    name: "build",
    mode: "primary" as const,
    hidden: false,
    permission: {},
    options: {},
  }
  const inner = createFetch((url) => {
    if (url.pathname === "/instance/dispose") return json({})
    if (url.pathname === "/config/providers") return json({ providers: [openCodeProvider], default: {} })
    if (url.pathname === "/provider") return json({ all: [openCodeProvider], default: {}, connected: ["opencode"] })
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/project/proj_test/directories") return json([])
    return undefined
  })
  const source = createEventSource()

  let localAccessor: ReturnType<typeof useLocal> | undefined
  function Capture() {
    localAccessor = useLocal()
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
                            <Capture />
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
  await waitUntil(() => localAccessor !== undefined && localAccessor.model.ready)
  const local = localAccessor!

  // `fallbackModel()` resolves the launch default to `recent[0]` (model-a) with nothing else
  // configured — confirm the harness actually started where the test assumes before asserting
  // anything about `cycle()`.
  await waitUntil(() => local.model.current()?.modelID === "model-a")
  // Move to B WITHOUT touching `recent`'s order (no `recent: true`) — matches Codex's repro
  // shape: current = B, persisted recent order = [A, B, C].
  local.model.set(MODEL_B)
  await waitUntil(() => local.model.current()?.modelID === "model-b")

  return {
    local,
    async cleanup() {
      app.renderer.destroy()
      await local.model.persisted().catch(() => {})
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test.serial(
  "cycle() traverses a stable order across repeated presses — visits every model, does not bounce (Codex HOLD finding 2)",
  async () => {
    const mounted = await mount()
    try {
      const visited: string[] = []
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)

      // Starting at B, forward cycling must visit C then A (not bounce back to A immediately —
      // the bug Codex's own execution caught was B -> A -> B) and complete the traversal back to
      // B on the third press, having visited every one of the three models exactly once.
      expect(visited).toEqual(["model-c", "model-a", "model-b"])
      expect(new Set(visited).size).toBe(3)
    } finally {
      await mounted.cleanup()
    }
  },
)

test.serial("cycle() still moves the picked model to the front of persisted recent on every press", async () => {
  const mounted = await mount()
  try {
    mounted.local.model.cycle(1)
    await waitUntil(() => mounted.local.model.recent()[0]?.modelID === "model-c")
    expect(mounted.local.model.recent()[0]).toEqual({ providerID: "opencode", modelID: "model-c" })
  } finally {
    await mounted.cleanup()
  }
})
// altimate_change end

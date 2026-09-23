// A stale keyless-Zen entry at the front of `recent` is shown as Altimate Base by
// `currentModel()`. `cycle()` must resolve that entry the same way, or the repaired current model
// is missing from its order and cycling does nothing.
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

const STALE_ZEN = { providerID: "opencode", modelID: "model-a" }
const BASE = { providerID: "altimate-free", modelID: "altimate-base" }
const OWN = { providerID: "anthropic", modelID: "own-model" }

function makeModel(id: string, providerID = "opencode") {
  return {
    id,
    providerID,
    name: id,
    family: providerID,
    status: "active",
    capabilities: {},
    cost: { input: 0, output: 0 },
    limit: { context: 65_536, output: 4_096 },
  }
}

async function mount(agentModel?: { providerID: string; modelID: string }) {
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
  // The only persisted history is a stale keyless-Zen pick followed by the user's own model.
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: [STALE_ZEN, OWN] }))

  const zenProvider = {
    id: "opencode",
    name: "Zen",
    options: { apiKey: "public" },
    models: { "model-a": makeModel("model-a") },
    env: [],
  }
  const baseProvider = {
    id: "altimate-free",
    name: "Altimate Base",
    models: { "altimate-base": makeModel("altimate-base", "altimate-free") },
    env: [],
  }
  const ownProvider = {
    id: "anthropic",
    name: "Anthropic",
    models: { "own-model": makeModel("own-model", "anthropic") },
    env: [],
  }
  const providers = [zenProvider, baseProvider, ownProvider]
  const agent = {
    name: "build",
    mode: "primary" as const,
    hidden: false,
    permission: {},
    options: {},
    ...(agentModel ? { model: agentModel } : {}),
  }
  const inner = createFetch((url) => {
    if (url.pathname === "/instance/dispose") return json({})
    if (url.pathname === "/config/providers") return json({ providers, default: {} })
    if (url.pathname === "/provider")
      return json({ all: providers, default: {}, connected: ["opencode", "altimate-free", "anthropic"] })
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

  return {
    local,
    async cleanup() {
      app.renderer.destroy()
      await local.model.persisted().catch(() => {})
      await tmp[Symbol.asyncDispose]()
    },
  }
}


test("cycle() still moves off an explicitly chosen keyless-Zen model", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  // The agent's own configured model is explicit, so `currentModel()` keeps it as Zen.
  const { local, cleanup } = await mount(STALE_ZEN)
  try {
    await waitUntil(() => local.model.ready)
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    await Bun.sleep(100)
    expect(local.model.current()?.providerID).toBe(STALE_ZEN.providerID)
    local.model.cycle(1)
    await waitUntil(() => local.model.current()?.modelID === OWN.modelID)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

test("cycle() moves off a Base model that replaced a stale keyless-Zen recent", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, cleanup } = await mount()
  try {
    // A keyless-Zen pick for this agent (e.g. carried over from an older session) shows as Base.
    await waitUntil(() => local.model.ready)
    local.model.set(STALE_ZEN)
    await waitUntil(() => local.model.current()?.modelID === BASE.modelID)
    local.model.cycle(1)
    await waitUntil(() => local.model.current()?.modelID === OWN.modelID)
    local.model.cycle(1)
    // Back to Base, never onto the keyless-Zen entry the order was built from.
    await waitUntil(() => local.model.current()?.modelID === BASE.modelID)
    expect(local.model.current()?.providerID).toBe(BASE.providerID)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

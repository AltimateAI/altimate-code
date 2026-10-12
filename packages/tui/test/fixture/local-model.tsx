/** @jsxImportSource @opentui/solid */
// Mounts the real LocalProvider and SyncProvider over a mocked server with three models (a keyless
// Zen model, Altimate Base and a model of the user's own) and two primary agents, for tests of the
// TUI's model selection. `sync` and `emit` let a test feed messages through the real sync store.
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, json } from "./tui-sdk"

export async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

// Pass copies so no call can alias these shared constants.
export const STALE_ZEN = { providerID: "opencode", modelID: "model-a" }
export const BASE = { providerID: "altimate-free", modelID: "altimate-base" }
export const OWN = { providerID: "anthropic", modelID: "own-model" }

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

export async function mount(agentModel?: { providerID: string; modelID: string }) {
  const [
    { KVProvider },
    { LocalProvider, useLocal },
    { ArgsProvider },
    { ThemeProvider },
    { ToastProvider },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider, useSync },
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
    if (url.pathname === "/agent") return json([agent, { ...agent, name: "plan" }])
    if (url.pathname === "/project/proj_test/directories") return json([])
    return undefined
  })
  const source = createEventSource()

  let localAccessor: ReturnType<typeof useLocal> | undefined
  let syncAccessor: ReturnType<typeof useSync> | undefined
  function Capture() {
    localAccessor = useLocal()
    syncAccessor = useSync()
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
    sync: syncAccessor!,
    emit: source.emit,
    async cleanup() {
      app.renderer.destroy()
      await local.model.persisted().catch(() => {})
      await tmp[Symbol.asyncDispose]()
    },
  }
}

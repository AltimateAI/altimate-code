// Opening a conversation hands the model store that conversation's recorded model, an object owned
// by the sync store's message record. The model store must never write into it: a Solid store keeps
// the first object set at a path by reference and merges later sets into it, so storing the record
// itself let opening a second conversation rewrite the first one's recorded model.
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

// Always pass copies: the model store merges a newly set object into the one already there,
// so handing it these constants directly would let one call overwrite another's constant.
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


const SESSION_A = "ses_alias_a"
const SESSION_B = "ses_alias_b"

function userMessage(sessionID: string, id: string, model: { providerID: string; modelID: string }) {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${id}`,
      type: "message.updated",
      properties: {
        sessionID,
        info: { id, sessionID, role: "user", agent: "build", model: { ...model }, time: { created: 1 } },
      },
    },
  } as never
}

test("switching conversations keeps each conversation's recorded model and restores it on return", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, sync, emit, cleanup } = await mount()
  try {
    await waitUntil(() => local.model.ready)
    emit(userMessage(SESSION_A, "msg_a", OWN))
    emit(userMessage(SESSION_B, "msg_b", BASE))
    await waitUntil(() => !!sync.data.message[SESSION_A]?.[0] && !!sync.data.message[SESSION_B]?.[0])
    const recordedA = () => sync.data.message[SESSION_A]![0] as { model: { providerID: string; modelID: string } }
    const recordedB = () => sync.data.message[SESSION_B]![0] as { model: { providerID: string; modelID: string } }

    // Exactly what the prompt does on opening a conversation: restore its last user message's model.
    local.model.restoreSession(recordedA().model)   // open conversation A
    local.model.restoreSession(recordedB().model)   // open conversation B

    // Back to conversation A: the prompt restores A's recorded model again.
    local.model.restoreSession(recordedA().model)
    expect({ ...recordedA().model }).toMatchObject(OWN) // A was recorded on OWN
    expect(local.model.current()).toMatchObject(OWN)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

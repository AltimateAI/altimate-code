/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex review finding: `currentModel()` applies the stale-public-Zen ->
// registered-Base substitution to whatever `fallbackModel()` (or a persisted/agent-config pick)
// resolves to. `fallbackModel()` returns an explicit `--model`/config `model` pick VERBATIM, ahead
// of any Zen check — but `currentModel()` used to re-apply the substitution on TOP of that result
// regardless of where it came from, so an explicit `--model opencode/x` pointing at the (now
// broken) keyless public Zen tier got silently rewritten to Altimate Base instead of staying
// `opencode/x` (or surfacing as broken). This mounts the real provider tree (not just the pure
// helpers `local.test.ts` covers) so the fix is verified against `currentModel()` itself, with
// Altimate Base actually registered and available — the exact condition that used to trigger the
// wrongful substitution.
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

function makeModel(id: string, providerID: string) {
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

// The keyless public Zen provider — matches `isPublicZenProvider()`'s exact identity check
// (local.tsx): id "opencode", `options.apiKey === "public"`, no real `key`.
const ZEN_PROVIDER = {
  id: "opencode",
  name: "Legacy Zen",
  options: { apiKey: "public" },
  models: { "zen-model": makeModel("zen-model", "opencode") },
  env: [],
}

// Registered Altimate Base — present and available, the exact condition that makes
// `currentModel()`'s substitution kick in for an IMPLICIT pick.
const BASE_PROVIDER = {
  id: "altimate-free",
  name: "Altimate Base",
  models: { "altimate-base": makeModel("altimate-base", "altimate-free") },
  env: [],
}

const AGENT = {
  name: "build",
  mode: "primary" as const,
  hidden: false,
  permission: {},
  options: {},
}

async function mount(args: { model?: string }) {
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
  // No recents at all: the only way `currentModel()` could resolve anything here is through
  // `args.model` (explicit) or the implicit allowlist fallback — isolates the explicit path.
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: [] }))

  const inner = createFetch((url) => {
    if (url.pathname === "/instance/dispose") return json({})
    if (url.pathname === "/config/providers")
      return json({ providers: [ZEN_PROVIDER, BASE_PROVIDER], default: {} })
    if (url.pathname === "/provider")
      return json({ all: [ZEN_PROVIDER, BASE_PROVIDER], default: {}, connected: ["opencode", "altimate-free"] })
    if (url.pathname === "/agent") return json([AGENT])
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
        <ArgsProvider model={args.model}>
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

test("an explicit --model pointing at the public Zen tier stays put even though registered Base is available", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  const isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path

  let mounted: Awaited<ReturnType<typeof mount>> | undefined
  try {
    mounted = await mount({ model: "opencode/zen-model" })
    // The bug this guards against: this used to resolve to `{ providerID: "altimate-free",
    // modelID: "altimate-base" }` instead, even though the user explicitly asked for
    // `opencode/zen-model` via `--model`.
    await waitUntil(() => local_model_is(mounted!, "opencode", "zen-model"))
    expect(mounted!.local.model.current()).toEqual({ providerID: "opencode", modelID: "zen-model" })
  } finally {
    await mounted?.cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
    await isolatedState[Symbol.asyncDispose]()
  }
})

test("with no explicit --model, the same catalogue resolves the implicit fallback to registered Base (control)", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  const isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path

  let mounted: Awaited<ReturnType<typeof mount>> | undefined
  try {
    mounted = await mount({})
    // Confirms the harness's Base-registered/no-recents setup actually exercises the
    // substitution path when nothing explicit overrides it — i.e. that the first test above is
    // not passing merely because Base was never reachable at all.
    await waitUntil(() => local_model_is(mounted!, "altimate-free", "altimate-base"))
    expect(mounted!.local.model.current()).toEqual({ providerID: "altimate-free", modelID: "altimate-base" })
  } finally {
    await mounted?.cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
    await isolatedState[Symbol.asyncDispose]()
  }
})

function local_model_is(mounted: Awaited<ReturnType<typeof mount>>, providerID: string, modelID: string) {
  const current = mounted.local.model.current()
  return current?.providerID === providerID && current?.modelID === modelID
}
// altimate_change end

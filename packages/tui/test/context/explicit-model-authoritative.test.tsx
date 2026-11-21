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

async function mount(args: {
  providersReady?: Promise<void>
  mcpReady?: Promise<void>
  model?: string
  configModel?: string
  agentModel?: { providerID: string; modelID: string }
  recent?: { providerID: string; modelID: string }[]
}) {
  const [
    { KVProvider, useKV },
    { LocalProvider, useLocal },
    { ArgsProvider },
    { ThemeProvider },
    { ToastProvider, useToast },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider, useSync },
    { RouteProvider, useRoute },
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
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: args.recent ?? [] }))

  const inner = createFetch((url) => {
    if (url.pathname === "/instance/dispose") return json({})
    if (url.pathname === "/mcp" && args.mcpReady) return args.mcpReady.then(() => json({}))
    if (url.pathname === "/config/providers") {
      const data = { providers: [ZEN_PROVIDER, BASE_PROVIDER], default: {} }
      return args.providersReady ? args.providersReady.then(() => json(data)) : json(data)
    }
    if (url.pathname === "/provider")
      return json({ all: [ZEN_PROVIDER, BASE_PROVIDER], default: {}, connected: ["opencode", "altimate-free"] })
    if (url.pathname === "/config") return json(args.configModel === undefined ? {} : { model: args.configModel })
    if (url.pathname === "/agent") return json([{ ...AGENT, model: args.agentModel }])
    if (url.pathname === "/project/proj_test/directories") return json([])
    return undefined
  })
  const source = createEventSource()

  let routeAccessor: ReturnType<typeof useRoute> | undefined
  let syncAccessor: ReturnType<typeof useSync> | undefined
  let localAccessor: ReturnType<typeof useLocal> | undefined
  let kvAccessor: ReturnType<typeof useKV> | undefined
  let toastAccessor: ReturnType<typeof useToast> | undefined
  function Capture() {
    routeAccessor = useRoute()
    syncAccessor = useSync()
    kvAccessor = useKV()
    toastAccessor = useToast()
    localAccessor = useLocal()
    return null
  }

  const app = await testRender(() => (
    <TestTuiContexts
      directory={tmp.path}
      paths={{ home: tmp.path, state, worktree: tmp.path }}
      skipInitialLoading={args.providersReady !== undefined}
    >
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
  await waitUntil(
    () =>
      localAccessor !== undefined &&
      localAccessor.model.ready &&
      (args.providersReady !== undefined ||
        (args.mcpReady !== undefined ? syncAccessor?.status === "partial" : syncAccessor?.status === "complete")),
  )
  const local = localAccessor!

  return {
    local,
    sync: syncAccessor!,
    route: routeAccessor!,
    toast: toastAccessor!,
    async cleanup() {
      app.renderer.destroy()
      await local.model.persisted().catch(() => {})
      await kvAccessor?.flush()
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

async function withIsolatedState(run: () => Promise<void>) {
  await using state = await tmpdir()
  const prior = process.env.OPENCODE_TEST_STATE_HOME
  process.env.OPENCODE_TEST_STATE_HOME = state.path
  try {
    await run()
  } finally {
    if (prior === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = prior
  }
}

// upstream_fix start — real-provider regressions for unavailable explicit references.
for (const scenario of [
  {
    name: "CLI overrides configured agent",
    args: { model: "ollama/local", agentModel: { providerID: "opencode", modelID: "zen-model" } },
    expected: { providerID: "ollama", modelID: "local" },
  },
  {
    name: "CLI missing provider",
    args: { model: "ollama/local" },
    expected: { providerID: "ollama", modelID: "local" },
  },
  {
    name: "CLI missing model",
    args: { model: "opencode/missing" },
    expected: { providerID: "opencode", modelID: "missing" },
  },
  { name: "empty CLI", args: { model: "" }, expected: { providerID: "", modelID: "" } },
  { name: "empty config", args: { configModel: "" }, expected: { providerID: "", modelID: "" } },
  { name: "malformed CLI", args: { model: "local" }, expected: { providerID: "local", modelID: "" } },
  {
    name: "config missing provider",
    args: { configModel: "ollama/local" },
    expected: { providerID: "ollama", modelID: "local" },
  },
  {
    name: "config missing model",
    args: { configModel: "opencode/missing" },
    expected: { providerID: "opencode", modelID: "missing" },
  },
  {
    name: "agent missing provider",
    args: { agentModel: { providerID: "ollama", modelID: "local" } },
    expected: { providerID: "ollama", modelID: "local" },
  },
  {
    name: "agent missing model",
    args: { agentModel: { providerID: "opencode", modelID: "missing" } },
    expected: { providerID: "opencode", modelID: "missing" },
  },
  {
    name: "CLI overrides valid config",
    args: { model: "ollama/local", configModel: "opencode/zen-model" },
    expected: { providerID: "ollama", modelID: "local" },
  },
]) {
  test(`unavailable explicit ${scenario.name} cannot silently select registered cloud Base`, () =>
    withIsolatedState(async () => {
      const mounted = await mount(scenario.args)
      try {
        await waitUntil(() => local_model_is(mounted, scenario.expected.providerID, scenario.expected.modelID))
        expect(mounted.local.model.current()).toEqual(scenario.expected)
        expect(mounted.local.model.validate()).toBe(false)
        await waitUntil(() => mounted.toast.currentToast?.variant === "error")
        expect(mounted.toast.currentToast?.message).toContain(
          scenario.expected.providerID || scenario.expected.modelID
            ? `${scenario.expected.providerID}/${scenario.expected.modelID}`
            : "Empty model value",
        )
        expect(mounted.toast.currentToast?.message).toContain("/models")
        expect(mounted.toast.currentToast?.message).toContain("~/.config/altimate-code/")
        if (!scenario.expected.providerID && !scenario.expected.modelID)
          expect(mounted.toast.currentToast?.message).toContain("check that the variable is set")
        mounted.local.model.set({ providerID: "altimate-free", modelID: "altimate-base" })
        expect(mounted.local.model.validate()).toBe(true)
        expect(mounted.local.model.current()).toEqual({ providerID: "altimate-free", modelID: "altimate-base" })
      } finally {
        await mounted.cleanup()
      }
    }))
}

test("stale implicit recent model still falls back to registered Base", () =>
  withIsolatedState(async () => {
    const mounted = await mount({ recent: [{ providerID: "ollama", modelID: "removed" }] })
    try {
      await waitUntil(() => local_model_is(mounted, "altimate-free", "altimate-base"))
      expect(mounted.local.model.current()).toEqual({ providerID: "altimate-free", modelID: "altimate-base" })
    } finally {
      await mounted.cleanup()
    }
  }))
// upstream_fix end

for (const configModel of ["ollama/missing", "opencode/zen-model"]) {
  test(`restored session outranks global default ${configModel}`, () =>
    withIsolatedState(async () => {
      const mounted = await mount({ configModel })
      try {
        mounted.local.model.restoreSession({ providerID: "altimate-free", modelID: "altimate-base" })
        expect(mounted.local.model.current()).toEqual({ providerID: "altimate-free", modelID: "altimate-base" })
        expect(mounted.local.model.validate()).toBe(true)
      } finally {
        await mounted.cleanup()
      }
    }))
}

test("unavailable restored session stays selected instead of falling back", () =>
  withIsolatedState(async () => {
    const mounted = await mount({})
    try {
      mounted.local.model.restoreSession({ providerID: "ollama", modelID: "missing" })
      expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
      expect(mounted.local.model.validate()).toBe(false)
    } finally {
      await mounted.cleanup()
    }
  }))

test("provider refresh stays quiet and a new invalid submission reports the error again", () =>
  withIsolatedState(async () => {
    const mounted = await mount({ model: "ollama/missing" })
    try {
      await waitUntil(() => mounted.toast.currentToast?.variant === "error")
      mounted.toast.show({ variant: "info", message: "Another notification" })
      await mounted.sync.bootstrap()
      expect(mounted.toast.currentToast?.message).toBe("Another notification")
      expect(mounted.local.model.validate()).toBe(false)
      expect(mounted.toast.currentToast?.message).toContain("ollama/missing")
      mounted.local.model.set({ providerID: "altimate-free", modelID: "altimate-base" })
      expect(mounted.local.model.validate()).toBe(true)
      expect(mounted.local.model.validate({ providerID: "ollama", modelID: "missing" })).toBe(false)
      expect(mounted.toast.currentToast?.variant).toBe("error")
    } finally {
      await mounted.cleanup()
    }
  }))

test("incomplete bootstrap defers validation without an unavailable-model toast", () =>
  withIsolatedState(async () => {
    const ready = Promise.withResolvers<void>()
    const mounted = await mount({ model: "opencode/zen-model", providersReady: ready.promise })
    try {
      expect(mounted.sync.status).not.toBe("complete")
      expect(mounted.local.model.validate()).toBe(false)
      expect(mounted.toast.currentToast).toBeNull()
      ready.resolve()
      await waitUntil(() => mounted.sync.status === "complete")
      expect(mounted.local.model.validate()).toBe(true)
      expect(mounted.toast.currentToast).toBeNull()
    } finally {
      ready.resolve()
      await mounted.cleanup()
    }
  }))

test("validates loaded models without waiting for ancillary MCP bootstrap", () =>
  withIsolatedState(async () => {
    const mcp = Promise.withResolvers<void>()
    const mounted = await mount({ model: "opencode/zen-model", mcpReady: mcp.promise })
    try {
      expect(mounted.sync.status).toBe("partial")
      expect(mounted.local.model.validate()).toBe(true)
    } finally {
      mcp.resolve()
      await mounted.cleanup()
    }
  }))

for (const args of [
  { model: "ollama/missing" },
  { model: "opencode/zen-model" },
  { agentModel: { providerID: "ollama", modelID: "missing" } },
  { agentModel: { providerID: "opencode", modelID: "zen-model" } },
]) {
  test(`session restoration respects explicit CLI or agent override ${JSON.stringify(args)}`, () =>
    withIsolatedState(async () => {
      const mounted = await mount(args)
      try {
        const requested = mounted.local.model.current()
        mounted.local.model.restoreSession({ providerID: "altimate-free", modelID: "altimate-base" })
        expect(mounted.local.model.current()).toEqual(requested)
      } finally {
        await mounted.cleanup()
      }
    }))
}

test("restored history cannot override project model after leaving the session", () => withIsolatedState(async () => {
  const mounted = await mount({ configModel: "ollama/missing" })
  try {
    mounted.route.navigate({ type: "session", sessionID: "ses_restored" })
    mounted.local.model.restoreSession({ providerID: "altimate-free", modelID: "altimate-base" })
    expect(mounted.local.model.current()).toEqual({ providerID: "altimate-free", modelID: "altimate-base" })
    mounted.route.navigate({ type: "home" })
    expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
  } finally { await mounted.cleanup() }
}))

test("picker recovery follows a new session but does not overwrite a different resumed conversation", () => withIsolatedState(async () => {
  const mounted = await mount({ model: "ollama/missing" })
  try {
    const base = { providerID: "altimate-free", modelID: "altimate-base" }
    mounted.local.model.set(base)
    mounted.local.model.adoptSession("ses_new")
    mounted.route.navigate({ type: "session", sessionID: "ses_new" })
    mounted.local.model.restoreSession(base)
    expect(mounted.local.model.current()).toEqual(base)
    mounted.route.navigate({ type: "session", sessionID: "ses_other" })
    mounted.local.model.restoreSession({ providerID: "opencode", modelID: "zen-model" })
    expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
  } finally { await mounted.cleanup() }
}))

test("restoring the same model leaves a CLI override's variant selected", () => withIsolatedState(async () => {
  const mounted = await mount({ model: "opencode/zen-model" })
  try {
    mounted.local.model.variant.set("saved-effort")
    expect(mounted.local.model.restoreSession({ providerID: "opencode", modelID: "zen-model" })).toBeUndefined()
    expect(mounted.local.model.variant.selected()).toBe("saved-effort")
  } finally { await mounted.cleanup() }
}))

test("picker recovery transfers to a new metadata-only session without a chat row", () => withIsolatedState(async () => {
  const mounted = await mount({ model: "ollama/missing" })
  try {
    const base = { providerID: "altimate-free", modelID: "altimate-base" }
    mounted.local.model.set(base)
    mounted.local.model.adoptSession("ses_shell")
    mounted.route.navigate({ type: "session", sessionID: "ses_shell" })
    expect(mounted.local.model.current()).toEqual(base)
    mounted.route.navigate({ type: "session", sessionID: "ses_unrelated" })
    expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
  } finally { await mounted.cleanup() }
}))

test("an unrelated session with the same recorded model does not inherit a picker override", () => withIsolatedState(async () => {
  const mounted = await mount({ model: "ollama/missing" })
  try {
    const base = { providerID: "altimate-free", modelID: "altimate-base" }
    mounted.local.model.set(base)
    mounted.route.navigate({ type: "session", sessionID: "ses_unrelated" })
    expect(mounted.local.model.restoreSession(base)).toBeUndefined()
    expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
  } finally { await mounted.cleanup() }
}))

test("a standalone command's recorded model cannot replace the picker recovery for its session", () =>
  withIsolatedState(async () => {
    const mounted = await mount({ model: "ollama/missing" })
    try {
      const chosen = { providerID: "opencode", modelID: "zen-model" }
      const command = { providerID: "altimate-free", modelID: "altimate-base" }
      expect(mounted.local.model.validate(command)).toBe(true)
      mounted.local.model.set(chosen)
      mounted.local.model.adoptSession("ses_command")
      mounted.route.navigate({ type: "session", sessionID: "ses_command" })
      expect(mounted.local.model.restoreSession(command)).toBeUndefined()
      expect(mounted.local.model.current()).toEqual(chosen)
    } finally {
      await mounted.cleanup()
    }
  }))

test("picking a model in another conversation preserves both choices for the same agent", () =>
  withIsolatedState(async () => {
    const mounted = await mount({ model: "ollama/missing" })
    try {
      const first = { providerID: "altimate-free", modelID: "altimate-base" }
      const second = { providerID: "opencode", modelID: "zen-model" }
      mounted.route.navigate({ type: "session", sessionID: "ses_first" })
      mounted.local.model.set(first)
      mounted.route.navigate({ type: "session", sessionID: "ses_second" })
      mounted.local.model.set(second)
      expect(mounted.local.model.current()).toEqual(second)
      mounted.route.navigate({ type: "session", sessionID: "ses_first" })
      mounted.local.model.restoreSession(first)
      expect(mounted.local.model.current()).toEqual(first)
      mounted.route.navigate({ type: "session", sessionID: "ses_second" })
      expect(mounted.local.model.current()).toEqual(second)
    } finally {
      await mounted.cleanup()
    }
  }))


test("a home picker correction moves to its new session without changing later home drafts", () =>
  withIsolatedState(async () => {
    const mounted = await mount({ model: "ollama/missing" })
    try {
      const chosen = { providerID: "altimate-free", modelID: "altimate-base" }
      mounted.local.model.set(chosen)
      mounted.local.model.adoptSession("ses_chosen")
      mounted.route.navigate({ type: "session", sessionID: "ses_chosen" })
      expect(mounted.local.model.current()).toEqual(chosen)
      mounted.route.navigate({ type: "home" })
      expect(mounted.local.model.current()).toEqual({ providerID: "ollama", modelID: "missing" })
    } finally {
      await mounted.cleanup()
    }
  }))

test("the same picked model retains independent effort in each conversation", () =>
  withIsolatedState(async () => {
    const mounted = await mount({})
    try {
      const base = { providerID: "altimate-free", modelID: "altimate-base" }
      mounted.route.navigate({ type: "session", sessionID: "ses_low" })
      mounted.local.model.set(base)
      expect(mounted.local.model.restoreSession(base)).toEqual(base)
      mounted.local.model.variant.restore("low")
      expect(mounted.local.model.variant.selected()).toBe("low")
      mounted.local.model.variant.set("low")

      mounted.route.navigate({ type: "session", sessionID: "ses_high" })
      mounted.local.model.set(base)
      mounted.local.model.variant.set("high")
      expect(mounted.local.model.variant.selected()).toBe("high")

      mounted.route.navigate({ type: "session", sessionID: "ses_low" })
      expect(mounted.local.model.restoreSession(base)).toBeUndefined()
      expect(mounted.local.model.variant.selected()).toBe("low")
    } finally {
      await mounted.cleanup()
    }
  }))

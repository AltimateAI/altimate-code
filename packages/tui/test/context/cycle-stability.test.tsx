/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex HOLD finding 2 (+ re-review rounds 8-9): `cycle()` must traverse a
// STABLE order, and that order must stay correct as `recent` changes for reasons OTHER than
// cycle() itself.
//
// Passing `{ recent: true }` to `selectModel` (round 6, cubic 3986171198/cursor 3986044810) fixed
// a real cross-surface bug (TUI vs headless/ACP default divergence after a cycle) but, on its
// own, broke `cycle()`'s OWN navigation: reordering `recent` on every pick means the very next
// press reads its "next" index off a list that just reshuffled out from under it. Codex caught
// this by actually executing it: cycling forward through [A, B, C] starting from B went
// B -> A -> B forever instead of visiting every model. The unit test previously at
// test/context/local.test.ts:317 ("cycling persists the launch default via recents order") only
// called `recentModels()` directly — it asserted the persistence half of the fix and would have
// passed on the broken code, never exercising `cycle()` itself.
//
// Round 7's fix (a `cycleOrder` snapshot, re-captured only when the CURRENT model fell out of
// it) still went stale after a PICKER selection that reordered `recent` without also knocking
// the current model out of the old snapshot — Codex's re-review reproduced it: `[A, B, C]`,
// cycle once, then pick D and A via the picker, and D stays permanently unreachable by cycling
// (the round-7 check never re-fires because A is still present in the stale snapshot). The
// `cycleOrderVersion` counter (local.tsx) fixes this.
//
// Round 9 (cubic 3987174885, repo rule: no order-dependent tests): this file used to spread the
// scenario across three `test.serial` blocks sharing one `beforeAll`/`afterAll` mount — cycle()
// is inherently a sequence of interactions, so splitting the scenario into separately-named
// blocks made each one implicitly depend on the ones before it, which broke a `-t` filter or
// `--only-failures` run of just one of them. Folded into ONE `test()`, with the mount local to
// it and labelled phases (a `phase()` helper below just for readable failure messages — plain
// comments would work too, but this makes an assertion failure show exactly which stage of the
// sequence it happened in). A second/third independent heavy provider-tree mount in this same
// file was ALSO found to reproducibly hang during its own bootstrap (a resource-contention issue
// unrelated to anything under test) — folding into one test with one mount sidesteps that too.
//
// Round 9 (cubic 3986917361, repo rule: tests must not touch real global state): `kv.tsx`'s
// `Flock.withLock` lock directory is derived from `Global.Path.state` (packages/core/src/global.ts),
// which used to have no test-isolation override at all — only `Global.Path.home` did. This test's
// `kv.json` FILE itself was always correctly isolated (`paths.state`, via `TestTuiContexts`), but
// the LOCK it takes while reading/writing that file was not — it could still land in the real,
// current developer's global state directory. Setting `OPENCODE_TEST_STATE_HOME` (mirroring
// `OPENCODE_TEST_HOME`'s established pattern, used throughout this codebase's tests) around the
// mount redirects both `Global.Path.state` and `Flock`'s lock root to this test's own throwaway
// temp dir instead.
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
const MODEL_D = { providerID: "opencode", modelID: "model-d" }

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
  // A fourth (D) is registered with the provider but NOT in the initial `recent` — it only
  // enters via a later picker selection, in the round-8 regression phase below.
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: [MODEL_A, MODEL_B, MODEL_C] }))

  const openCodeProvider = {
    id: "opencode",
    name: "Legacy Zen",
    models: {
      "model-a": makeModel("model-a"),
      "model-b": makeModel("model-b"),
      "model-c": makeModel("model-c"),
      "model-d": makeModel("model-d"),
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

/** Labels a phase for a clearer assertion-failure message; otherwise a no-op. */
function phase(name: string, fn: () => void | Promise<void>) {
  try {
    return fn()
  } catch (err) {
    throw err instanceof Error ? new Error(`[phase: ${name}] ${err.message}`, { cause: err }) : err
  }
}

test("cycle() traverses a stable order, re-discovers picker-added entries after recents reorder, and persists picks to the front of recent (Codex HOLD finding 2 + re-review rounds 8-9)", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  const isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path

  const mounted = await mount()
  try {
    // Phase 1 (Codex HOLD finding 2): starting state (from `mount()`) is current = B,
    // recent = [A, B, C]. Forward cycling must visit C then A (not bounce back to A immediately
    // — the bug Codex's own execution caught was B -> A -> B) and complete the traversal back to
    // B on the third press, having visited every one of the three models exactly once.
    // Ends: current = B, recent = [B, A, C].
    await phase("1: stable traversal order", async () => {
      const visited: string[] = []
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visited.push(mounted.local.model.current()!.modelID)

      expect(visited).toEqual(["model-c", "model-a", "model-b"])
      expect(new Set(visited).size).toBe(3)
    })

    // Phase 2: continues from phase 1 (current = B, recent = [B, A, C], cycleOrder still
    // [A, B, C] — unchanged, nothing but cycle() itself has written to `recent` so far). Every
    // cycle() pick must still move the picked model to the front of PERSISTED `recent` — that's
    // the only state headless/ACP default resolution reads.
    // Ends: current = C, recent = [C, B, A].
    await phase("2: picks move to the front of persisted recent", async () => {
      mounted.local.model.cycle(1)
      await waitUntil(() => mounted.local.model.recent()[0]?.modelID === "model-c")
      expect(mounted.local.model.recent()[0]).toEqual({ providerID: "opencode", modelID: "model-c" })
    })

    // Phase 3 (Codex re-review round 8): continues from phase 2 (current = C,
    // recent = [C, B, A], cycleOrder still [A, B, C] — still unchanged). Reproduces Codex's exact
    // repro from here: pick D and A via the PICKER (an explicit /model selection with
    // `recent: true`, like DialogModel uses). Round 7's fix only re-captured `cycleOrder` when
    // the CURRENT model fell OUT of the stale snapshot — A stays present in the stale
    // `[A, B, C]` snapshot throughout, so that check never fires, and D — never in that snapshot
    // at all — stays permanently unreachable by cycling. `cycleOrderVersion` (its declaration in
    // local.tsx) fixes this: it also invalidates on ANY external write to `recent`, picker
    // included.
    await phase("3: picker selections reorder recent", async () => {
      mounted.local.model.set(MODEL_D, { recent: true })
      await waitUntil(() => mounted.local.model.current()?.modelID === "model-d")
      mounted.local.model.set(MODEL_A, { recent: true })
      await waitUntil(() => mounted.local.model.current()?.modelID === "model-a")
      expect(mounted.local.model.recent().map((m) => m.modelID)).toEqual([
        "model-a",
        "model-d",
        "model-c",
        "model-b",
      ])
    })

    // Phase 4: cycleOrder must re-capture from the CURRENT [A, D, C, B] here (recentsVersion
    // moved past cycleOrderVersion since the last cycle() call, from phase 3's two picker picks)
    // — forward from A lands on D. The OLD bug: the stale `[A, B, C]` snapshot's "next after A"
    // was B, and D was never reachable from it at all.
    await phase("4: cycle() re-discovers the picker-added model", async () => {
      mounted.local.model.cycle(1)
      await waitUntil(() => mounted.local.model.current()?.modelID === "model-d")
    })

    // Phase 5: the newly re-captured order stays stable for subsequent presses, same guarantee
    // as phase 1 — visits C then B then wraps back to A.
    await phase("5: the re-captured order stays stable", async () => {
      const visitedAfterD: string[] = []
      mounted.local.model.cycle(1)
      visitedAfterD.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visitedAfterD.push(mounted.local.model.current()!.modelID)
      mounted.local.model.cycle(1)
      visitedAfterD.push(mounted.local.model.current()!.modelID)
      expect(visitedAfterD).toEqual(["model-c", "model-b", "model-a"])
    })
  } finally {
    await mounted.cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
    await isolatedState[Symbol.asyncDispose]()
  }
})
// altimate_change end

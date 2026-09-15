/** @jsxImportSource @opentui/solid */
// altimate_change start — Codex review rounds 2 and 4: `hadHistoryAtStartup()` has no latency
// bound or ordering guarantee against `append()` — a prompt submitted before the startup read
// settles (`routes/home.tsx` can auto-submit without waiting for history; the prompt saves drafts
// with no readiness gate either) could otherwise write an entry that the SAME read then picks up,
// making a genuinely fresh launch look like a returning one (round 2's finding), OR corrupt the
// COUNT-based fix that round introduced — subtracting how many appends raced the read is unsound
// because an early append's write can land on disk either before or after the read resolves,
// with no bound either way (round 4's finding: one pre-existing entry + one early append whose
// write lands late reads as `lines.length === 1`, and subtracting 1 wrongly gives `0`). Fixed by
// construction instead: `append()` defers its FILE write (never the in-memory store update) while
// `!loaded()`, so nothing from this launch can reach the read's `lines` at all; `onMount`'s
// `finally` flushes the merged `store.history` in one write once the snapshot is captured. These
// first tests cover both completion orders — a genuinely fresh launch, and a returning one — and
// assert the deferred write actually lands on disk once `loaded()` settles.
//
// altimate_change — Codex HOLD finding 3 (round 7): the two tests that used to live here for the
// round-6 flush/append races ("an append that lands before loaded() flips…" and "…while the
// startup flush is still in flight…") did not actually establish either race — POLLING
// `loaded()` via `Bun.sleep(5)` does not keep the startup write in flight; by the time the poll
// observes `loaded() === true`, the flush's tiny write has very likely already completed on real
// disk. Codex proved this by executing them: both passed even against 0370cfa's dropped-append
// bug (`await` before `setLoaded(true)`), which they were supposed to guard against. Replaced
// below with three tests built on CONTROLLABLE barriers — `spyOn(persistence, "readText"/"writeText")`
// returning a manually-resolved deferred promise — so each scenario is reproduced by
// construction, not by timing luck: (a) append while the startup READ is still pending, (b)
// append while the startup REWRITE's write is still in flight, (c) append SYNCHRONOUSLY in the
// same reactive tick `loaded()` flips (the specific shape that reproduces the lazy-snapshot
// duplicate bug — see that test's own comment for why timing this precisely matters). All three
// were confirmed to FAIL against the relevant old behavior and PASS on HEAD before being kept;
// see this session's report for the exact failure output.
import { testRender } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect } from "solid-js"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"
import * as persistence from "../../src/util/persistence"
import { PromptHistoryProvider, usePromptHistory, parsePromptHistory } from "../../src/prompt/history"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function mountWithRacingAppend(existing?: string) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const historyPath = path.join(state, "prompt-history.jsonl")
  if (existing !== undefined) await Bun.write(historyPath, existing)

  let history: ReturnType<typeof usePromptHistory> | undefined
  let appended = false

  function Capture() {
    history = usePromptHistory()
    // Called synchronously during the SAME initial render pass that mounts
    // `PromptHistoryProvider` — necessarily before its `onMount`'s `await readText(...)` (real
    // disk I/O) can possibly have resolved, reproducing the race deterministically rather than by
    // timing luck.
    history!.append({ input: "first prompt of this launch", parts: [] })
    appended = true
    return null
  }

  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Capture />
      </PromptHistoryProvider>
    </TestTuiContexts>
  ))
  await app.renderOnce()
  expect(appended).toBe(true)
  return {
    historyPath,
    history: history!,
    async cleanup() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test.serial(
  "a prompt appended before the startup read settles does not count as pre-existing history (no prior history)",
  async () => {
    const mounted = await mountWithRacingAppend()
    try {
      await waitUntil(() => mounted.history.loaded())
      // The append's own write eventually lands (it's in `history()`), but it must not be
      // mistaken for history that existed BEFORE this launch.
      expect(mounted.history.hadHistoryAtStartup()).toBe(false)
      // The deferred write actually reaches disk once it settles — this is the fix: the write
      // was deferred, not dropped. `loaded()` alone does not guarantee the write already landed
      // (it's fire-and-forget), so this awaits `flushed()` rather than reading immediately.
      await mounted.history.flushed()
      const onDisk = parsePromptHistory(await Bun.file(mounted.historyPath).text())
      expect(onDisk).toEqual([{ input: "first prompt of this launch", parts: [] }])
    } finally {
      await mounted.cleanup()
    }
  },
)

test.serial(
  "a prompt appended before the startup read settles does not hide real pre-existing history",
  async () => {
    // Codex review round 4: the count-subtraction fix this replaces could turn THIS case into a
    // false negative — one pre-existing entry plus one early append whose write happened to land
    // before the read resolves reads as `lines.length === 1`, and subtracting the appended count
    // (1) wrongly gave `0`, misclassifying a genuine returning user as fresh.
    const existing = JSON.stringify({ input: "from a previous launch", parts: [] }) + "\n"
    const mounted = await mountWithRacingAppend(existing)
    try {
      await waitUntil(() => mounted.history.loaded())
      expect(mounted.history.hadHistoryAtStartup()).toBe(true)
      // Both the pre-existing entry and the deferred append are on disk once the flush settles.
      await mounted.history.flushed()
      const onDisk = parsePromptHistory(await Bun.file(mounted.historyPath).text())
      expect(onDisk).toEqual([
        { input: "from a previous launch", parts: [] },
        { input: "first prompt of this launch", parts: [] },
      ])
    } finally {
      await mounted.cleanup()
    }
  },
)

test.serial("real pre-existing history is still recognized when nothing races ahead of the read", async () => {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(
    path.join(state, "prompt-history.jsonl"),
    JSON.stringify({ input: "from a previous launch", parts: [] }) + "\n",
  )

  let history: ReturnType<typeof usePromptHistory> | undefined
  function Capture() {
    history = usePromptHistory()
    return null
  }

  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Capture />
      </PromptHistoryProvider>
    </TestTuiContexts>
  ))
  try {
    await waitUntil(() => history!.loaded())
    expect(history!.hadHistoryAtStartup()).toBe(true)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

// altimate_change start — Codex HOLD finding 3: barrier-controlled races (see file header).
async function mountBare(existing?: string) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const historyPath = path.join(state, "prompt-history.jsonl")
  if (existing !== undefined) await Bun.write(historyPath, existing)

  let history: ReturnType<typeof usePromptHistory> | undefined
  function Capture() {
    history = usePromptHistory()
    return null
  }
  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Capture />
      </PromptHistoryProvider>
    </TestTuiContexts>
  ))
  await app.renderOnce()
  return {
    historyPath,
    history: history!,
    async cleanup() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function diskLines(text: string) {
  return text.split("\n").filter(Boolean)
}

test.serial(
  "barrier: append while the startup READ is pending is persisted exactly once, in FIFO order",
  async () => {
    const read = deferred<string>()
    const readSpy = spyOn(persistence, "readText").mockImplementation(() => read.promise)
    const mounted = await mountBare()
    try {
      expect(mounted.history.loaded()).toBe(false)
      mounted.history.append({ input: "appended while read pending", parts: [] })
      // The in-memory update is immediate regardless of `loaded()` — the read is still pending,
      // so no file write has happened yet either way.
      expect(mounted.history.loaded()).toBe(false)

      read.resolve(JSON.stringify({ input: "from a previous launch", parts: [] }) + "\n")
      await waitUntil(() => mounted.history.loaded())
      await mounted.history.flushed()

      const text = await Bun.file(mounted.historyPath).text()
      const onDisk = parsePromptHistory(text)
      expect(onDisk).toEqual([
        { input: "from a previous launch", parts: [] },
        { input: "appended while read pending", parts: [] },
      ])
      const lines = diskLines(text)
      expect(lines.length).toBe(2)
      expect(new Set(lines).size).toBe(2)
    } finally {
      readSpy.mockRestore()
      await mounted.cleanup()
    }
  },
)

test.serial(
  "barrier: append while the startup REWRITE's write is still in flight is persisted exactly once, in FIFO order",
  async () => {
    const originalWriteText = persistence.writeText
    const gate = deferred<void>()
    const writeSpy = spyOn(persistence, "writeText").mockImplementation(async (filePath, content) => {
      await gate.promise
      return originalWriteText(filePath, content)
    })
    const existing = JSON.stringify({ input: "from a previous launch", parts: [] }) + "\n"
    const mounted = await mountBare(existing)
    try {
      // The read resolves normally (real, unmocked disk read); onMount's `finally` then
      // synchronously snapshots + enqueues the (now gated) flush write + flips `loaded()` — all
      // before the gated `writeText` call has done anything beyond starting to await the gate.
      await waitUntil(() => mounted.history.loaded())

      // Confirm the flush's write is genuinely still in flight (gated), not merely "probably
      // still running" — `flushed()` must not have settled yet.
      let flushSettled = false
      void mounted.history.flushed().then(() => {
        flushSettled = true
      })
      await Bun.sleep(20)
      expect(flushSettled).toBe(false)

      // Append NOW, deterministically while the flush's write is gated/in flight.
      mounted.history.append({ input: "appended during in-flight rewrite", parts: [] })

      // Release the gate: the flush's write proceeds first; the append's own queued `appendText`
      // runs strictly AFTER it (FIFO, via `queueWrite`), never concurrently.
      gate.resolve()
      await waitUntil(() => flushSettled)
      await mounted.history.flushed()

      const text = await Bun.file(mounted.historyPath).text()
      const onDisk = parsePromptHistory(text)
      expect(onDisk).toEqual([
        { input: "from a previous launch", parts: [] },
        { input: "appended during in-flight rewrite", parts: [] },
      ])
      const lines = diskLines(text)
      expect(lines.length).toBe(2)
      expect(new Set(lines).size).toBe(2)
    } finally {
      writeSpy.mockRestore()
      await mounted.cleanup()
    }
  },
)

test.serial(
  "barrier: an append synchronous with the SAME reactive tick loaded() flips is not duplicated by the flush",
  async () => {
    // The lazy-snapshot duplicate bug (cursor 3986264135, cubic 3986055642) required the append
    // to land in-memory BEFORE the flush's write closure actually evaluated its content — which,
    // under the old lazy-read code, happened on the very next microtask after `setLoaded(true)`,
    // not after any `Bun.sleep`-based poll could observe `loaded()`. Solid's `createEffect`
    // reacting to a signal read re-runs SYNCHRONOUSLY, in the same call stack as the `setLoaded`
    // that triggered it — so an effect watching `loaded()` that calls `append()` the instant it
    // becomes true reproduces that exact race by construction: the append happens before the
    // queued flush closure's `.then()` microtask has had a chance to run, whether that closure
    // reads `store.history` lazily (old, buggy) or was already handed a frozen snapshot before
    // `setLoaded` ran (current `history.tsx` — the snapshot is computed BEFORE `setLoaded`, in
    // the same synchronous block, so this effect's append can never be included in it).
    const tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    const historyPath = path.join(state, "prompt-history.jsonl")
    await Bun.write(historyPath, JSON.stringify({ input: "from a previous launch", parts: [] }) + "\n")

    let history: ReturnType<typeof usePromptHistory> | undefined
    let appended = false
    function Capture() {
      history = usePromptHistory()
      createEffect(() => {
        if (!history!.loaded() || appended) return
        appended = true
        history!.append({ input: "appended in the same tick loaded() flipped", parts: [] })
      })
      return null
    }
    const app = await testRender(() => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <PromptHistoryProvider>
          <Capture />
        </PromptHistoryProvider>
      </TestTuiContexts>
    ))
    try {
      await app.renderOnce()
      await waitUntil(() => appended)
      await waitUntil(() => history!.loaded())
      await history!.flushed()

      const text = await Bun.file(historyPath).text()
      const onDisk = parsePromptHistory(text)
      expect(onDisk).toEqual([
        { input: "from a previous launch", parts: [] },
        { input: "appended in the same tick loaded() flipped", parts: [] },
      ])
      const lines = diskLines(text)
      expect(lines.length).toBe(2)
      expect(new Set(lines).size).toBe(2)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  },
)
// altimate_change end

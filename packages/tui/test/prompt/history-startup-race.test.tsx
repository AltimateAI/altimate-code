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
// tests cover both completion orders — a genuinely fresh launch, and a returning one — and assert
// the deferred write actually lands on disk once `loaded()` settles.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"
import { PromptHistoryProvider, usePromptHistory, parsePromptHistory } from "../../src/prompt/history"

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
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
// altimate_change end

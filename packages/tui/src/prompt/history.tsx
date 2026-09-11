import path from "path"
import { createSignal, onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

// altimate_change start — cubic review: the startup merge of disk-read `lines` with whatever
// `append()` already pushed in-memory during the read (`prev`) must honor the same two
// invariants normal appends do — no consecutive duplicate entries, capped at
// MAX_HISTORY_ENTRIES — rather than a raw concatenation that could reintroduce a duplicate
// straddling the two halves or exceed the cap.
export function mergeStartupHistory(lines: readonly PromptInfo[], prev: readonly PromptInfo[]): PromptInfo[] {
  const merged: PromptInfo[] = []
  for (const entry of [...lines, ...prev]) {
    if (isDuplicateEntry(merged.at(-1), entry)) continue
    merged.push(entry)
  }
  return merged.slice(-MAX_HISTORY_ENTRIES)
}
// altimate_change end

// altimate_change start — round 6 review: both full-rewrite call sites (the startup flush and
// `append()`'s trimmed branch) must snapshot `store.history` to a STRING synchronously, at the
// moment they decide to enqueue a write — never read it lazily from inside the queued closure.
// See the onMount `finally` block below for why.
function serializeHistory(history: readonly PromptInfo[]): string {
  return history.map((line) => JSON.stringify(line)).join("\n") + "\n"
}
// altimate_change end

// altimate_change start — preserve in-progress prompt while browsing history
export type PromptHistoryNavigationState = {
  index: number
  draft?: PromptInfo
}

export function movePromptHistory(
  state: PromptHistoryNavigationState,
  history: readonly PromptInfo[],
  direction: 1 | -1,
  prompt: PromptInfo,
): { state: PromptHistoryNavigationState; item: PromptInfo } | undefined {
  if (!history.length) return undefined

  const current = state.index === 0 ? undefined : history.at(state.index)
  if (current && current.input !== prompt.input && prompt.input.length) return undefined

  const next = state.index + direction
  if (Math.abs(next) > history.length) return undefined
  if (next > 0) return undefined

  const draft = state.index === 0 && next < 0 ? structuredClone(prompt) : state.draft
  if (next === 0) {
    return {
      state: { index: 0 },
      item: draft ?? { input: "", parts: [] },
    }
  }

  const item = history.at(next)
  if (!item) return undefined
  return {
    state: {
      index: next,
      draft,
    },
    item,
  }
}
// altimate_change end

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    // altimate_change start — fixes #1301: a "returning user" signal for the startup migration
    // decision in app.tsx, independent of the current project's (30-day-windowed) session list.
    // `loaded()` settles (true) once this read finishes either way; `hadHistoryAtStartup()` is a
    // ONE-TIME snapshot taken at that moment, not a live "history is non-empty" memo — a prompt
    // sent during THIS launch must not retroactively make the launch look like a return visit.
    const [loaded, setLoaded] = createSignal(false)
    let hadHistoryAtStartup = false
    // altimate_change — Codex review round 4 / round 6 (cursor/cubic/kilo): the startup flush and
    // every `append()` write are fire-and-forget from `onMount`'s perspective — `loaded()`
    // becoming true means the startup flush, if one was needed, has been SNAPSHOTTED and HANDED
    // TO the write queue (see the `onMount` `finally` block below), not that it has landed on
    // disk yet. An earlier fix tried making `loaded()` also imply "landed on disk" by awaiting
    // the write first, but that opened a WORSE window: an `append()` that lands during that await
    // still sees `loaded() === false`, takes the early return, and is dropped for good (the
    // flush it deferred to has already been snapshotted and sent without it). Track the most
    // recently kicked-off write so a caller (tests, primarily) can wait for it via `flushed()`
    // below instead of assuming `loaded()` implies it.
    let pendingWrite: Promise<void> = Promise.resolve()
    // altimate_change start — Cursor review round 5: serialize the startup flush and every
    // append's write through one FIFO queue. Before this, each call site reassigned
    // `pendingWrite` independently — that tracked only the LAST write kicked off, it never made
    // one write wait for the previous one to actually land. Two writes could then run
    // concurrently (this onMount flush and a later append, once `loaded()` had already flipped
    // true) and race on disk: whichever finished last "wins", not necessarily the one kicked off
    // last, so a racing append could be silently clobbered by the still in-flight flush.
    // Chaining every write onto `pendingWrite` guarantees strict start-after-previous-settles
    // ordering. Round 6 review: every call site now passes a closure over content already
    // captured synchronously at enqueue time (a pre-serialized snapshot string for a full
    // rewrite, or the already-`structuredClone`d entry for a plain append) — never one that
    // lazily re-reads live `store.history` when it finally runs, which used to let a rewrite's
    // closure pick up an entry a later, already-queued append would ALSO write, duplicating it.
    function queueWrite(write: () => Promise<void>) {
      pendingWrite = pendingWrite.then(write)
      return pendingWrite
    }
    // altimate_change end
    onMount(async () => {
      try {
        const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
        // altimate_change — Codex review round 4: MERGE, never blind-overwrite. An `append()`
        // that ran while this read was in flight already pushed its entry onto `store.history`
        // (in-memory only — its file write is deferred, see `append()` below); a plain
        // `setStore("history", lines)` here would silently discard that entry the moment the read
        // resolves. `lines` (older, from disk) comes first, whatever was already appended this
        // launch comes after.
        setStore("history", (prev) => mergeStartupHistory(lines, prev))
        // altimate_change — Codex review round 4: captured from the READ RESULT ALONE, before
        // `append()` below can have merged anything else into `store.history`. Subtracting a
        // count of races that happened DURING the read (the previous fix) was itself unsound: an
        // early append's file write can land on disk AFTER the read started but BEFORE it
        // resolves, in which case it's already counted in `lines.length` too — one pre-existing
        // entry + one early, already-landed append could read as `lines.length === 2`, and
        // subtracting the count of 1 wrongly gives `2 - 1 = 1 > 0`... but the reverse also
        // happens: NO pre-existing entries + one early append whose write hadn't landed by read
        // time gives `lines.length === 0`, and subtracting still gives a negative-clamped 0 —
        // except when the write DOES land in between, giving `1 - 1 = 0` for a case that should
        // read as "no prior history", by accident rather than by contract. Arithmetic against an
        // unbounded race has no correct answer; fixed by construction below instead — `append()`
        // defers its FILE write (never the in-memory update) until this read has fully resolved
        // and this snapshot has already been taken, so nothing from this launch can reach
        // `lines` in the first place.
        hadHistoryAtStartup = lines.length > 0
      } finally {
        // altimate_change — round 6 review (cursor 3986264135/3986264141, cubic 3986055642,
        // kilo 3986287554, coderabbit 3982012207, all independently converging here): the ATOMIC
        // transition. `store.history` at this point already reflects the merge above AND
        // whatever `append()` calls raced the read (in-memory updates there are always
        // immediate, see `append()` below) — a rewrite is needed either to self-heal a
        // corrupted/malformed file or to persist those raced appends, and `store.history.length
        // > 0` is true for either case. These three steps run SYNCHRONOUSLY, with no `await`
        // between them, which is what makes the whole thing safe:
        //   1. snapshot `store.history` to a STRING right now, via `serializeHistory` (see its
        //      declaration above) — never read `store.history` lazily from inside the queued
        //      write closure.
        //   2. hand that snapshot to `queueWrite` — kicked off immediately, NOT awaited, so
        //      `setLoaded` below never waits on disk I/O.
        //   3. flip `loaded()` true.
        // Two independent bugs this closes at once:
        //   - Awaiting the write before `setLoaded(true)` (a prior fix) made `loaded()` also mean
        //     "landed on disk", but opened a worse window: an `append()` arriving during that
        //     await still saw `loaded() === false`, took the early return below, and was DROPPED
        //     — the flush it deferred to had already been sent without it.
        //   - Reading `store.history` lazily inside the write closure (instead of snapshotting
        //     synchronously here) let the closure pick up entries a LATER, already-queued
        //     append() would ALSO write — once both closures actually ran, the same entry landed
        //     in the file TWICE.
        // With the snapshot frozen at this exact synchronous instant: an append that already ran
        // is already in the snapshot, and (because `loaded()` was still false when it ran) wrote
        // nothing itself — persisted exactly once, by this flush. An append that runs after this
        // point sees `loaded() === true` and queues its own write BEHIND this one in the same
        // FIFO queue — persisted exactly once too, never overlapping with this flush's content.
        if (store.history.length > 0) {
          const snapshot = serializeHistory(store.history)
          queueWrite(() => writeText(historyPath, snapshot).catch(() => {}))
        }
        setLoaded(true)
      }
    })
    // altimate_change end

    const [store, setStore] = createStore({
      index: 0,
      // altimate_change start — preserve in-progress prompt while browsing history
      draft: undefined as PromptInfo | undefined,
      // altimate_change end
      history: [] as PromptInfo[],
    })

    return {
      // altimate_change start — fixes #1301: see the signal declarations above
      loaded,
      hadHistoryAtStartup() {
        return hadHistoryAtStartup
      },
      // altimate_change end
      // altimate_change start — preserve in-progress prompt while browsing history
      move(direction: 1 | -1, prompt: PromptInfo) {
        const result = movePromptHistory({ index: store.index, draft: store.draft }, store.history, direction, prompt)
        if (!result) return undefined
        setStore("index", result.state.index)
        setStore("draft", result.state.draft)
        return result.item
        // altimate_change end
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          // altimate_change start — clear transient draft after successful history append
          setStore("draft", undefined)
          // altimate_change end
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
            // altimate_change start — clear transient draft after successful history append
            draft.draft = undefined
            // altimate_change end
          }),
        )

        // altimate_change start — Codex review round 4: the IN-MEMORY update above always
        // happens immediately (so the UI — history navigation, drafts — is unaffected either
        // way); only the FILE write is deferred while the startup read is still in flight, so
        // this launch's own write cannot land in `historyPath` before that read's
        // `hadHistoryAtStartup` snapshot is taken from it (see onMount above). `onMount`'s
        // `finally` flushes the merged `store.history` in one write once `loaded()` settles —
        // writing here too could race that flush and get silently clobbered by it. `pendingWrite`
        // tracking (see its declaration above) lets a caller (tests, primarily) await the write
        // via `flushed()` below instead of assuming it already landed once kicked off.
        if (!loaded()) return

        if (trimmed) {
          // altimate_change — round 6 review: same snapshot-at-enqueue reasoning as the onMount
          // flush above — `store.history` is captured to a string synchronously, right here,
          // rather than lazily inside the queued closure. This call is itself fully synchronous
          // (no `await` between the `setStore` above and this `queueWrite`), so no OTHER
          // `append()` can interleave with it directly — but a LATER append(), enqueued after
          // this one, would still update `store.history` immediately (in-memory) before its own
          // write reaches the front of the queue; a lazy read here could pick that entry up too,
          // duplicating it once this rewrite's closure and that later append's own queued write
          // both eventually run.
          const snapshot = serializeHistory(store.history)
          queueWrite(() => writeText(historyPath, snapshot).catch(() => {}))
          return
        }
        queueWrite(() => appendText(historyPath, JSON.stringify(entry) + "\n").catch(() => {}))
      },
      // altimate_change end
      // altimate_change start — see `pendingWrite`'s declaration above. Awaiting this settles
      // once the most recently kicked-off write has landed (or failed).
      flushed() {
        return pendingWrite
      },
      // altimate_change end
    }
  },
})

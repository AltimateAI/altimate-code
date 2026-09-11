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
    // altimate_change — Codex review round 4 / Cursor review round 5 (HIGH): the startup flush
    // below is now AWAITED before `loaded()` flips true (see the `onMount` `finally` block), so
    // `loaded()` becoming true DOES mean that write, if one was needed, has landed on disk. What
    // it still does NOT cover is a LATER `append()`'s own write — those are kicked off (and
    // queued, see `queueWrite` below) only after `loaded()` is already true, and remain
    // fire-and-forget from the caller's perspective. Track the most recently kicked-off write so
    // a caller (tests, primarily) can wait for it via `flushed()` below instead of assuming
    // `loaded()` implies it.
    let pendingWrite: Promise<void> = Promise.resolve()
    // altimate_change start — Cursor review round 5: serialize the startup flush and every
    // append's write through one FIFO queue. Before this, each call site reassigned
    // `pendingWrite` independently — that tracked only the LAST write kicked off, it never made
    // one write wait for the previous one to actually land. Two writes could then run
    // concurrently (this onMount flush and a later append, once `loaded()` had already flipped
    // true) and race on disk: whichever finished last "wins", not necessarily the one kicked off
    // last, so a racing append could be silently clobbered by the still in-flight flush.
    // Chaining every write onto `pendingWrite` guarantees strict start-after-previous-settles
    // ordering; each write closure re-reads `store.history` at the moment it actually runs
    // (after prior writes have settled), never a stale snapshot taken when it was queued.
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
        // altimate_change — flush: a rewrite is needed either to self-heal a corrupted/malformed
        // file (whenever the read above found anything at all) or to persist any `append()` that
        // deferred its write while this read was still in flight (see `append()` below) — by now
        // `store.history` already reflects both, in-memory updates there are always immediate.
        // One write covers both cases; `store.history.length > 0` is true for either.
        //
        // altimate_change — Cursor review round 5, HIGH: `setLoaded(true)` used to fire BEFORE
        // this write was even kicked off, let alone landed. `queueWrite`'s serialization (see its
        // declaration above) already prevents a racing append from being clobbered by this write
        // once both are in the same queue — but that guarantee lived entirely in how the two
        // writes happen to interleave, not in what `loaded()` itself promises. Awaiting the write
        // here makes the invariant explicit and independently verifiable: `loaded()` becoming
        // true means this launch's startup rewrite has actually settled on disk, full stop — not
        // merely "kicked off, and safe only because nothing else raced it yet."
        if (store.history.length > 0)
          await queueWrite(() =>
            writeText(
              historyPath,
              store.history.map((line) => JSON.stringify(line)).join("\n") + "\n",
            ).catch(() => {}),
          )
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
          queueWrite(() =>
            writeText(
              historyPath,
              store.history.map((line) => JSON.stringify(line)).join("\n") + "\n",
            ).catch(() => {}),
          )
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

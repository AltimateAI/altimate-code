import path from "path"
import { onMount } from "solid-js"
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
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0)
        writeText(historyPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    })

    const [store, setStore] = createStore({
      index: 0,
      // altimate_change start — preserve in-progress prompt while browsing history
      draft: undefined as PromptInfo | undefined,
      // altimate_change end
      history: [] as PromptInfo[],
    })

    return {
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

        if (trimmed) {
          writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
          return
        }
        appendText(historyPath, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})

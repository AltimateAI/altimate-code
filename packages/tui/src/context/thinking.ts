import { createMemo, type Setter } from "solid-js"
import { useKV } from "./kv"

export type ThinkingMode = "show" | "hide"

const MODES: readonly ThinkingMode[] = ["show", "hide"] as const

// OpenAI's Responses API surfaces reasoning summaries that start with a bolded
// title block: "**Inspecting PR workflow**\n\n<body>". Treat that first block,
// or a complete title still awaiting its body while streaming, as disclosure
// metadata so the TUI can style its header independently from the markdown body.
export function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() }
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

// Cycle order matches the slash command: show → hide → show.
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function useThinkingMode() {
  const kv = useKV()
  // altimate_change start — default everyone (fresh installs AND upgraders) to collapsed thinking.
  // Previously a legacy `thinking_visibility === true` value migrated users to "show" — but that
  // was main's DEFAULT, not an explicit choice, so upgraders saw the full chain-of-thought (incl.
  // any secrets in the reasoning) expanded on every turn. There is no reliable signal separating an
  // explicit "show" preference from the old default, so honor only an explicit `thinking_mode` and
  // default the rest to "hide". Users who want full reasoning can toggle it on with /thinking.
  const [stored, setStored] = kv.signal<ThinkingMode>("thinking_mode", "hide")
  // altimate_change end

  // The kv signal exposes its setter typed as `Setter<T>` which carries Solid's
  // overload set; passing an updater fn through a property access loses the
  // bivariance trick the existing `setX((prev) => ...)` callsites rely on.
  // Wrap it in a sane shape so consumers can just call `set(next)` or pass
  // an updater.
  const set = (next: ThinkingMode | ((prev: ThinkingMode) => ThinkingMode)) => {
    if (typeof next === "function") setStored(next as Setter<ThinkingMode>)
    else setStored(() => next)
  }

  if ((stored() as string) === "minimal") set("hide")

  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "hide"
  })

  return {
    mode,
    set,
  }
}

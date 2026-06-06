import { Locale } from "@/util/locale"

// Threshold above which a still-running tool is rendered in the warning color.
export const SLOW_TOOL_MS = 30_000

export interface Elapsed {
  start: number
  ms: number
  running: boolean
}

// Single source of truth for the "HH:MM:SS · running 12.3s" suffix shown
// next to a tool call. Separator/prefix lives at the call site because it
// differs by surface (inline vs block).
export function formatElapsed(e: Elapsed): string {
  return `${Locale.clockTime(e.start)} · ${e.running ? "running " : ""}${Locale.duration(e.ms)}`
}

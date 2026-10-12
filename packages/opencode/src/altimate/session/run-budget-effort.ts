import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export const EffortDowngraded = BusEvent.define(
  "session.budget.effort",
  z.object({ sessionID: z.string(), timestamp: z.number() }),
)

// The synchronous run prompt owns this state across all of its generations.
// Synthetic follow-ups re-arm it explicitly, so reusing the session in another
// run or in the TUI never inherits the previous run's reduced effort.
const active = new Map<string, { downgradedAt?: number; finalizing: boolean }>()

export function begin(sessionID: string, finalizing = false): () => void {
  const state = { finalizing }
  active.set(sessionID, state)
  return () => {
    if (active.get(sessionID) === state) active.delete(sessionID)
  }
}

export function downgradeEffort(sessionID: string): number | undefined {
  const state = active.get(sessionID)
  if (!state) return undefined
  return state.downgradedAt ??= Date.now()
}

export function effortOverride(sessionID: string): boolean {
  return active.get(sessionID)?.downgradedAt !== undefined
}

export function toolsDisabled(sessionID: string): boolean {
  return active.get(sessionID)?.finalizing === true
}

export function hasActiveRuns(): boolean {
  return active.size > 0
}

export function activeRun(sessionID: string): boolean {
  return active.has(sessionID)
}

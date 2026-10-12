import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

const generations = new Map<string, () => void>()

/** Register only the active provider request; disposing cannot remove a newer request. */
export function registerGeneration(sessionID: string, interrupt: () => void): () => void {
  generations.set(sessionID, interrupt)
  return () => {
    if (generations.get(sessionID) === interrupt) generations.delete(sessionID)
  }
}

/** The processor waits for already-running tools to persist their results before interrupting. */
export function interruptGeneration(sessionID: string): void {
  generations.get(sessionID)?.()
}

export const GenerationInterrupted = BusEvent.define(
  "session.generation.interrupted",
  z.object({ sessionID: SessionID.zod, timestamp: z.number() }),
)

export * as RunBudget from "./run-budget"

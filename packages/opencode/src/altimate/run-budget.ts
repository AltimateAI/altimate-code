import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

const generations = new Map<string, () => void>()

/** A harness deadline stops generation but may still deliver an already committed answer. */
export class HarnessDeadline extends DOMException {
  constructor() {
    super("Run time budget hard deadline reached", "AbortError")
  }
}

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

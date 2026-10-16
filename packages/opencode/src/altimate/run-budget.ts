import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

const generations = new Map<string, () => void>()
const queryDeadlines = new Map<string, { deadline?: number }>()

/** Prompt-owned query limits cannot leak into a later run of the same session. */
export function registerQueryDeadline(sessionID: string, deadline: number | undefined): () => void {
  const state = { deadline: deadline !== undefined && Number.isFinite(deadline) && deadline > 0 ? deadline : undefined }
  queryDeadlines.set(sessionID, state)
  return () => {
    if (queryDeadlines.get(sessionID) === state) queryDeadlines.delete(sessionID)
  }
}

export function queryDeadline(sessionID: string): number | undefined {
  return queryDeadlines.get(sessionID)?.deadline
}

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

/** A delayed reminder may interrupt only the provider request it originally targeted. */
export function captureGenerationInterrupt(sessionID: string): () => void {
  const interrupt = generations.get(sessionID)
  return () => {
    if (generations.get(sessionID) === interrupt) interrupt?.()
  }
}

export const GenerationInterrupted = BusEvent.define(
  "session.generation.interrupted",
  z.object({ sessionID: SessionID.zod, timestamp: z.number() }),
)

export * as RunBudget from "./run-budget"

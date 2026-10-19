import { Bus } from "@/bus"
import type { SessionID } from "@/session/schema"
import { RunBudget } from "../run-budget"
import * as RunBudgetEffort from "./run-budget-effort"

/** Run headers work through the shared SDK for both local and attached servers. */
export async function withBudgetControl<T>(
  input: { sessionID: SessionID; control?: string; noReply?: boolean; queryDeadline?: string },
  prompt: () => Promise<T>,
): Promise<T> {
  const soft = input.control === "soft" || input.control === "soft-no-downgrade"
  const finalizing = input.control === "finalization" || input.control === "finalization-no-downgrade"
  if (!soft && !finalizing && input.control !== "work") return prompt()

  const interrupt = input.noReply && soft ? RunBudget.captureGenerationInterrupt(input.sessionID) : undefined
  // A synchronous prompt spans its entire session loop. A noReply reminder
  // borrows that scope; subsequent finalization prompts explicitly re-arm it.
  const release = input.noReply ? undefined : RunBudgetEffort.begin(input.sessionID, finalizing)
  const releaseQueryDeadline = input.noReply
    ? undefined
    : RunBudget.registerQueryDeadline(input.sessionID, finalizing ? undefined : Number(input.queryDeadline))
  try {
    if (
      (input.control === "soft" || input.control === "finalization") &&
      process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE !== "0"
    ) {
      const timestamp = RunBudgetEffort.downgradeEffort(input.sessionID)
      if (timestamp !== undefined) {
        await Bus.publish(RunBudgetEffort.EffortDowngraded, { sessionID: input.sessionID, timestamp })
      }
    }
    const result = await prompt()
    // Interrupt the captured generation only after the next user turn is saved.
    interrupt?.()
    return result
  } finally {
    releaseQueryDeadline?.()
    release?.()
  }
}

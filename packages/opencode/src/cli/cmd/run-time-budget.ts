/** Fractional seconds are useful for short runs; all budgets must be finite and positive. */
export function isValidTimeBudget(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** The hard deadline takes precedence when a step crosses both boundaries. */
export function deadline(elapsedS: number, budgetS: number | undefined): "soft" | "hard" | undefined {
  if (budgetS === undefined) return undefined
  if (elapsedS >= budgetS) return "hard"
  if (elapsedS >= budgetS * 0.8) return "soft"
  return undefined
}

export * as RunTimeBudget from "./run-time-budget"

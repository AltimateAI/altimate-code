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

/** Leave answer time inside the work budget, scaling the reserve for short runs. */
export function queryDeadline(startedAt: number, budgetS: number | undefined): number | undefined {
  if (budgetS === undefined) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, startedAt + budgetS * 1000 - Math.min(90_000, budgetS * 200))
}

export * as RunTimeBudget from "./run-time-budget"

import type { Validator, ValidatorResult } from "./types"

interface Check {
  validator: Validator
  result: ValidatorResult
}

export function validatorEnforcement(
  checks: Check[],
  options: { enabled: boolean; strict: boolean; retryCount: number; maxRetries: number },
) {
  const failures: Check[] = []
  const advisories: string[] = []
  if (options.enabled) {
    for (const check of checks) {
      const { validator, result } = check
      if (!result.ok && (options.strict || result.classification !== "unverifiable")) failures.push(check)
      if (!options.strict && result.advisory) {
        advisories.push(`[altimate-validator advisory: ${validator.name}] ${result.advisory}`)
      }
    }
  }
  return {
    failures,
    advisories,
    retry: failures.length > 0 && options.retryCount < options.maxRetries,
    exhausted: failures.length > 0 && options.retryCount >= options.maxRetries,
  }
}

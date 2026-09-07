import { FreeTier } from "./client"
import { FreeTierStore } from "./store"

export type RegistrationResult =
  | { ok: true }
  | {
      ok: false
      result: "network" | "rate_limited" | "unavailable" | "error"
      message: string
    }

export function createRegistrationConsentGate(input: {
  /** Arms the one-shot proof `register` will later be asked to redeem. */
  arm: (token: string) => void
  /** Receives the bare token; must itself verify + consume proof of accepted disclosure. */
  register: (token: string) => Promise<unknown>
  onUnexpectedError?: (error: unknown) => void
}) {
  return {
    setToken(value: { token: string }): void {
      input.arm(value.token)
    },
    async register(value: { token: string }): Promise<RegistrationResult> {
      try {
        await input.register(value.token)
        return { ok: true }
      } catch (error) {
        if (error instanceof FreeTier.RegistrationError && error.kind === "cancelled") {
          return { ok: false, result: "error", message: error.message }
        }
        if (error instanceof FreeTier.RegistrationError) {
          return {
            ok: false,
            result:
              error.status === 429
                ? "rate_limited"
                : error.status === 503
                  ? "unavailable"
                  : error.kind === "network"
                    ? "network"
                    : "error",
            message: error.message,
          }
        }
        if (error instanceof FreeTier.ConfigurationError || error instanceof FreeTierStore.InvalidCredentialStoreError) {
          return { ok: false, result: "error", message: error.message }
        }
        input.onUnexpectedError?.(error)
        return {
          ok: false,
          result: "error",
          message: "Could not set up Altimate Base. Try again, or pick another provider.",
        }
      }
    },
  }
}

export * as FreeTierConsent from "./consent"

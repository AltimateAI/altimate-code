import { createHash } from "node:crypto"
import { ALTIMATE_BASE_DISCLOSURE } from "@opencode-ai/core/altimate-base-disclosure"
import { FreeTier } from "./client"
import { FreeTierStore } from "./store"

/**
 * The text a user consents against before any Base credential is minted, plus the picker hint,
 * served to hosts that render their own disclosure (the VS Code extension's chat panel, via
 * GET /altimate/base/disclosure).
 *
 * Both are defined once in `@opencode-ai/core/altimate-base-disclosure` and re-exported here, so
 * the TUI dialog and this route can never drift apart.
 */
export {
  ALTIMATE_BASE_DISCLOSURE as DISCLOSURE,
  ALTIMATE_BASE_HINT as HINT,
} from "@opencode-ai/core/altimate-base-disclosure"

/**
 * SHA-256 of the canonical disclosure, hex-encoded.
 *
 * `POST /altimate/base/register` requires the caller to echo this back. This is a **text-version
 * agreement, not proof of consent**: it establishes that the caller holds the current disclosure,
 * so a client still rendering superseded wording cannot register people against text they were
 * never shown. It does NOT establish that a human read anything — any caller can GET the disclosure
 * and echo the hash. Whether a person actually saw the text remains an assertion by the caller.
 *
 * Not a secret (it is derived from public text), so a plain comparison is fine.
 */
export function disclosureHash(): string {
  return createHash("sha256").update(ALTIMATE_BASE_DISCLOSURE, "utf8").digest("hex")
}

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

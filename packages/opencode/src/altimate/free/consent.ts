import { createHash } from "node:crypto"
import { ALTIMATE_BASE_DISCLOSURE } from "@opencode-ai/core/altimate-base-disclosure"
import { FreeTier } from "./client"
import { FreeTierStore } from "./store"

/**
 * The gateway still logs requests, so this notice text stays even though registering no longer
 * requires accepting it first. Shown once per install (the TUI's one-line notice, the first time
 * Base becomes the active model) and served to hosts that render their own copy — the VS Code
 * extension's chat panel, via GET /altimate/base/disclosure. The picker hint is the short form
 * used in model lists.
 *
 * Both are defined once in `@opencode-ai/core/altimate-base-disclosure` and re-exported here, so
 * the TUI notice and this route can never drift apart.
 */
export {
  ALTIMATE_BASE_DISCLOSURE as DISCLOSURE,
  ALTIMATE_BASE_HINT as HINT,
} from "@opencode-ai/core/altimate-base-disclosure"

/**
 * SHA-256 of the canonical disclosure, hex-encoded. Served by `GET /altimate/base/disclosure` for
 * compatibility with older clients that still echo it back on `POST /altimate/base/register` —
 * that route now accepts and ignores it, since registering no longer requires it.
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

/**
 * Wraps a registration call (`FreeTier.register()`, from the picker or the HTTP route) and
 * classifies its outcome into the `{ok, result, message}` shape both callers return to their UI.
 * No consent token: registration itself is unconditional now, this only turns whatever it throws
 * into something displayable.
 */
export function createRegistrationGate(input: {
  register: () => Promise<unknown>
  onUnexpectedError?: (error: unknown) => void
}) {
  return {
    async register(): Promise<RegistrationResult> {
      try {
        await input.register()
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

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
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

// altimate_change start — Codex review finding: `run`, `serve`, `acp` and `web` all call
// `FreeTier.autoRegisterWithin()` before a TUI (or any UI at all) exists to show the disclosure —
// only the TUI's own one-line toast (`useAltimateBaseDisclosureNotice` in
// tui/src/component/altimate-onboarding.tsx) covered the interactive case. Prints the same
// disclosure text to stderr, once per install, the first time a HEADLESS entrypoint auto-registers
// successfully.
//
// "Once per install" is tracked with a marker file next to the credential store rather than the
// TUI's kv — the TUI's kv lives at a per-workspace path (`TuiPaths.state`, via
// `TuiPathsProvider`/`context/kv.tsx`) that these backend processes have no general way to reach
// (a `serve` and its TUI client can even be on different machines), while the credential store
// (`FreeTierStore`, `Global.Path.data`) is this same install's single global file either way.
function disclosureMarkerPath(): string {
  return path.join(path.dirname(FreeTierStore.credentialPath()), "altimate-base-disclosure-shown.json")
}

async function disclosureAlreadyShown(): Promise<boolean> {
  try {
    await fs.access(disclosureMarkerPath())
    return true
  } catch {
    return false
  }
}

async function markDisclosureShown(): Promise<void> {
  const target = disclosureMarkerPath()
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await fs.writeFile(target, JSON.stringify({ shownAt: new Date().toISOString() }) + "\n", { mode: 0o600 })
}

/**
 * Print the Base disclosure to stderr for a headless entrypoint, once per install. A no-op unless
 * `justRegistered` is true (this call's own `autoRegisterWithin()` actually minted a credential —
 * not merely "already registered", which every later launch reports) and the marker isn't already
 * set. Never throws: a failure to persist the marker only risks showing the notice again on a
 * later launch, never blocks startup.
 */
export async function printDisclosureOnceForHeadless(justRegistered: boolean): Promise<void> {
  if (!justRegistered) return
  if (await disclosureAlreadyShown().catch(() => false)) return
  console.error(`Altimate Base: ${ALTIMATE_BASE_DISCLOSURE}`)
  await markDisclosureShown().catch(() => {})
}
// altimate_change end

export * as FreeTierConsent from "./consent"

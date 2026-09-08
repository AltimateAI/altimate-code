// altimate_change start — host-injected Altimate Base registration for non-TUI entrypoints.
//
// `FreeTierCapability.issueArmer()` is claimable exactly once per process and throws on a second
// call, so an HTTP route cannot claim one for itself: the TUI worker already claims it at boot for
// its own RPC gate, and that worker also serves HTTP from the same process. A route-level claim
// would therefore break the TUI worker the moment the routes module loaded — and any test that
// imported both the server and the Base test harness.
//
// Instead the entrypoint that owns the process claims the capability once and hands the resulting
// gate here. This is the same shape the TUI already uses for the same operation
// (`packages/tui/src/context/altimate-base-consent.tsx`): the host injects, the consumer checks.
//
// `altimate serve` provides a gate. The TUI worker deliberately does NOT — the TUI owns its own
// disclosure dialog, and a second registration surface inside that process would let a caller
// register without the dialog ever being shown. Consumers must treat "cannot register" as final
// and refuse, exactly as the TUI's provider picker does.
//
// The gate itself is NEVER handed back out. An earlier revision exposed `current()`, which returned
// the whole gate — including `setToken` (closing over the real armer) and `register` (redeeming
// against the real authority) — so any importer held a raw mint primitive and could register
// without going near the disclosure, in any order it liked. The check now happens *inside* this
// module, in the same call that mints, arms and redeems: there is no ordering for a caller to get
// wrong and no primitive to borrow.
//
// What this is NOT: a trust boundary against in-process code. `registerWithAcceptedDisclosure` is
// exported, and the hash it demands is a SHA-256 of public text that any caller can recompute via
// `FreeTierConsent.disclosureHash()`. In-process code can therefore still cause a registration —
// it simply cannot do so while bypassing the documented precondition, and there is now one
// audited path instead of a capability handed to every importer. The real boundary is the process:
// anything running here is already trusted to execute tools. What this closes is accidental
// misuse and the drift that comes from re-implementing the check at each call site.
import { randomBytes } from "node:crypto"
import type { createRegistrationConsentGate, RegistrationResult } from "./consent"
import { FreeTierConsent } from "./consent"

export type Registration = ReturnType<typeof createRegistrationConsentGate>

let registration: Registration | undefined

/**
 * Install the process's registration gate. Called once by the entrypoint, before the server starts
 * accepting requests.
 *
 * Single-shot, matching every other capability in this area: a second call throws rather than
 * silently replacing the gate. The earlier last-write-wins behaviour let any in-process caller swap
 * the gate out from under the routes after `serve` installed the real one. That was never a
 * privilege escalation — such code is already trusted and still cannot forge a token the private
 * authority accepts — but it was a weaker invariant than `issueArmer()`/`issueRedeemer()` next door,
 * for no benefit.
 */
export function provide(value: Registration): void {
  if (registration) throw new Error("Altimate Base registration gate already provided for this process")
  registration = value
}

/** Whether this host can register Altimate Base at all, i.e. whether an entrypoint provided a gate. */
export function canRegister(): boolean {
  return registration !== undefined
}

export type RegisterOutcome =
  /** No gate was provided; this host cannot register Altimate Base. */
  | { kind: "unavailable" }
  /** The caller echoed a hash that is not the current disclosure's. */
  | { kind: "staleDisclosure" }
  /** The gate ran; `result` carries its success or its classified failure. */
  | { kind: "done"; result: RegistrationResult }

/**
 * Verify the caller accepted the current disclosure text, then mint, arm and redeem in one step.
 *
 * The hash comparison lives here rather than in the caller so that holding the current disclosure
 * text is a precondition of minting, not a convention the caller is trusted to follow. It is a
 * **text-version agreement, not proof of consent**: it establishes that the caller holds the
 * current wording, so a client still rendering superseded text cannot register people against text
 * they were never shown. Any caller can fetch the disclosure and echo the hash, so "a human read
 * this" remains an assertion by the caller.
 */
export async function registerWithAcceptedDisclosure(acceptedDisclosureSha256: string): Promise<RegisterOutcome> {
  const gate = registration
  if (!gate) return { kind: "unavailable" }
  if (acceptedDisclosureSha256.toLowerCase() !== FreeTierConsent.disclosureHash()) {
    return { kind: "staleDisclosure" }
  }
  const token = randomBytes(32).toString("hex")
  gate.setToken({ token })
  return { kind: "done", result: await gate.register({ token }) }
}

export * as FreeTierHost from "./host"
// altimate_change end

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
// register without the dialog ever being shown. Consumers must treat `undefined` as "this host
// cannot register Altimate Base" and refuse, exactly as the TUI's provider picker does.
import type { createRegistrationConsentGate } from "./consent"

export type Registration = ReturnType<typeof createRegistrationConsentGate>

let registration: Registration | undefined

/**
 * Install the process's registration gate. Called once by the entrypoint, before the server starts
 * accepting requests. A second call replaces the gate rather than throwing: the capability itself is
 * already single-claim, so there is nothing to protect here, and throwing would only turn a
 * misordered startup into a crash.
 */
export function provide(value: Registration): void {
  registration = value
}

/** The host-injected gate, or `undefined` when this host cannot register Altimate Base. */
export function current(): Registration | undefined {
  return registration
}

export * as FreeTierHost from "./host"
// altimate_change end

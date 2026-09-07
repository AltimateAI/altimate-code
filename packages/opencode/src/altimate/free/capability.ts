const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_PENDING = 16

/**
 * Worker-local, short-lived capabilities proving that a disclosure action was accepted.
 * Multiple dialogs may overlap, so consuming or rejecting one token must not invalidate another.
 *
 * This lives in its own leaf module so the registration client can depend on it without a cycle:
 * registration checks a token against this module's private authority before touching the
 * network, which makes consent a property of the operation rather than of its call sites.
 *
 * The class stays exported so its arm/consume/TTL/bounding mechanics are directly unit
 * testable in isolation — but that export is inert for security purposes: `registerAfterConsent`
 * never accepts a caller-supplied instance, so a store you construct yourself only ever validates
 * against itself. The one instance that matters (`productionAuthority` below) is never exported;
 * the only way to influence it is `issueArmer()`/`issueRedeemer()`, each of which can be claimed
 * exactly once per process. See those functions for the actual unforgeability guarantee.
 */
export class ConsentCapabilityStore {
  private readonly pending = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly now: () => number

  constructor(input: { ttlMs?: number; maxPending?: number; now?: () => number } = {}) {
    this.ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS)
    this.maxPending = Math.max(1, input.maxPending ?? DEFAULT_MAX_PENDING)
    this.now = input.now ?? Date.now
  }

  private cleanup(now: number): void {
    for (const [token, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(token)
    }
  }

  arm(token: string): void {
    if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid Altimate Base consent capability")
    const now = this.now()
    this.cleanup(now)
    this.pending.delete(token)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value
      if (!oldest) break
      this.pending.delete(oldest)
    }
    this.pending.set(token, now + this.ttlMs)
  }

  consume(token: string): boolean {
    if (!TOKEN_PATTERN.test(token)) return false
    const now = this.now()
    this.cleanup(now)
    if (!this.pending.has(token)) return false
    this.pending.delete(token)
    return true
  }
}

// The process's ONE production consent authority. Never exported — the only way to reach it is
// through `issueArmer`/`issueRedeemer` below, each claimable exactly once.
const productionAuthority = new ConsentCapabilityStore()
let armerIssued = false
let redeemerIssued = false

/**
 * Hands out the ability to arm Altimate Base's production consent authority. Callable exactly
 * once per process: a second call throws. The sole legitimate caller is the registration consent
 * gate built once at TUI worker boot (`cli/tui/worker.ts`), before any plugin, tool, or session
 * code has a chance to run. Because this is the only way to arm the authority that
 * `registerAfterConsent` checks against, no other in-process code — however it constructs its
 * own `ConsentCapabilityStore` or calls this function again — can mint a token that will ever be
 * accepted; a self-armed store only ever validates against itself.
 */
export function issueArmer(): (token: string) => void {
  if (armerIssued) throw new Error("Altimate Base consent armer already issued for this process")
  armerIssued = true
  return (token) => productionAuthority.arm(token)
}

/**
 * Hands out the ability to redeem (consume) a token against the production consent authority.
 * Callable exactly once per process — `registerAfterConsent` claims it at module load, so
 * registration can verify consent without ever accepting a capability object a caller could
 * substitute. Pairs with `issueArmer`: only a token armed through that function's closure can
 * ever redeem here, because both close over the same private `productionAuthority`.
 */
export function issueRedeemer(): (token: string) => boolean {
  if (redeemerIssued) throw new Error("Altimate Base consent redeemer already issued for this process")
  redeemerIssued = true
  return (token) => productionAuthority.consume(token)
}

export * as FreeTierCapability from "./capability"

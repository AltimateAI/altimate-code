const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_PENDING = 16

/**
 * Worker-local, short-lived capabilities proving that a disclosure action was accepted.
 * Multiple dialogs may overlap, so consuming or rejecting one token must not invalidate another.
 *
 * This lives in its own leaf module so the registration client can depend on it without a cycle:
 * registration takes a capability as a required argument and consumes it before touching the
 * network, which makes consent a property of the operation rather than of its call sites.
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

export * as FreeTierCapability from "./capability"

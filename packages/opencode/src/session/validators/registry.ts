// altimate_change start — session validator registry
import type { Validator, ValidatorContext, ValidatorResult } from "./types"

/**
 * Global validator registry. Validators register themselves at module load
 * time (see `packages/opencode/src/altimate/validators/index.ts` for the
 * altimate-specific registrations) — the framework just dispatches.
 *
 * Keyed by `name` so duplicate registrations (e.g., from hot-reload during
 * tests) replace rather than accumulate.
 */
const validators = new Map<string, Validator>()

export const ValidatorRegistry = {
  /** Register a validator. Overwrites any prior registration with the same name. */
  register(v: Validator): void {
    validators.set(v.name, v)
  },

  /** Remove a validator. Mostly useful for tests. */
  unregister(name: string): void {
    validators.delete(name)
  },

  /** Snapshot the current list of registered validators. */
  list(): readonly Validator[] {
    return Array.from(validators.values())
  },

  /** Reset all registrations. Tests only. */
  clear(): void {
    validators.clear()
  },

  /**
   * Run all validators that apply to the given context. Returns one entry
   * per validator that was relevant (skipped validators are NOT in the
   * result list). Validators that themselves throw are caught and logged;
   * the framework converts them to a {ok: true} skip so a buggy validator
   * cannot brick the agent loop.
   */
  async runAll(ctx: ValidatorContext): Promise<Array<{ validator: Validator; result: ValidatorResult }>> {
    const out: Array<{ validator: Validator; result: ValidatorResult }> = []
    for (const v of validators.values()) {
      let applies = false
      try {
        applies = await v.appliesTo(ctx)
      } catch (e) {
        // appliesTo() throwing is a validator bug; skip rather than block agent.
        // Record as a soft pass so callers can observe the skipped-with-error.
        out.push({
          validator: v,
          result: {
            ok: true,
            details: { error: e instanceof Error ? e.message : String(e), skipped_due_to_appliesTo_error: true },
          },
        })
        continue
      }
      if (!applies) continue
      try {
        const result = await v.check(ctx)
        out.push({ validator: v, result })
      } catch (e) {
        // check() throwing is also a validator bug; record as a soft pass so
        // the agent isn't stuck behind a broken validator. The thrown error
        // is logged by the caller.
        out.push({
          validator: v,
          result: {
            ok: true,
            details: { error: e instanceof Error ? e.message : String(e), skipped_due_to_validator_error: true },
          },
        })
      }
    }
    return out
  },
}
// altimate_change end

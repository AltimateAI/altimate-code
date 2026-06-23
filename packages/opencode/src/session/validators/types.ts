// altimate_change start — session validator framework types
/**
 * Validator framework — completion-gate checks the harness runs after the
 * model declares done, OUTSIDE the agent's command surface.
 *
 * Why this exists: trace inspection across v3-v9 of the ADE-Bench experiments
 * proved that *any* enforcement living inside the agent's command surface
 * (skill rule, tool description, auto-trigger inside a wrapping CLI, binary
 * substitution) gets read, agreed-with in chain-of-thought, then ignored —
 * and in the v9 case the agent actively found a backup binary to bypass the
 * wrapper. The Self-Verification Dilemma literature predicts this. The only
 * remaining lever is enforcement the agent cannot see: the harness inspecting
 * the world after the agent declares stop, and refusing to terminate if a
 * registered validator says the work isn't done.
 *
 * Architecture:
 *
 *   - A validator is a pure function (Context -> Result). It reads the
 *     filesystem / manifests / build outputs to decide whether the agent's
 *     declared "done" matches the actual state of the world.
 *   - Validators are domain-specific (dbt, sql, migration, …) but the
 *     framework is generic. The dispatch hook lives in the session step loop
 *     (prompt.ts); registered validators are evaluated when `finishReason`
 *     resolves to a non-tool stop.
 *   - A failed validator does not throw. It returns `{ok: false, ...}` and the
 *     framework inserts a synthetic user message describing the gap. The loop
 *     continues with that message in context; the model gets one more turn to
 *     fix the issue. A retry budget prevents runaway loops.
 *
 * Generalisable: this is not a dbt-specific change. The hook fires for every
 * session regardless of workload; per-validator `appliesTo()` decides whether
 * a given validator is relevant. New domains plug in by registering more
 * validators — no change to the framework or hook.
 */

/**
 * Context passed to a validator. Intentionally minimal — validators are
 * expected to read the world (filesystem, manifest, warehouse) themselves
 * rather than rely on session-internal state. This keeps validators
 * deployable as standalone tools later if needed.
 */
export interface ValidatorContext {
  /** Stable session identifier; used in telemetry. */
  sessionID: string

  /** The worktree root the agent has been operating in. Most validators
   *  need this to read manifest.json, schema.yml, or run subprocess CLIs. */
  workingDirectory: string

  /** Wall-clock millis when the session started. Validators that care about
   *  "was this touched in this session" (e.g., file mtime > sessionStartMs)
   *  use this. */
  sessionStartMs: number

  /** Step number this validator pass runs on (1-indexed). Useful for
   *  validators that want to behave differently on retry vs first fire. */
  step: number

  /** Number of validator-driven retries the session has already done. The
   *  framework enforces the global max retry budget; this is informational
   *  for validators that want to escalate the synthetic message wording. */
  retryCount: number
}

/**
 * Result of running a validator against a session context.
 */
export interface ValidatorResult {
  /** `true` means the agent's work passes this check. */
  ok: boolean

  /** Short human-readable explanation of what's wrong. Surfaced in the
   *  synthetic user message; should fit on one or two lines. */
  reason?: string

  /** Concrete next step the agent should take. Surfaced in the synthetic
   *  message verbatim. */
  fixHint?: string

  /** Structured detail for telemetry; not surfaced to the agent unless the
   *  validator explicitly includes it in `reason`/`fixHint`. */
  details?: Record<string, unknown>
}

/**
 * A validator declaration. Validators are registered via the registry at
 * module load time (or test setup) and dispatched by the framework.
 */
export interface Validator {
  /** Stable identifier; used in telemetry and to deduplicate registrations. */
  name: string

  /** One-sentence description. Surfaced in logs and telemetry. */
  description: string

  /** Decides whether this validator is relevant to the current session.
   *  Should return quickly — called on every validator pass. Examples:
   *  detect `dbt_project.yml` in worktree for dbt validators; detect SQL
   *  files edited this session for sql validators. */
  appliesTo(ctx: ValidatorContext): boolean | Promise<boolean>

  /** Actually run the check. May read files, spawn subprocesses, hit the
   *  warehouse — whatever the validator needs to determine if the agent's
   *  declared work is correct. Should not throw; expected failures return
   *  `ok: false` with a reason. Unexpected failures (validator itself
   *  errored) bubble as thrown exceptions and the framework converts them
   *  into a non-fatal log + skip. */
  check(ctx: ValidatorContext): Promise<ValidatorResult>
}
// altimate_change end

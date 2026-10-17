import { Effect, Semaphore } from "effect"
import { openSetupLock } from "#sqlite"

/**
 * Cross-process mutex for first-run database setup (WAL switch and migrations).
 *
 * SQLite cannot queue a deferred read-to-write upgrade, so concurrent fresh starts failed at once with
 * "database is locked". An exclusive transaction on a sentinel database next to the real one serializes
 * them, and the OS releases it if the holder dies.
 *
 * `acquireSync` blocks the thread, so it is only for sections that never yield. A section that yields
 * (the effect-based migration) uses `hold`, which polls without blocking. A synchronous caller in the
 * same process as an active `hold` skips the lock: blocking would deadlock the holder, and connections
 * in one process already queue through their own busy handlers.
 */
const semaphores = new Map<string, Semaphore.Semaphore>()
const active = new Set<string>()

const sentinel = (filename: string) => filename + ".setup-lock"
const SYNC_TIMEOUT_MS = 60_000
const POLL_MS = 25
const HOLD_TIMEOUT_MS = 60_000

export function acquireSync(filename: string): () => void {
  if (filename === ":memory:" || active.has(filename)) return () => {}
  const lock = openSetupLock(sentinel(filename), SYNC_TIMEOUT_MS)
  try {
    lock.exec("BEGIN EXCLUSIVE")
  } catch (error) {
    lock.close()
    throw error
  }
  return () => {
    try {
      lock.exec("ROLLBACK")
    } finally {
      lock.close()
    }
  }
}

function isBusy(error: unknown) {
  return /locked|busy/i.test(error instanceof Error ? error.message : String(error))
}

/** Runs `body` holding the lock; waiting is async so in-process peers keep making progress. */
export function hold<A, E, R>(filename: string, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  if (filename === ":memory:") return body
  let semaphore = semaphores.get(filename)
  if (!semaphore) {
    semaphore = Semaphore.makeUnsafe(1)
    semaphores.set(filename, semaphore)
  }
  const acquire = Effect.gen(function* () {
    const started = Date.now()
    while (true) {
      const lock = openSetupLock(sentinel(filename), 0)
      const result = yield* Effect.try({ try: () => lock.exec("BEGIN EXCLUSIVE"), catch: (error) => error }).pipe(
        Effect.map(() => lock),
        Effect.catch((error) =>
          Effect.sync(() => lock.close()).pipe(
            Effect.flatMap(() =>
              isBusy(error) && Date.now() - started < HOLD_TIMEOUT_MS ? Effect.succeed(undefined) : Effect.die(error),
            ),
          ),
        ),
      )
      if (result) {
        active.add(filename)
        return result
      }
      yield* Effect.sleep(POLL_MS)
    }
  })
  const release = (lock: { exec: (sql: string) => void; close: () => void }) =>
    Effect.sync(() => {
      active.delete(filename)
      try {
        lock.exec("ROLLBACK")
      } finally {
        lock.close()
      }
    })
  return semaphore.withPermits(1)(Effect.acquireUseRelease(acquire, () => body, release))
}

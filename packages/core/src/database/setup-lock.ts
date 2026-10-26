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
/** How long to wait silently before telling the user why startup is stalled. */
export const WAIT_NOTICE_MS = 5_000

/** Overrides for tests; production callers use the defaults. */
export interface Options {
  /** Wait before printing the notice. */
  noticeAfterMs?: number
  /** Total wait before giving up. */
  timeoutMs?: number
  /** Receives the notice line. */
  notify?: (line: string) => void
}

// stderr, not stdout: `run --format json` consumers parse stdout.
const notifyStderr = (line: string) => void process.stderr.write(line + "\n")

export function waitNotice(filename: string) {
  return `Waiting for another altimate-code process to finish setting up the database (lock: ${sentinel(filename)})`
}

/** The notice is diagnostic only: a `notify` (or stderr write) that throws synchronously must not abort the database open. */
function announce(filename: string, options: Options) {
  try {
    ;(options.notify ?? notifyStderr)(waitNotice(filename))
  } catch {}
}

export function acquireSync(filename: string, options: Options = {}): () => void {
  if (filename === ":memory:" || active.has(filename)) return () => {}
  const timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS
  const noticeAfterMs = Math.min(options.noticeAfterMs ?? WAIT_NOTICE_MS, timeoutMs)
  // Block for the notice threshold first, then announce the wait and block for the remainder.
  const lock = openSetupLock(sentinel(filename), noticeAfterMs)
  try {
    try {
      lock.exec("BEGIN EXCLUSIVE")
    } catch (error) {
      if (!isBusy(error) || noticeAfterMs >= timeoutMs) throw error
      announce(filename, options)
      lock.exec(`PRAGMA busy_timeout = ${timeoutMs - noticeAfterMs}`)
      lock.exec("BEGIN EXCLUSIVE")
    }
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
export function hold<A, E, R>(
  filename: string,
  body: Effect.Effect<A, E, R>,
  options: Options = {},
): Effect.Effect<A, E, R> {
  if (filename === ":memory:") return body
  let semaphore = semaphores.get(filename)
  if (!semaphore) {
    semaphore = Semaphore.makeUnsafe(1)
    semaphores.set(filename, semaphore)
  }
  const timeoutMs = options.timeoutMs ?? HOLD_TIMEOUT_MS
  const noticeAfterMs = options.noticeAfterMs ?? WAIT_NOTICE_MS
  const acquire = Effect.gen(function* () {
    const started = Date.now()
    let noticed = false
    while (true) {
      const lock = openSetupLock(sentinel(filename), 0)
      const result = yield* Effect.try({ try: () => lock.exec("BEGIN EXCLUSIVE"), catch: (error) => error }).pipe(
        Effect.map(() => lock),
        Effect.catch((error) =>
          Effect.sync(() => lock.close()).pipe(
            Effect.flatMap(() =>
              isBusy(error) && Date.now() - started < timeoutMs ? Effect.succeed(undefined) : Effect.die(error),
            ),
          ),
        ),
      )
      if (result) {
        active.add(filename)
        return result
      }
      if (!noticed && Date.now() - started >= noticeAfterMs) {
        noticed = true
        announce(filename, options)
      }
      // `acquireUseRelease` makes `acquire` uninterruptible; no handle is open while sleeping, so cancel here.
      yield* Effect.interruptible(Effect.sleep(POLL_MS))
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

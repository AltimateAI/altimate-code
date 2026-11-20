/**
 * Waiting on work that a deadline or an abort signal may cut short. The drivers use it to cancel a
 * statement on the server once it is stopped; the savings checks use it to stop waiting on a connect.
 */

import { MAX_TIMER_MS } from "./query-timeout"

export type StopReason = "deadline" | "aborted"

export type Stopped<T> = { stopped?: undefined; value: T } | { stopped: StopReason }

/**
 * Waits for `work`, or until `deadlineMs` passes or `signal` aborts, whichever comes first. `onStop` runs
 * at the moment of the stop, before this returns, so work still in flight can see it. A stopped
 * `work` that fails later does not go unhandled. No deadline waits on the signal alone.
 */
export async function untilStopped<T>(
  work: Promise<T>,
  opts: { deadlineMs?: number; signal?: AbortSignal; onStop?: (why: StopReason) => void },
): Promise<Stopped<T>> {
  const { deadlineMs, signal } = opts
  let stopped: StopReason | undefined
  let wake: () => void = () => {}
  const stopping = new Promise<void>((resolve) => (wake = resolve))
  const halt = (why: StopReason) => {
    if (stopped) return
    stopped = why
    opts.onStop?.(why)
    wake()
  }
  const timer = deadlineMs === undefined ? undefined : setTimeout(() => halt("deadline"), Math.min(Math.max(0, deadlineMs), MAX_TIMER_MS))
  const onAbort = () => halt("aborted")
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const value = await Promise.race([work, stopping])
    if (stopped) {
      work.catch(() => {})
      return { stopped }
    }
    return { value: value as T }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

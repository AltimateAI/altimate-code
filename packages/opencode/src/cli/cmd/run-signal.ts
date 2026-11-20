// altimate_change start — fork-only: one delivery per signal when the npm wrapper forwards it
// Where node has no process.execve (Windows, older node), the npm wrapper spawns
// the binary and forwards termination signals to it. A signal sent to the
// process group (GNU `timeout`, `killpg`, tree-kill, a terminal's Ctrl-C) then
// reaches the binary twice: directly, and again through the forward. `run`
// reads a second signal as "exit now", so the pair would skip its shutdown
// flush. The wrapper says it forwards through ALTIMATE_WRAPPER_FORWARDS_SIGNALS;
// only then is one repeat of the same signal soon after a delivery dropped.

/** How soon after a delivery a repeat of the same signal is its forwarded copy. */
export const REPEAT_WINDOW_MS = 1_000

/** True when the npm wrapper forwards termination signals to this process. */
export function forwardedByWrapper(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALTIMATE_WRAPPER_FORWARDS_SIGNALS === "1"
}

/**
 * Wraps signal handlers so a forwarded copy of a signal is not a second
 * delivery. Without forwarding every signal is delivered, as before.
 */
export function coalescer(forwarded: boolean, now: () => number = Date.now) {
  const last = new Map<string, { at: number; repeated: boolean }>()
  return (signal: string, handle: () => void) => () => {
    if (forwarded) {
      const at = now()
      const previous = last.get(signal)
      if (previous && !previous.repeated && at - previous.at < REPEAT_WINDOW_MS) {
        previous.repeated = true
        return
      }
      last.set(signal, { at, repeated: false })
    }
    handle()
  }
}

export * as RunSignal from "./run-signal"
// altimate_change end

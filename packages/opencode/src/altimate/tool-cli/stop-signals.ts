// altimate_change - new file
// How long a stopped run may take to wind down (a warehouse query's cancel waits up to 30 s) before
// the process exits anyway.
const STOP_GRACE_MS = 40_000
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const

/** Runs `work` with a signal that SIGINT or SIGTERM aborts; a second signal, or a run that has not
 * wound down within the grace period, exits at once. */
export async function withStopSignals<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let forced: ReturnType<typeof setTimeout> | undefined
  const stop = (name: keyof typeof SIGNAL_EXIT) => {
    if (controller.signal.aborted) process.exit(SIGNAL_EXIT[name])
    controller.abort(new Error(`Stopped by ${name}.`))
    forced = setTimeout(() => process.exit(SIGNAL_EXIT[name]), STOP_GRACE_MS)
    forced.unref?.()
  }
  const onInt = () => stop("SIGINT")
  const onTerm = () => stop("SIGTERM")
  process.on("SIGINT", onInt)
  process.on("SIGTERM", onTerm)
  try {
    return await work(controller.signal)
  } finally {
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
    clearTimeout(forced)
  }
}

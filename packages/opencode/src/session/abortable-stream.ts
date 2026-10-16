function waitForStream<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  return Promise.race([pending, aborted]).finally(() => signal.removeEventListener("abort", onAbort))
}

/** Cancel even when provider setup, reads, or iterator cleanup ignore the signal. */
export async function* abortableStream<T>(open: () => Promise<AsyncIterable<T>>, signal: AbortSignal) {
  signal.throwIfAborted()
  const opening = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return open()
  }).then((stream) => stream[Symbol.asyncIterator]())
  let completed = false
  try {
    const iterator = await waitForStream(opening, signal)
    while (true) {
      const item = await waitForStream(iterator.next(), signal)
      signal.throwIfAborted()
      if (item.done) {
        completed = true
        return
      }
      yield item.value
    }
  } finally {
    // An async generator may queue return() behind its stalled next().
    // Release it when possible without delaying session cleanup or finalization.
    if (!completed) void opening.then((iterator) => iterator.return?.()).catch(() => {})
  }
}

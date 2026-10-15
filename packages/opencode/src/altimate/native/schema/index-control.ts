export const DEFAULT_INDEX_TIMEOUT_MS = 30_000

export async function withIndexSignal<T>(
  options: { signal?: AbortSignal; timeoutMs?: number },
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Schema indexing deadline exceeded.", "TimeoutError"))
  }, options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS)
  try {
    return await work(signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function awaitIndex<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return work()
      }),
      cancelled,
    ])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

// altimate_change start — bounded stderr capture for subprocess assertions.
import { Effect, Fiber, Stream } from "effect"

// UTF-16 code units, matching String.length and String.slice.
const STDERR_TAIL_CHARS = 64 * 1024

export const captureStderr = Effect.fn("CliStderr.capture")(function* (stream: ReadableStream<Uint8Array>) {
  let tail = ""
  let truncated = false
  const drain = yield* Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (cause) => new Error(`stderr stream error: ${String(cause)}`),
  }).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const text = tail + chunk
        truncated ||= text.length > STDERR_TAIL_CHARS
        tail = text.slice(-STDERR_TAIL_CHARS)
      }),
    ),
    Effect.tapError(Effect.logError),
    Effect.forkScoped,
  )

  return {
    // A bounded snapshot is sufficient for timeout diagnostics.
    tail: () => tail,
    // Negative assertions require EOF and all output. Fail closed if the drain
    // failed or the cap discarded an earlier error; inactivity proves neither.
    complete: Effect.gen(function* () {
      yield* Fiber.join(drain)
      if (truncated) return yield* Effect.fail(new Error("stderr capture truncated; cannot assert on complete output"))
      return tail
    }),
  }
})
// altimate_change end

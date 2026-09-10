// altimate_change start — incomplete stderr must never make a negative assertion pass.
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "./effect"
import { captureStderr } from "./cli-stderr"

it.effect("stderr waits for EOF even after a quiet interval", () =>
  Effect.gen(function* () {
    const pipe = new TransformStream<Uint8Array, Uint8Array>()
    const writer = pipe.writable.getWriter()
    const stderr = yield* captureStderr(pipe.readable)
    yield* Effect.promise(() => writer.write(new TextEncoder().encode("startup\n")))
    let complete = false
    const read = yield* stderr.complete.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          complete = true
        }),
      ),
      Effect.forkScoped,
    )
    // Advance the old 20ms quiet interval AND its 500ms partial-result fallback.
    yield* TestClock.adjust("1 second")
    expect(complete).toBe(false)
    yield* Effect.promise(() => writer.write(new TextEncoder().encode("background dependency install failed\n")))
    yield* Effect.promise(() => writer.close())
    expect(yield* Fiber.join(read)).toBe("startup\nbackground dependency install failed\n")
  }),
)

it.effect("stderr rejects truncated output even when the tail looks clean", () =>
  Effect.gen(function* () {
    const pipe = new TransformStream<Uint8Array, Uint8Array>()
    const writer = pipe.writable.getWriter()
    const stderr = yield* captureStderr(pipe.readable)
    for (const chunk of ["background dependency install failed\n", "a".repeat(64 * 1024), "b".repeat(64 * 1024)]) {
      yield* Effect.promise(() => writer.write(new TextEncoder().encode(chunk)))
    }
    yield* Effect.promise(() => writer.close())
    const result = yield* Effect.result(stderr.complete)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain("stderr capture truncated")
    expect(stderr.tail()).toBe("b".repeat(64 * 1024))
  }),
)

it.effect("stderr propagates pipe read failures", () =>
  Effect.gen(function* () {
    const stderr = yield* captureStderr(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("broken pipe"))
        },
      }),
    )
    const exit = yield* Effect.exit(stderr.complete)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("broken pipe")
  }),
)
// altimate_change end

import { expect, mock, spyOn, test } from "bun:test"
import { abortableStream } from "../../src/session/abortable-stream"

test("abort ends a pending read even when iterator cleanup stalls", async () => {
  const controller = new AbortController()
  const remove = spyOn(controller.signal, "removeEventListener")
  const reading = Promise.withResolvers<void>()
  const close = mock(() => new Promise<IteratorResult<string>>(() => {}))
  const stream: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        reading.resolve()
        return new Promise<IteratorResult<string>>(() => {})
      },
      return: close,
    }),
  }
  try {
    const pending = abortableStream(async () => stream, controller.signal).next()
    await reading.promise
    const reason = new Error("Generation cancelled")
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(close).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  } finally {
    remove.mockRestore()
  }
}, 1_000)

test("breaking consumption closes the iterator and removes the abort listener", async () => {
  const controller = new AbortController()
  const remove = spyOn(controller.signal, "removeEventListener")
  const closed = Promise.withResolvers<void>()
  async function* source() {
    try {
      yield "first"
      throw new Error("Consumption should have stopped")
    } finally {
      closed.resolve()
    }
  }
  try {
    for await (const value of abortableStream(async () => source(), controller.signal)) {
      expect(value).toBe("first")
      break
    }
    await closed.promise
    expect(controller.signal.aborted).toBe(false)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  } finally {
    remove.mockRestore()
  }
}, 1_000)

test("abort during opening closes a late iterator without reading from it", async () => {
  const controller = new AbortController()
  const opened = Promise.withResolvers<void>()
  const opening = Promise.withResolvers<AsyncIterable<string>>()
  const closed = Promise.withResolvers<void>()
  const next = mock(async () => ({ done: false as const, value: "late output" }))
  const pending = abortableStream(() => {
    opened.resolve()
    return opening.promise
  }, controller.signal).next()
  await opened.promise
  const reason = new Error("Opening cancelled")
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  opening.resolve({
    [Symbol.asyncIterator]: () => ({
      next,
      return: async () => {
        closed.resolve()
        return { done: true as const, value: undefined }
      },
    }),
  })
  await closed.promise
  expect(next).not.toHaveBeenCalled()
}, 1_000)

test("an already aborted signal never opens the provider", async () => {
  const controller = new AbortController()
  const reason = new Error("Already cancelled")
  controller.abort(reason)
  const open = mock(async function* () {
    yield "unused"
  })
  await expect(abortableStream(async () => open(), controller.signal).next()).rejects.toBe(reason)
  expect(open).not.toHaveBeenCalled()
})

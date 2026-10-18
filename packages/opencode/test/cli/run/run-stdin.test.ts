import { describe, expect, test } from "bun:test"
import { readRunStdin, type StdinSource } from "../../../src/altimate/cli/run-stdin"

const encoder = new TextEncoder()

/** A stdin whose stream yields `chunks`, each after `delayMs`, then ends unless `open` is set. */
function source(opts: { chunks?: string[]; delayMs?: number; open?: boolean; file?: string }): StdinSource & {
  cancelled: () => boolean
} {
  let cancelled = false
  return {
    cancelled: () => cancelled,
    isFile: () => opts.file !== undefined,
    readAll: async () => opts.file ?? "",
    stream: () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of opts.chunks ?? []) {
            await Bun.sleep(opts.delayMs ?? 0)
            if (cancelled) return
            controller.enqueue(encoder.encode(chunk))
          }
          if (!opts.open) controller.close()
        },
        cancel() {
          cancelled = true
        },
      }),
  }
}

describe("readRunStdin", () => {
  test("reads a file in full without the wait", async () => {
    const result = await readRunStdin(source({ file: "from a file\n" }), 10)
    expect(result).toEqual({ text: "from a file\n", timedOut: false })
  })

  test("reads piped text to EOF", async () => {
    const result = await readRunStdin(source({ chunks: ["hello ", "world\n"] }), 1000)
    expect(result).toEqual({ text: "hello world\n", timedOut: false })
  })

  test("keeps reading after the first chunk even past the wait", async () => {
    const result = await readRunStdin(source({ chunks: ["a", "b", "c"], delayMs: 30 }), 50)
    expect(result).toEqual({ text: "abc", timedOut: false })
  })

  test("an empty stdin that closes returns at once", async () => {
    const result = await readRunStdin(source({ chunks: [] }), 1000)
    expect(result).toEqual({ text: "", timedOut: false })
  })

  test("a stdin left open with no data gives up after the wait and releases the stream", async () => {
    const stdin = source({ chunks: [], open: true })
    const started = Date.now()
    const result = await readRunStdin(stdin, 50)
    expect(result).toEqual({ text: "", timedOut: true })
    expect(Date.now() - started).toBeLessThan(1000)
    await Bun.sleep(0)
    expect(stdin.cancelled()).toBe(true)
  })
})

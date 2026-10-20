import { describe, expect, test } from "bun:test"
import { readRunStdin, stdinWaitMs, STDIN_WAIT_MS, type StdinSource } from "../../../src/altimate/cli/run-stdin"

const encoder = new TextEncoder()

/** A socket stdin (unless `file` or `fifo` is set) whose stream yields `chunks` (the first at once, each later one after `delayMs`), then ends unless `open` is set. Its read-to-EOF path returns `file`, `fifo` or `late` after `readAllMs`. */
function source(opts: {
  chunks?: string[]
  delayMs?: number
  open?: boolean
  file?: string
  fifo?: string
  late?: string
  readAllMs?: number
}): StdinSource & {
  cancelled: () => boolean
} {
  let cancelled = false
  return {
    cancelled: () => cancelled,
    isFile: () => opts.file !== undefined,
    isSocket: () => opts.file === undefined && opts.fifo === undefined,
    readAll: () => Bun.sleep(opts.readAllMs ?? 0).then(() => opts.file ?? opts.fifo ?? opts.late ?? ""),
    stream: () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [i, chunk] of (opts.chunks ?? []).entries()) {
            if (i > 0) await Bun.sleep(opts.delayMs ?? 0)
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

  test("a shell pipeline (not a socket) is read to EOF however long its producer takes", async () => {
    const result = await readRunStdin(source({ fifo: "dbt build output\n", readAllMs: 60 }), 10)
    expect(result).toEqual({ text: "dbt build output\n", timedOut: false })
  })

  test("a socket is read to EOF when there is nothing else to run, however late it is written", async () => {
    const result = await readRunStdin(source({ chunks: [], open: true, late: "the prompt\n", readAllMs: 60 }), 10, false)
    expect(result).toEqual({ text: "the prompt\n", timedOut: false })
  })

  test("a wait of 0 reads a socket to EOF", async () => {
    const result = await readRunStdin(source({ chunks: [], open: true, late: "late\n", readAllMs: 60 }), 0)
    expect(result).toEqual({ text: "late\n", timedOut: false })
  })

  test("reads piped text to EOF", async () => {
    const result = await readRunStdin(source({ chunks: ["hello ", "world\n"] }), 1000)
    expect(result).toEqual({ text: "hello world\n", timedOut: false })
  })

  test("keeps reading after the first chunk even past the wait", async () => {
    // The first chunk is immediate, so only the later ones (160ms in all) outlast the 50ms wait.
    const result = await readRunStdin(source({ chunks: ["a", "b", "c"], delayMs: 80 }), 50)
    expect(result).toEqual({ text: "abc", timedOut: false })
  })

  test("an empty stdin that closes returns at once", async () => {
    const started = Date.now()
    const result = await readRunStdin(source({ chunks: [] }), 5000)
    expect(result).toEqual({ text: "", timedOut: false })
    expect(Date.now() - started).toBeLessThan(1000)
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

describe("stdinWaitMs", () => {
  test("defaults to the 3s wait, and ALTIMATE_RUN_STDIN_WAIT_MS overrides it", () => {
    expect(stdinWaitMs({})).toBe(STDIN_WAIT_MS)
    expect(stdinWaitMs({ ALTIMATE_RUN_STDIN_WAIT_MS: "10000" })).toBe(10000)
    expect(stdinWaitMs({ ALTIMATE_RUN_STDIN_WAIT_MS: " 0 " })).toBe(0)
  })

  test("an unusable value keeps the default", () => {
    for (const raw of ["", "  ", "soon", "-1", "Infinity"])
      expect(stdinWaitMs({ ALTIMATE_RUN_STDIN_WAIT_MS: raw })).toBe(STDIN_WAIT_MS)
  })
})

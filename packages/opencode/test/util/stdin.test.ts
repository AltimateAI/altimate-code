import { describe, expect, test } from "bun:test"
import { readStdinIfAvailable, assembleStdinMessage } from "../../src/util/stdin"

const fifo = { isFIFO: () => true, isFile: () => false, isSocket: () => false }
const file = { isFIFO: () => false, isFile: () => true, isSocket: () => false }
const sock = { isFIFO: () => false, isFile: () => false, isSocket: () => true }
const charDev = { isFIFO: () => false, isFile: () => false, isSocket: () => false }

describe("readStdinIfAvailable", () => {
  test("returns empty when stdin is a TTY (no fstat, no read)", async () => {
    let read = false
    const out = await readStdinIfAvailable({
      isTTY: true,
      fstat: () => {
        throw new Error("fstat should not run when isTTY")
      },
      readStdin: async () => {
        read = true
        return "should not happen"
      },
    })
    expect(out).toBe("")
    expect(read).toBe(false)
  })

  test("returns empty for `< /dev/null` (character device — neither FIFO, file, nor socket)", async () => {
    let read = false
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => charDev,
      readStdin: async () => {
        read = true
        return "should not happen"
      },
    })
    expect(out).toBe("")
    expect(read).toBe(false)
  })

  test("returns empty when fstat throws (e.g. EBADF — fd 0 not open)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => {
        throw new Error("EBADF")
      },
      readStdin: async () => "should not happen",
    })
    expect(out).toBe("")
  })

  // MAJOR-regression: `echo ctx | run "prompt"` must still deliver "ctx".
  test("returns piped data when stdin is a FIFO with available bytes", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "context data",
    })
    expect(out).toBe("context data")
  })

  test("returns redirected file contents (run < file.txt)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => file,
      readStdin: async () => "from-file",
    })
    expect(out).toBe("from-file")
  })

  // m1 fix: sockets are now accepted (used by process supervisors, socket
  // activation, `nc -l`). Pre-fix the helper silently skipped them.
  test("accepts socket-backed stdin (process supervisors, socket activation, nc -l)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => sock,
      readStdin: async () => "via-socket",
    })
    expect(out).toBe("via-socket")
  })

  // M1-regression: timed-out wait must propagate as "" (no orphan, no wedge).
  test("returns empty when readStdin times out (idle inherited FIFO)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "", // simulates first-byte timeout
    })
    expect(out).toBe("")
  })

  // M2-regression: a producer that takes >100ms total but flushes its first
  // byte inside the window must NOT be truncated. The helper trusts readStdin
  // to wait for EOF after first byte; we verify the no-truncation contract by
  // injecting a readStdin that resolves slowly with full content.
  test("returns full content from slow-but-pre-timeout producer", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: () => new Promise<string>((r) => setTimeout(() => r("ctx after 80ms"), 80)),
      timeoutMs: 100,
    })
    expect(out).toBe("ctx after 80ms")
  })

  test("returns empty for FIFO with immediate EOF (empty pipe)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "",
    })
    expect(out).toBe("")
  })

  test("returns whitespace-only stdin verbatim (caller decides to trim)", async () => {
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "   \n\t  ",
    })
    expect(out).toBe("   \n\t  ")
  })
})

describe("assembleStdinMessage", () => {
  // MAJOR-regression from PR #935: positional must NOT silently override stdin.
  test("concatenates positional + stdin with newline", () => {
    expect(assembleStdinMessage("summarize:", "context data")).toBe("summarize:\ncontext data")
  })

  test("returns stdin when positional is empty", () => {
    expect(assembleStdinMessage("", "stdin only")).toBe("stdin only")
  })

  test("returns positional when stdin is empty", () => {
    expect(assembleStdinMessage("msg", "")).toBe("msg")
  })

  test("ignores whitespace-only stdin", () => {
    expect(assembleStdinMessage("msg", "  \n  ")).toBe("msg")
  })

  test("returns empty string when both are empty", () => {
    expect(assembleStdinMessage("", "")).toBe("")
  })
})

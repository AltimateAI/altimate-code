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
      warn: () => {}, // silence the stderr note in test output
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
      warn: () => {},
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

  // PR #937 / dev-punia review: `process.stdin` can be undefined in
  // embedded/child runtimes. The helper must not throw when accessing
  // `process.stdin.isTTY` in that case.
  test("returns empty when process.stdin is undefined (embedded/child runtime)", async () => {
    const original = process.stdin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process as any).stdin = undefined
    try {
      const out = await readStdinIfAvailable()
      expect(out).toBe("")
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process as any).stdin = original
    }
  })

  // Sury PR #935 review #2: silent drop is bad UX. When fd 0 looked like
  // real input but no first byte arrived, warn so the user knows.
  test("warns when stdin looked like input but readStdin returned empty (silent-drop fix)", async () => {
    const seen: string[] = []
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "",
      warn: (msg) => seen.push(msg),
    })
    expect(out).toBe("")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("stdin appears piped")
    expect(seen[0]).toContain("ALTIMATE_STDIN_TIMEOUT_MS")
  })

  test("does NOT warn when isTTY (no pipe to drop in the first place)", async () => {
    const seen: string[] = []
    const out = await readStdinIfAvailable({
      isTTY: true,
      readStdin: async () => "",
      warn: (msg) => seen.push(msg),
    })
    expect(out).toBe("")
    expect(seen).toHaveLength(0)
  })

  test("does NOT warn when fstat says char device (/dev/null) — intentional skip", async () => {
    const seen: string[] = []
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => charDev,
      readStdin: async () => "",
      warn: (msg) => seen.push(msg),
    })
    expect(out).toBe("")
    expect(seen).toHaveLength(0)
  })

  test("does NOT warn when stdin delivered data (no drop happened)", async () => {
    const seen: string[] = []
    const out = await readStdinIfAvailable({
      isTTY: false,
      fstat: () => fifo,
      readStdin: async () => "ctx",
      warn: (msg) => seen.push(msg),
    })
    expect(out).toBe("ctx")
    expect(seen).toHaveLength(0)
  })

  // Sury PR #935 review #2: env override for slow-pipeline users.
  test("ALTIMATE_STDIN_TIMEOUT_MS env override is forwarded to readStdin", async () => {
    const original = process.env["ALTIMATE_STDIN_TIMEOUT_MS"]
    process.env["ALTIMATE_STDIN_TIMEOUT_MS"] = "2500"
    let observed: number | undefined
    try {
      await readStdinIfAvailable({
        isTTY: false,
        fstat: () => fifo,
        readStdin: async (ms) => {
          observed = ms
          return "data"
        },
        warn: () => {},
      })
    } finally {
      if (original === undefined) delete process.env["ALTIMATE_STDIN_TIMEOUT_MS"]
      else process.env["ALTIMATE_STDIN_TIMEOUT_MS"] = original
    }
    expect(observed).toBe(2500)
  })

  test("ALTIMATE_STDIN_TIMEOUT_MS falls back to default when unparseable", async () => {
    const original = process.env["ALTIMATE_STDIN_TIMEOUT_MS"]
    process.env["ALTIMATE_STDIN_TIMEOUT_MS"] = "not-a-number"
    let observed: number | undefined
    try {
      await readStdinIfAvailable({
        isTTY: false,
        fstat: () => fifo,
        readStdin: async (ms) => {
          observed = ms
          return "data"
        },
        warn: () => {},
      })
    } finally {
      if (original === undefined) delete process.env["ALTIMATE_STDIN_TIMEOUT_MS"]
      else process.env["ALTIMATE_STDIN_TIMEOUT_MS"] = original
    }
    expect(observed).toBe(500)
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

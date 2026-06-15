import { describe, expect, test } from "bun:test"
import path from "path"

// The fixture imports the real helper and prints { result, elapsed } as JSON.
// Spawning it lets us exercise the actual `process.stdin` event path against
// real fd 0 conditions — something dependency injection can't cover.
const FIXTURE = path.join(__dirname, "stdin-fixture.ts")

type FileSink = { write(chunk: string | Uint8Array): number; end(): Promise<number> | number }

async function runFixture(opts: {
  writeStdin?: (sink: FileSink) => Promise<void>
  killAfterMs?: number
}): Promise<{ code: number | null; result?: string; elapsed?: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (opts.writeStdin) {
    await opts.writeStdin(proc.stdin as unknown as FileSink)
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined
  if (opts.killAfterMs) {
    killTimer = setTimeout(() => proc.kill(), opts.killAfterMs)
  }
  const code = await proc.exited
  if (killTimer) clearTimeout(killTimer)

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  try {
    const parsed = JSON.parse(stdout)
    return { code, result: parsed.result, elapsed: parsed.elapsed, stdout, stderr }
  } catch {
    return { code, stdout, stderr }
  }
}

describe("readStdinIfAvailable (spawned subprocess)", () => {
  // M1-regression — the canonical wedge: an inherited pipe that's never
  // written to and never closed. Pre-fix this hung forever; with the
  // previous Promise.race fix, the await released at 100ms but fd 0 stayed
  // open until the parent closed. With the first-byte event race + unref,
  // the child exits promptly.
  test(
    "exits promptly with empty result when stdin is an inherited-but-idle pipe",
    async () => {
      const { code, result, elapsed } = await runFixture({
        // Don't write — leave the pipe open and silent. Close after 1s so
        // the parent's writer isn't garbage-collected; by then the child
        // should have already exited via the first-byte timeout.
        writeStdin: async (sink) => {
          await new Promise((r) => setTimeout(r, 1000))
          try {
            await sink.end()
          } catch {}
        },
        killAfterMs: 5000,
      })
      expect(code).toBe(0)
      expect(result).toBe("")
      expect(elapsed).toBeLessThan(500)
    },
    10000,
  )

  // MAJOR-regression from PR #935: `echo ctx | run "prompt"` must still
  // deliver "ctx". Verified here by writing data + closing the pipe.
  test(
    "returns piped data when producer writes and closes",
    async () => {
      const { code, result } = await runFixture({
        writeStdin: async (sink) => {
          sink.write("context data")
          await sink.end()
        },
      })
      expect(code).toBe(0)
      expect(result).toBe("context data")
    },
    10000,
  )

  // M2-regression: a producer that takes >100ms to flush first byte was
  // truncated by the old Promise.race timeout. The first-byte gate must
  // accept the byte once it arrives and then drain the rest without a
  // deadline.
  test(
    "preserves data from slow producer (first byte arrives just before timeout)",
    async () => {
      const { code, result } = await runFixture({
        writeStdin: async (sink) => {
          // Sleep close to but under the 100ms first-byte budget, then
          // flush. The whole-stream-race fix would have returned "".
          await new Promise((r) => setTimeout(r, 60))
          sink.write("slow ctx")
          await sink.end()
        },
      })
      expect(code).toBe(0)
      expect(result).toBe("slow ctx")
    },
    10000,
  )

  // Negative control: a producer slow enough to miss the first-byte window
  // should yield "" (intentional cutoff, no truncation of in-flight data).
  test(
    "returns empty when first byte arrives after the first-byte timeout",
    async () => {
      const { code, result } = await runFixture({
        writeStdin: async (sink) => {
          await new Promise((r) => setTimeout(r, 400))
          try {
            sink.write("too late")
            await sink.end()
          } catch {}
        },
      })
      expect(code).toBe(0)
      expect(result).toBe("")
    },
    10000,
  )
})

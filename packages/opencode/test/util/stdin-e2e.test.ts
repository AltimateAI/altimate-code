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
        // Don't write — leave the pipe open and silent. Close after 3s so
        // the parent's writer isn't garbage-collected; by then the child
        // should have already exited via the 500ms first-byte timeout.
        writeStdin: async (sink) => {
          await new Promise((r) => setTimeout(r, 3000))
          try {
            await sink.end()
          } catch {}
        },
        killAfterMs: 8000,
      })
      expect(code).toBe(0)
      expect(result).toBe("")
      // 1500 = timeout (500ms) × 3 for CI scheduler headroom. Well under
      // "infinite hang" — the assertion guards the wedge fix, not perf.
      expect(elapsed).toBeLessThan(1500)
    },
    15000,
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

  // Sury PR #935 review #2: 500ms must cover realistic slow-first-byte
  // producers (DB queries that need to plan, decompression, network calls
  // with DNS+TLS handshake). 300ms is comfortably under the 500ms budget;
  // the previous 100ms config would have truncated this.
  test(
    "preserves data from slow producer (first byte arrives ~300ms after spawn)",
    async () => {
      const { code, result } = await runFixture({
        writeStdin: async (sink) => {
          await new Promise((r) => setTimeout(r, 300))
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
  // 1200ms > 500ms timeout with margin for CI scheduler latency.
  test(
    "returns empty when first byte arrives after the first-byte timeout",
    async () => {
      const { code, result } = await runFixture({
        writeStdin: async (sink) => {
          await new Promise((r) => setTimeout(r, 1200))
          try {
            sink.write("too late")
            await sink.end()
          } catch {}
        },
      })
      expect(code).toBe(0)
      expect(result).toBe("")
    },
    15000,
  )
})

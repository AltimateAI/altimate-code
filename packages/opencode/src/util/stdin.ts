import fs from "fs"
import type { Stats } from "fs"

const FIRST_BYTE_TIMEOUT_MS = 100

type Stat = Pick<Stats, "isFIFO" | "isFile" | "isSocket">

export interface ReadStdinDeps {
  isTTY?: boolean
  fstat?: () => Stat
  // Returns "" if no first byte arrives within timeoutMs; otherwise drains
  // stdin to EOF and returns the full content. Default implementation uses
  // process.stdin events so that a wedged-after-first-byte case still has a
  // well-defined behavior (waits for `end`); callers can inject a faster
  // implementation in tests.
  readStdin?: (timeoutMs: number) => Promise<string>
  timeoutMs?: number
}

// Read piped/redirected stdin without wedging on an inherited-but-idle fd.
//
// The failure mode this guards against: subprocess callers (Claude Code's
// Bash tool, Python `subprocess.run(..., stdin=None)`, CI, plugin hosts)
// leave stdin attached to a parent pipe that is never written to and never
// closed. A blind `Bun.stdin.text()` waits forever for an EOF that never
// arrives.
//
// Strategy — two gates:
//
//   1. fstat gate: only FIFOs (pipes), regular files (redirects), and
//      sockets (process supervisors, socket activation, `nc -l`) can carry
//      real input. TTYs and character devices (e.g. `< /dev/null`) skip.
//
//   2. First-byte timeout: instead of bounding the whole-stream drain, we
//      wait up to `timeoutMs` for the first readable byte. If no byte
//      arrives in that window, we treat stdin as inherited-idle and skip.
//      If a byte arrives, we drain to EOF without further deadline — so a
//      slow producer that takes >100ms total but flushes its first chunk
//      within the window is not truncated. This avoids the two pitfalls of
//      a whole-stream race: (a) the orphaned `Bun.stdin.text()` continuing
//      to hold fd 0 open after the loser is abandoned, and (b) silent
//      mid-stream truncation of legitimate slow / large producers.
export async function readStdinIfAvailable(deps: ReadStdinDeps = {}): Promise<string> {
  // `process.stdin` can be undefined in embedded / child runtimes (flagged
  // by dev-punia on PR #937). Treat absence as "no stdin to read."
  if (deps.isTTY === undefined && !process.stdin) return ""

  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY)
  const fstat = deps.fstat ?? (() => fs.fstatSync(0) as Stat)
  const readStdin = deps.readStdin ?? defaultReadStdin
  const timeoutMs = deps.timeoutMs ?? FIRST_BYTE_TIMEOUT_MS

  if (isTTY) return ""

  try {
    const stat = fstat()
    if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return ""
  } catch {
    return ""
  }

  return readStdin(timeoutMs)
}

// Compose the final prompt from a positional message and stdin input.
// Extracted as a pure function so the regression case from PR #935
// (`echo ctx | run "prompt"` must concatenate, not silently drop ctx) can
// be unit-tested without spawning the full run command.
export function assembleStdinMessage(positional: string, stdinInput: string): string {
  if (stdinInput.trim().length === 0) return positional
  if (positional.length === 0) return stdinInput
  return positional + "\n" + stdinInput
}

// Default implementation of the first-byte race over `process.stdin`.
//
// Why not `Bun.stdin.text()`: that reads the entire stream as a single
// uncancellable Promise. If we race it against a timer and the timer wins,
// the read still holds fd 0 open until the producer eventually closes,
// blocking process exit (the original wedge moved to teardown).
//
// Using `process.stdin` event listeners lets us:
//   - bind the timeout to "first byte" rather than "full drain", so slow
//     producers and large payloads aren't truncated;
//   - cleanly remove our listeners and `unref` the stream on the no-data
//     path, so an inherited-open fd doesn't pin the event loop.
function defaultReadStdin(timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const stdin = process.stdin
    const chunks: Buffer[] = []
    let firstByteReceived = false
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanup = () => {
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdin.off("error", onError)
      if (firstByteTimer) clearTimeout(firstByteTimer)
      try {
        stdin.pause()
      } catch {}
      try {
        stdin.unref?.()
      } catch {}
    }

    const settle = (result: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onData = (chunk: Buffer) => {
      if (!firstByteReceived) {
        firstByteReceived = true
        if (firstByteTimer) {
          clearTimeout(firstByteTimer)
          firstByteTimer = undefined
        }
      }
      chunks.push(chunk)
    }
    const onEnd = () => settle(Buffer.concat(chunks).toString("utf8"))
    const onError = () => settle(Buffer.concat(chunks).toString("utf8"))

    firstByteTimer = setTimeout(() => {
      if (!firstByteReceived) settle("")
    }, timeoutMs)

    stdin.on("data", onData)
    stdin.on("end", onEnd)
    stdin.on("error", onError)
    try {
      stdin.resume()
    } catch {
      settle("")
    }
  })
}

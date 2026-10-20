// altimate_change - new file
import { fstatSync } from "fs"

/** How long `run` waits for the first byte on a socket stdin. */
export const STDIN_WAIT_MS = 3000

/** `ALTIMATE_RUN_STDIN_WAIT_MS` overrides the wait, for a caller that writes its stdin late; 0 waits for EOF. */
export function stdinWaitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["ALTIMATE_RUN_STDIN_WAIT_MS"]?.trim()
  if (!raw) return STDIN_WAIT_MS
  const ms = Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : STDIN_WAIT_MS
}

export interface StdinSource {
  /** True when fd 0 is a regular file (`run < prompt.txt`), which always reaches EOF. */
  isFile(): boolean
  /** True when fd 0 is a socket: what an agent's shell tool or a Node `spawn` hands a child. A shell
   * pipeline (`cmd | altimate-code run`) is a FIFO instead. */
  isSocket(): boolean
  readAll(): Promise<string>
  stream(): ReadableStream<Uint8Array>
}

export const bunStdin: StdinSource = {
  isFile() {
    try {
      return fstatSync(0).isFile()
    } catch {
      return false
    }
  },
  isSocket() {
    try {
      return fstatSync(0).isSocket()
    } catch {
      return false
    }
  },
  readAll: () => Bun.stdin.text(),
  stream: () => Bun.stdin.stream(),
}

/**
 * Read text piped into `altimate-code run`, without waiting on a stdin that never sends anything.
 *
 * Agents that shell out to `run` (Claude Code's Bash tool, a Node `spawn` with default stdio) hand
 * it a socket they never write to or close. Reading that to EOF blocks forever, so a delegated task
 * hangs before it starts. A socket is read only if its first chunk arrives within `waitMs`, and then
 * to EOF. Anything else (a file, or a shell pipeline whose producer may take minutes, like
 * `dbt build | altimate-code run`) is read to EOF as before. So is a socket when `bounded` is false
 * (the caller passed nothing else to run, so stdin is the prompt) or `waitMs` is 0.
 */
export async function readRunStdin(
  source: StdinSource = bunStdin,
  waitMs: number = STDIN_WAIT_MS,
  bounded = true,
): Promise<{ text: string; timedOut: boolean }> {
  if (!bounded || waitMs <= 0 || source.isFile() || !source.isSocket())
    return { text: await source.readAll(), timedOut: false }
  const reader = source.stream().getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), waitMs)
      }),
    ])
    if (first === "timeout") return { text: "", timedOut: true }
    if (first.done) return { text: "", timedOut: false }
    const decoder = new TextDecoder()
    let text = decoder.decode(first.value, { stream: true })
    while (true) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
    return { text: text + decoder.decode(), timedOut: false }
  } finally {
    if (timer) clearTimeout(timer)
    // Releases the stream so an idle stdin does not keep the process alive after the run.
    reader.cancel().catch(() => {})
  }
}

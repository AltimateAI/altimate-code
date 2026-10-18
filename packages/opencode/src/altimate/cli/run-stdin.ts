import { fstatSync } from "fs"

/** How long `run` waits for the first byte on a stdin that is not a TTY or a file. */
export const STDIN_WAIT_MS = 3000

export interface StdinSource {
  /** True when fd 0 is a regular file (`run < prompt.txt`), which always reaches EOF. */
  isFile(): boolean
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
  readAll: () => Bun.stdin.text(),
  stream: () => Bun.stdin.stream(),
}

/**
 * Read text piped into `altimate-code run`, without waiting on a stdin that never sends anything.
 *
 * Agents that shell out to `run` (Claude Code's Bash tool, a Node `spawn` with default stdio) hand
 * it a pipe or socket they never write to or close. Reading that to EOF blocks forever, so a
 * delegated task hangs before it starts. A file is read in full; any other stdin is read only if
 * its first chunk arrives within `waitMs`, and then to EOF.
 */
export async function readRunStdin(
  source: StdinSource = bunStdin,
  waitMs: number = STDIN_WAIT_MS,
): Promise<{ text: string; timedOut: boolean }> {
  if (source.isFile()) return { text: await source.readAll(), timedOut: false }
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

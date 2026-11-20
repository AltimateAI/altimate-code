import { NamedError } from "@opencode-ai/core/util/error"
import type { Log } from "@/util/log"

// What the server's catch-all error handlers send back. For an error they don't recognise, a fixed message and a
// ref, as the HttpApi error middleware answers (httpapi/middleware/error.ts): never the error's own text, stack or
// file paths. The full error is logged server-side under the same ref.

/** HTTP status for an error the handlers know by name: a remote the server depends on failed (502). */
export function upstreamStatus(name: string): 502 | undefined {
  return name === "ConfigRemoteUnavailableError" ? 502 : undefined
}

// An indented `at …` line: how V8, JSC and Bun print every stack frame, with or without a source location
// (`at new Promise (<anonymous>)`, `at async Promise.all (index 0)`).
const FRAME = /^\s+at\s/

export const UNEXPECTED = "Unexpected server error. Check server logs for details."

/**
 * An error's message without stack-frame lines (some errors carry frames in the message itself), for a client
 * that has to tell a user why their own request failed, such as a session's error event.
 */
export function clientMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw
    .split("\n")
    .filter((line) => !FRAME.test(line))
    .join("\n")
    .trim()
  return message || UNEXPECTED
}

/** The response body for an error no handler recognises, logged in full under a ref that the body carries. */
export function unknownErrorBody(log: Log.Logger, err: unknown) {
  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
  log.error("unexpected error", { ref, error: err })
  return new NamedError.Unknown({ message: UNEXPECTED, ref }).toObject()
}

import { NamedError } from "@opencode-ai/core/util/error"

// What the server's error handlers send back. For an error they don't recognise, a fixed message and a ref: never
// the error's own text, stack or file paths. Each handler logs the full error once, under the same ref.

/** HTTP status for an error the handlers know by name: a remote the server depends on failed (502). */
export function upstreamStatus(name: string): 502 | undefined {
  return name === "ConfigRemoteUnavailableError" ? 502 : undefined
}

// An indented `at …` line: how V8, JSC and Bun print every stack frame, with or without a source location
// (`at new Promise (<anonymous>)`, `at async Promise.all (index 0)`).
const FRAME = /^\s+at\s/

export const UNEXPECTED = "Unexpected server error. Check server logs for details."

/** A reference for one failure: the handler logs the error under it, and an unknown error's response carries it. */
export function errorRef(): string {
  return `err_${crypto.randomUUID().slice(0, 8)}`
}

/** A NamedError keeps its text in `data.message`; its own `message` is only its name. */
function namedErrorMessage(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("data" in err)) return undefined
  const data = (err as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return undefined
  const message = (data as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}

/**
 * An error's message without stack-frame lines (some errors carry frames in the message itself), for a client
 * that has to tell a user why their own request failed, such as a session's error event.
 */
export function clientMessage(err: unknown): string {
  const raw = namedErrorMessage(err) ?? (err instanceof Error ? err.message : String(err))
  const message = raw
    .split("\n")
    .filter((line) => !FRAME.test(line))
    .join("\n")
    .trim()
  return message || UNEXPECTED
}

/** The response body for an error no handler recognises: the fixed message and the ref it was logged under. */
export function unknownErrorBody(ref: string) {
  return new NamedError.Unknown({ message: UNEXPECTED, ref }).toObject()
}

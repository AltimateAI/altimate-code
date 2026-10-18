import { Telemetry } from "./index"

const MAX_MESSAGE = 200
const PLACEHOLDER = "<x>"
const PEEL = /^([:,.()'"\-?!]*)(.*?)([:,.()'"\-?!]*)$/
const WORD = /^(?:[a-z]{1,24}|[A-Z][a-z]{0,23}|[A-Z]{1,3})$/
const SENTENCE_STARTERS = new Set([
  "error",
  "cannot",
  "can",
  "could",
  "failed",
  "failure",
  "unable",
  "invalid",
  "unknown",
  "missing",
  "no",
  "not",
  "the",
  "a",
  "an",
  "permission",
  "access",
  "connection",
  "timeout",
  "request",
  "query",
  "command",
  "file",
  "table",
  "column",
  "unexpected",
  "expected",
  "syntax",
  "authentication",
  "operation",
  "http",
  "tool",
  "bad",
  "login",
  "user",
  "this",
  "it",
  "there",
  "too",
  "failed",
])
const CREDENTIAL_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "key",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "apikey",
  "bearer",
])
const CREDENTIAL_SPAN = 2

/**
 * Allowlist template of an error's first line. Only short plain-letter words and
 * a little punctuation survive; every other token (digits, `_`, `/`, `.` inside,
 * `@`, `=`, quoted content, capitalized names) becomes `<x>`. English-like words
 * that happen to spell a SQL statement are not recognised and can survive.
 */
export function templateErrorMessage(raw: string): string {
  const first = raw
    .split(/[\r\n]/, 1)[0]
    .replace(/'[^']*'|"[^"]*"/g, ` ${PLACEHOLDER} `)
    .replace(/['"].*$/, ` ${PLACEHOLDER}`)
  const out: string[] = []
  let position = 0
  let secretSpan = 0
  let secretToEol = false
  for (const chunk of first.split(/\s+/)) {
    if (!chunk) continue
    if (chunk === PLACEHOLDER) {
      out.push(PLACEHOLDER)
      position++
      continue
    }
    const [, lead, core, trail] = PEEL.exec(chunk)!
    // the tokens after a credential keyword are values, however plain they look
    if (secretSpan > 0 && core !== "") {
      out.push(lead + PLACEHOLDER + trail)
      position++
      secretSpan = secretToEol ? 1 : /[,.)!?]/.test(trail) ? 0 : secretSpan - 1
      continue
    }
    if (
      core
        .toLowerCase()
        .split(/[_\-.]/)
        .some((part) => CREDENTIAL_WORDS.has(part))
    ) {
      secretSpan = CREDENTIAL_SPAN
      // `label: value` / `label=value`: the value may be a multi-word passphrase, so mask to end of line
      secretToEol = /[:=]/.test(trail) || /[:=]/.test(lead)
    }
    const plainWord = WORD.test(core) && !(core.length > 3 && core === core.toUpperCase())
    const lower = core.toLowerCase()
    const name = /^[A-Z]/.test(core) && (position > 0 || !(SENTENCE_STARTERS.has(lower) || CREDENTIAL_WORDS.has(lower)))
    out.push(core === "" || (plainWord && !name) ? chunk : lead + PLACEHOLDER + trail)
    position++
  }
  return out
    .join(" ")
    .replace(/<x>(?:[:,.()'"\-?!]*\s+<x>)+/g, PLACEHOLDER)
    .slice(0, MAX_MESSAGE)
}

/** Hash input is unchanged from before the detail fields existed, so fingerprints stay stable. */
export function describeToolError(raw: string) {
  return {
    errorHash: Telemetry.hashError(Telemetry.maskString(raw).slice(0, 500)),
    errorMessage: templateErrorMessage(raw),
  }
}

export function buildErrorFingerprintEvent(
  sessionID: string,
  err: {
    errorHash: string
    errorClass: string
    toolName: string
    toolCategory: string
    errorMessage: string
    recovered: boolean
    recoveryTool: string
  },
): Telemetry.Event {
  return {
    type: "error_fingerprint",
    timestamp: Date.now(),
    session_id: sessionID,
    error_hash: err.errorHash,
    error_class: err.errorClass,
    tool_name: err.toolName,
    tool_category: err.toolCategory,
    error_message: err.errorMessage,
    recovery_successful: err.recovered,
    recovery_tool: err.recoveryTool,
  }
}

export * as ErrorDetail from "./error-detail"

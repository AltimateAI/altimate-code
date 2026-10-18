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
// A token with a part starting with one of these stems (password, passphrase, client_secret,
// access_token=..., apikey, Authorization, ...) ends the readable part of the line.
const CREDENTIAL_STEMS = ["pass", "pwd", "secret", "token", "key", "auth", "credential", "bearer", "cookie", "session"]
const isCredential = (token: string) =>
  token
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((part) => CREDENTIAL_STEMS.some((stem) => part.startsWith(stem)))

/**
 * Allowlist template of an error's first line. Only short plain-letter words and
 * a little punctuation survive; every other token (digits, `_`, `/`, `.` inside,
 * `@`, `=`, quoted content, capitalized names) becomes `<x>`. English-like words
 * that happen to spell a SQL statement are not recognised and can survive.
 */
// The line is cut at the token holding the first of: a credential stem (also inside quotes or a
// compound key), a path separator, or an escape. Everything from there on is masked, because a
// value, path or escaped string can run on past whitespace and quote boundaries.
const CUT = new RegExp(`${CREDENTIAL_STEMS.join("|")}|[\\\\/]`, "i")

function cutAtUnsafe(line: string): string {
  const hit = CUT.exec(line)
  if (!hit) return line
  const tokenStart = line.lastIndexOf(" ", hit.index) + 1
  const lead = line.slice(0, tokenStart)
  const token = line.slice(tokenStart).split(/\s/, 1)[0]
  const unquoted = token.replace(/['"]/g, "")
  const label = unquoted.replace(/[:=,]+$/, "")
  // keep a plain credential label (`password:`) so the shape stays readable
  return isCredential(label) && WORD.test(label) ? `${lead}${unquoted} ${PLACEHOLDER}` : `${lead}${PLACEHOLDER}`
}

export function templateErrorMessage(raw: string): string {
  const first = cutAtUnsafe(raw.split(/[\r\n]/, 1)[0])
    .replace(/'[^']*'|"[^"]*"/g, ` ${PLACEHOLDER} `)
    .replace(/['"].*$/, ` ${PLACEHOLDER}`)
  const out: string[] = []
  let position = 0
  for (const chunk of first.split(/\s+/)) {
    if (!chunk) continue
    if (chunk === PLACEHOLDER) {
      out.push(PLACEHOLDER)
      position++
      continue
    }
    const [, lead, core, trail] = PEEL.exec(chunk)!
    // everything after a credential label is a value, however plain it looks: mask to end of line
    if (isCredential(core)) {
      const label = WORD.test(core) ? lead + core + trail : lead + PLACEHOLDER + trail
      out.push(label, PLACEHOLDER)
      break
    }
    const plainWord = WORD.test(core) && !(core.length > 3 && core === core.toUpperCase())
    const lower = core.toLowerCase()
    const name = /^[A-Z]/.test(core) && (position > 0 || !SENTENCE_STARTERS.has(lower))
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

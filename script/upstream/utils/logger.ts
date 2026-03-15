// Colored logging utility using ANSI escape codes.
// No external dependencies — works directly with stdout/stderr.

export const RESET = "\x1b[0m"
export const BOLD = "\x1b[1m"
export const DIM = "\x1b[2m"

export const BLUE = "\x1b[34m"
export const YELLOW = "\x1b[33m"
export const RED = "\x1b[31m"
export const GREEN = "\x1b[32m"
export const GRAY = "\x1b[90m"
export const CYAN = "\x1b[36m"
export const MAGENTA = "\x1b[35m"

const MAX_LINE_WIDTH = 80

/** Truncate a string to maxLen, appending ellipsis if truncated. */
function truncate(str: string, maxLen: number = MAX_LINE_WIDTH): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + "\u2026"
}

// ── Formatting helpers ──────────────────────────────────────────────────────

export function bold(s: string): string { return `${BOLD}${s}${RESET}` }
export function dim(s: string): string { return `${DIM}${s}${RESET}` }
export function cyan(s: string): string { return `${CYAN}${s}${RESET}` }
export function green(s: string): string { return `${GREEN}${s}${RESET}` }
export function red(s: string): string { return `${RED}${s}${RESET}` }
export function yellow(s: string): string { return `${YELLOW}${s}${RESET}` }

export function banner(text: string): void {
  const line = "═".repeat(60)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${CYAN}  ${BOLD}${text}${RESET}`)
  console.log(`${CYAN}${line}${RESET}\n`)
}

// ── Logging functions ───────────────────────────────────────────────────────

/** Log an informational message. */
export function info(msg: string): void {
  console.log(`${BLUE}info${RESET}  ${msg}`)
}

/** Log a warning message. */
export function warn(msg: string): void {
  console.warn(`${YELLOW}warn${RESET}  ${msg}`)
}

/** Log an error message. */
export function error(msg: string): void {
  console.error(`${RED}error${RESET} ${msg}`)
}

/** Log a success message. */
export function success(msg: string): void {
  console.log(`${GREEN}ok${RESET}    ${msg}`)
}

/** Log a debug message (dimmed). */
export function debug(msg: string): void {
  console.log(`${GRAY}debug${RESET} ${DIM}${msg}${RESET}`)
}

/** Log a numbered step in a multi-step process. */
export function step(current: number, total: number, msg: string): void {
  const counter = `${CYAN}[${current}/${total}]${RESET}`
  console.log(`${counter} ${BOLD}${msg}${RESET}`)
}

/**
 * Display a file diff showing before/after changes.
 * Long lines are truncated to MAX_LINE_WIDTH characters.
 */
export function diff(
  file: string,
  changes: { line: number; before: string; after: string }[],
): void {
  if (changes.length === 0) return

  console.log(`\n${BOLD}${MAGENTA}--- ${file}${RESET}`)

  for (const change of changes) {
    const lineLabel = `${DIM}L${change.line}${RESET}`
    const before = truncate(change.before.trimEnd())
    const after = truncate(change.after.trimEnd())

    console.log(`  ${lineLabel}`)
    console.log(`  ${RED}- ${before}${RESET}`)
    console.log(`  ${GREEN}+ ${after}${RESET}`)
  }
}

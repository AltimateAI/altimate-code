import stripAnsi from "strip-ansi"

// JavaScript string lengths are UTF-16 code units, matching maskString's historical limits.
export const MAX_INPUT = 8192
export const LOOKAHEAD = 2048

/**
 * Shared bounded ANSI entry point with explicit compatibility profiles.
 * `legacy` preserves maskString's 7-bit rules and existing lookahead window, so hashes
 * do not change. `template` handles the broader strip-ansi grammar on the original first
 * line. An oversized first line returns undefined: callers must redact the whole line,
 * rather than emit a prefix whose ANSI sequence or credential marker may have been cut.
 */
export function normalize(raw: string, profile: "legacy"): string
export function normalize(raw: string, profile: "template"): string | undefined
export function normalize(raw: string, profile: "legacy" | "template"): string | undefined {
  if (profile === "legacy") {
    // maskString already supplies at most MAX_INPUT + LOOKAHEAD code units. Keep this
    // historical regex frozen; adopting the template profile here would change hashes.
    return raw
      .slice(0, MAX_INPUT + LOOKAHEAD)
      .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "")
  }
  // One extra code unit distinguishes an exact-limit line followed by a newline from
  // an oversized line. Never scan the unbounded input or strip across a line boundary.
  const first = raw.slice(0, MAX_INPUT + 1).split(/[\r\n\u2028\u2029]/, 1)[0]
  if (first.length > MAX_INPUT) return undefined
  return stripAnsi(first)
}

export * as Ansi from "./ansi"

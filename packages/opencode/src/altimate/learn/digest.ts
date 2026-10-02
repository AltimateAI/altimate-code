// altimate_change - new file
//
// Builds the compact, secret-redacted text view of a finished session that the
// reflector reads. Two sources: a live session's messages, or a trajectory JSON
// produced by `altimate-code trajectory export` (for sessions recorded under
// another project directory).
import type { MessageV2 } from "../../session/message-v2"

export const DIGEST_CAP = 24_000
const INPUT_CAP = 300
const OUTPUT_CAP = 400
const PROMPT_CAP = 2_000
const FINAL_CAP = 3_000
const FILES_CAP = 1_500

export interface DigestCall {
  name: string
  input: unknown
  output?: string
  error?: string
}

export interface DigestSource {
  prompts: string[]
  calls: DigestCall[]
  finalText?: string
}

// --- secret handling (shared with the curator's lint) ---

const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /(:\/\/[^\s/:@]+:)[^\s/@]+(@)/g,
  /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
]

// Linear by construction: no unbounded prefix before the keyword alternation (the text before the
// keyword stays outside the match and is kept as is), bounded key suffix and separator, and every value
// branch consumes at least one character on success, so a failed attempt never rescans the input.
const ASSIGNMENT =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,40})(["']?\s{0,20}[=:]\s{0,20})(?:\[REDACTED\]|\{(?:[^}]|}})*(?:\}|$)|"[^"\n]*"?|'[^'\n]*'?|[^\s,;"'}\])]+)/gi

// Cover both separated/equals forms and the short options' attached values (mysql -psecret).
const CREDENTIAL_ARGUMENT =
  /((?:^|[\s("'`])(?:-[pP](?:[ \t]*=[ \t]*|[ \t]+)?|--(?:password|token|secret|api-key)(?:[ \t]*=[ \t]*|[ \t]+)))(?:\[REDACTED\]|"[^"\n]*"?|'[^'\n]*'?|[^\s,;"'`}\])]+)/gi
const SENSITIVE_FIELD = /^(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)$/i

/** Raw characters of a tool input that are considered before it is redacted and clipped for display. */
const INPUT_READ_CAP = 4_000

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const CANDIDATE = /[A-Za-z0-9+/=_-]{20,}/g

function isHighEntropy(token: string): boolean {
  // Identifiers like `stg_stripe__payments_amount_cents` are long but lowly
  // random; judge snake/kebab-case tokens per segment so they are not flagged.
  const segments = token.split(/[_-]+/).filter(Boolean)
  const parts = segments.length > 1 ? segments : [token]
  return parts.some((p) => p.length >= 20 && /\d/.test(p) && /[A-Za-z]/.test(p) && entropy(p) >= 3.5)
}

export function hasHighEntropyToken(text: string): boolean {
  for (const m of text.matchAll(CANDIDATE)) if (isHighEntropy(m[0])) return true
  return false
}

export function hasSecretPattern(text: string): boolean {
  for (const re of TOKEN_PATTERNS) if (new RegExp(re.source, re.flags.replace("g", "")).test(text)) return true
  return [ASSIGNMENT, CREDENTIAL_ARGUMENT].some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text))
}

export function redactSecrets(text: string): string {
  let out = text
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m, a?: string, b?: string) =>
      re.source.startsWith("(:") ? `${a}[REDACTED]${b}` : "[REDACTED]",
    )
  }
  out = out.replace(CREDENTIAL_ARGUMENT, (_m, option: string) => `${option}[REDACTED]`)
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`)
  return out.replace(CANDIDATE, (t) => (isHighEntropy(t) ? "[REDACTED]" : t))
}

// --- digest ---

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}… [+${flat.length - max} chars]`
}

function clipBlock(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n… [+${t.length - max} chars]`
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v
  try {
    // Redact string fields before JSON escaping, which otherwise splits quoted command arguments.
    return JSON.stringify(v, (key, value) => SENSITIVE_FIELD.test(key)
      ? "[REDACTED]"
      : typeof value === "string" ? redactSecrets(value.slice(0, INPUT_READ_CAP)) : value) ?? ""
  } catch {
    return String(v)
  }
}

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"])

function writtenFiles(calls: DigestCall[]): string[] {
  const files = new Set<string>()
  for (const c of calls) {
    if (!WRITE_TOOLS.has(c.name)) continue
    const input = (c.input ?? {}) as Record<string, unknown>
    for (const key of ["filePath", "file_path", "path"])
      if (typeof input[key] === "string") files.add(input[key] as string)
    const patch = typeof input.patchText === "string" ? input.patchText : typeof input.patch === "string" ? input.patch : ""
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.add(m[1].trim())
  }
  return [...files]
}

export function buildDigest(src: DigestSource, cap = DIGEST_CAP): string {
  const prompts = src.prompts.map((p) => redactSecrets(clipBlock(p, PROMPT_CAP)))
  const files = redactSecrets(
    clipBlock(
      writtenFiles(src.calls)
        .map((f) => `- ${f}`)
        .join("\n"),
      FILES_CAP,
    ),
  )
  const final = src.finalText ? redactSecrets(clipBlock(src.finalText, FINAL_CAP)) : ""

  const lines = src.calls.map((c, i) => {
    const input = clip(redactSecrets(stringify(c.input).slice(0, INPUT_READ_CAP)), INPUT_CAP)
    const result = c.error !== undefined ? `ERROR: ${clip(c.error, OUTPUT_CAP)}` : clip(c.output ?? "", OUTPUT_CAP)
    return `${i + 1}. ${redactSecrets(c.name)}(${input}) → ${redactSecrets(result)}`
  })

  const head = ["## User request", ...(prompts.length ? prompts : ["(none)"]), ""].join("\n")
  const tail = [
    "",
    "## Files written or edited",
    files || "(none)",
    "",
    "## Final assistant message",
    final || "(none)",
  ].join("\n")
  const budget = Math.max(0, cap - head.length - tail.length - 64)

  let body = lines.join("\n")
  if (body.length > budget) {
    // Keep the start and the end of the run; the middle is the least informative.
    const half = Math.floor(budget / 2)
    let a = 0
    let used = 0
    while (a < lines.length && used + lines[a].length + 1 <= half) used += lines[a++].length + 1
    let b = lines.length
    used = 0
    while (b > a && used + lines[b - 1].length + 1 <= half) used += lines[--b].length + 1
    body = [...lines.slice(0, a), `… [${b - a} tool calls omitted]`, ...lines.slice(b)].join("\n")
  }
  const calls = `## Tool calls (${lines.length})\n${body || "(none)"}\n`
  return [head, calls, tail].join("\n").slice(0, cap)
}

export function sourceFromMessages(messages: MessageV2.WithParts[]): DigestSource {
  const prompts: string[] = []
  const calls: DigestCall[] = []
  let finalText: string | undefined
  for (const msg of messages) {
    if (msg.info.role === "user") {
      const text = msg.parts
        .flatMap((p) => (p.type === "text" && !p.synthetic && !p.ignored ? [p.text] : []))
        .join("\n")
        .trim()
      if (text) prompts.push(text)
      continue
    }
    if (msg.info.role !== "assistant") continue
    const text = msg.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n")
      .trim()
    if (text) finalText = text
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const st = part.state
      calls.push({
        name: part.tool,
        input: st.status === "pending" ? undefined : st.input,
        output: st.status === "completed" ? st.output : undefined,
        error: st.status === "error" ? st.error : undefined,
      })
    }
  }
  return { prompts, calls, finalText }
}

/** Reads the `trajectory export` shape. Tolerant: unknown or missing fields are skipped. */
export function sourceFromTrajectory(json: unknown): DigestSource {
  const root = (json ?? {}) as Record<string, unknown>
  if (!Array.isArray(root.steps)) throw new Error("Not a trajectory export: missing `steps` array.")
  const prompts = Array.isArray(root.user_prompts) ? root.user_prompts.filter((p): p is string => typeof p === "string") : []
  const calls: DigestCall[] = []
  let finalText: string | undefined
  for (const raw of root.steps) {
    const step = (raw ?? {}) as Record<string, unknown>
    if (typeof step.text === "string" && step.text.trim()) finalText = step.text
    for (const tc of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      const c = (tc ?? {}) as Record<string, unknown>
      calls.push({
        name: String(c.name ?? "unknown"),
        input: c.input,
        output: typeof c.output === "string" ? c.output : undefined,
        error: typeof c.error === "string" ? c.error : undefined,
      })
    }
  }
  return { prompts, calls, finalText }
}

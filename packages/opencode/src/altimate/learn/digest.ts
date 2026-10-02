// altimate_change - new file
//
// Security posture: the reflector defaults to the provider that already received the full session;
// input redaction is defense in depth. The playbook is the boundary: learn promote shows a diff and
// asks for confirmation unless --yes, and reaching the team also requires an explicit publish.
// Redaction and lint are best-effort guard rails for common forms; their coverage must not regress.
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
  /** The provider/model used by the most recent assistant message. */
  model?: { providerID: string; modelID: string }
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
  /\bAuthorization[ \t]*:[ \t]*Basic[ \t]+[^\s"'`]+/gi,
  /\b(?:Authorization[ \t]*:[ \t]*)?Bearer[ \t]+(?!(?:tokens?|auth|authentication|scheme|header|credentials)(?=$|[\s"'`.,;:!?)}\]]))[^\s"'`]+/gi,
  /(:\/\/[^\s/:@]*:)[^\s/@]+(@)/g,
  /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
]

// Linear by construction: no unbounded prefix before the keyword alternation (the text before the
// keyword stays outside the match and is kept as is), bounded key suffix and separator, and every value
// branch consumes at least one character on success, so a failed attempt never rescans the input.
const ASSIGNMENT =
  /((?:password|passwd|pwd|secret|token|api[ \t_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,40})(["']?\s{0,20}[=:]\s{0,20})(?:\[REDACTED\]|[|>][-+0-9]*[ \t]*(?:\r?\n[ \t]+[^\r\n]*)+|\{(?:[^}]|}})*(?:\}|$)|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'}\])]+)/gi

// Long credential options have the same meaning across tools. Short options need command context:
// mysql -p is a password, while mysql -P and psql -p are ports and git log -p selects patches.
const CREDENTIAL_ARGUMENT =
  /((?:^|[\s("'`])--(?:password|token|secret|api-key|proxy-user)(?:[ \t]*=[ \t]*|[ \t]+))(?:\[REDACTED\]|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'`}\])]+)/gi
// sshpass wraps another command: stop after its options so a child's -p can remain a port.
const SSHPASS_COMMAND = /^sshpass(?:\.exe)?(?:[ \t]+(?:-[evVh]+(?=[ \t]|$)|-[pfdP](?:[ \t]*=[ \t]*|[ \t]+)?(?:"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s;&|`"']+)))*/gi
// Consume other quoted arguments whole so SQL/string contents cannot masquerade as CLI flags.
const PASSWORD_P = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|((?:^|[ \t])-p(?:[ \t]*=[ \t]*|[ \t]+)?)(?:\[REDACTED\]|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'`}\])]+)/g
const REDIS_PASSWORD = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|((?:^|[ \t])-a(?:[ \t]*=[ \t]*|[ \t]+)?)(?:\[REDACTED\]|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'`}\])]+)/g
const SQLCMD_PASSWORD = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|((?:^|[ \t])-P(?:[ \t]*=[ \t]*|[ \t]+)?)(?:\[REDACTED\]|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'`}\])]+)/g
const CURL_USER = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|((?:^|[ \t])(?:-u(?:[ \t]*=[ \t]*|[ \t]+)?|--(?:proxy-)?user(?:[ \t]*=[ \t]*|[ \t]+)))(?:\[REDACTED\]|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s,;"'`}\])]+)/g
const SENSITIVE_FIELD = /^(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)$/i

/** Redacted characters retained per string field before JSON serialization. */
const INPUT_READ_CAP = 4_000

function normalizeSecrets(text: string): string {
  // Keep real newlines for YAML/quoted values, but join shell continuations before matching flags.
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\\\r?\n/g, "")
}

interface SecretSpan { start: number; end: number }

const COMMAND_RULES = [
  { tool: /^(?:mysql[\w-]*|mariadb[\w-]*|mongosh|mongo)(?:\.exe)?$/i, option: PASSWORD_P },
  { tool: /^(?:sqlcmd|bcp)(?:\.exe)?$/i, option: SQLCMD_PASSWORD },
  { tool: /^redis-cli(?:\.exe)?$/i, option: REDIS_PASSWORD },
  { tool: /^curl(?:\.exe)?$/i, option: CURL_USER },
]

function commandSecrets(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  let command: { start: number; option: RegExp; sshpass?: boolean } | undefined
  let position = true
  let docker = false
  let environment = false
  const outer: Array<{ close: string; command: typeof command }> = []

  function finish(end: number) {
    if (!command) return
    const { start, option, sshpass } = command
    const source = text.slice(start, end)
    // sshpass's child can use -p for a port. Limit this scan to the wrapper's own options.
    const args = sshpass ? source.match(SSHPASS_COMMAND)?.[0] ?? "" : source
    for (const match of args.matchAll(option)) {
      if (!match[1] || match[0].slice(match[1].length) === "[REDACTED]") continue
      spans.push({ start: start + match.index + match[1].length, end: start + match.index + match[0].length })
    }
    command = undefined
  }

  // Consume every token once, including whole quoted arguments. A tool name only establishes a
  // command at a shell boundary; names inside argument values never start overlapping suffix scans.
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === ")" || (ch === "`" && outer.at(-1)?.close === "`")) {
      finish(i)
      const parent = outer.at(-1)?.close === ch ? outer.pop()?.command : undefined
      command = parent ? { ...parent, start: i + 1 } : undefined
      position = false
      docker = false
      environment = false
      i++
      continue
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      outer.push({ close: ch === "`" ? "`" : ")", command })
      finish(i)
      position = true
      docker = false
      environment = false
      i += ch === "$" ? 2 : 1
      continue
    }
    if (ch === "\n" || ch === "\r" || ";|".includes(ch) || (ch === "&" && text[i + 1] === "&") || (ch === "$" && text[i + 1] === " ")) {
      finish(i)
      position = true
      docker = false
      environment = false
      i += ch === "$" || ch === "&" ? 2 : 1
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const start = i
    let quoted = false
    while (i < text.length && !/[\s;|`)]/.test(text[i]) && !(text[i] === "&" && text[i + 1] === "&") && !(text[i] === "$" && (text[i + 1] === "(" || text[i + 1] === " "))) {
      if (text[i] === "\\") {
        i += Math.min(2, text.length - i)
      } else if (text[i] === '"' || text[i] === "'") {
        quoted = true
        const quote = text[i++]
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\" && quote === '"') i++
          i++
        }
        if (i < text.length) i++
      } else i++
    }
    if (!position && !docker) continue
    const word = text.slice(start, i)
    if (docker) {
      if (!quoted && word === "login") command = { start, option: PASSWORD_P }
      docker = false
      continue
    }
    if (!quoted && (word === "sudo" || word === "env")) {
      environment = word === "env"
      continue
    }
    if (environment && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    position = false
    environment = false
    if (quoted) continue
    const tool = word.replace(/^.*[\\/]/, "")
    if (/^docker(?:\.exe)?$/i.test(tool)) {
      docker = true
      continue
    }
    if (/^sshpass(?:\.exe)?$/i.test(tool)) {
      command = { start: i - tool.length, option: PASSWORD_P, sshpass: true }
      continue
    }
    const rule = COMMAND_RULES.find((rule) => rule.tool.test(tool))
    if (rule) command = { start, option: rule.option }
  }
  finish(text.length)
  return spans
}

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
  return secretSpans(normalizeSecrets(text)).length > 0
}

function secretSpans(text: string): SecretSpan[] {
  // Every detector sees the same original text. Only after all rules have run do we merge their
  // ranges, so redacting one secret can never hide a match belonging to another rule.
  const spans = commandSecrets(text)
  for (const re of TOKEN_PATTERNS) {
    for (const match of text.matchAll(re)) {
      spans.push({
        start: match.index + (match[1]?.length ?? 0),
        end: match.index + match[0].length - (match[2]?.length ?? 0),
      })
    }
  }
  for (const re of [ASSIGNMENT, CREDENTIAL_ARGUMENT]) {
    for (const match of text.matchAll(re)) {
      spans.push({ start: match.index + match[1].length + (match[2]?.length ?? 0), end: match.index + match[0].length })
    }
  }
  return spans
}

export function redactSecrets(text: string): string {
  text = normalizeSecrets(text)
  const spans = secretSpans(text)
  for (const match of text.matchAll(CANDIDATE)) {
    if (isHighEntropy(match[0])) spans.push({ start: match.index, end: match.index + match[0].length })
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SecretSpan[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  }
  let out = ""
  let end = 0
  for (const span of merged) {
    out += text.slice(end, span.start) + "[REDACTED]"
    end = span.end
  }
  return out + text.slice(end)
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
      : typeof value === "string" ? redactSecrets(value).slice(0, INPUT_READ_CAP) : value) ?? ""
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
  // Redact complete values first: clipping can remove the @ or end marker that identifies a secret.
  const prompts = src.prompts.map((p) => clipBlock(redactSecrets(p), PROMPT_CAP))
  const files = clipBlock(
    redactSecrets(
      writtenFiles(src.calls)
        .map((f) => `- ${redactSecrets(f)}`)
        .join("\n"),
    ),
    FILES_CAP,
  )
  const final = src.finalText ? clipBlock(redactSecrets(src.finalText), FINAL_CAP) : ""

  const lines = src.calls.map((c, i) => {
    const input = clip(redactSecrets(stringify(c.input)), INPUT_CAP)
    const result = c.error !== undefined ? `ERROR: ${clip(redactSecrets(c.error), OUTPUT_CAP)}` : clip(redactSecrets(c.output ?? ""), OUTPUT_CAP)
    return `${i + 1}. ${redactSecrets(c.name)}(${input}) → ${result}`
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
  let model: DigestSource["model"]
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
    if (msg.info.providerID && msg.info.modelID)
      model = { providerID: msg.info.providerID, modelID: msg.info.modelID }
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
  return { prompts, calls, finalText, model }
}

/** Reads the `trajectory export` shape. Tolerant: unknown or missing fields are skipped. */
export function sourceFromTrajectory(json: unknown): DigestSource {
  const root = (json ?? {}) as Record<string, unknown>
  if (!Array.isArray(root.steps)) throw new Error("Not a trajectory export: missing `steps` array.")
  const prompts = Array.isArray(root.user_prompts) ? root.user_prompts.filter((p): p is string => typeof p === "string") : []
  const calls: DigestCall[] = []
  let finalText: string | undefined
  let model: DigestSource["model"]
  for (const raw of root.steps) {
    const step = (raw ?? {}) as Record<string, unknown>
    const generation = (step.generation ?? {}) as Record<string, unknown>
    if (typeof generation.provider_id === "string" && generation.provider_id &&
      typeof generation.model_id === "string" && generation.model_id)
      model = { providerID: generation.provider_id, modelID: generation.model_id }
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
  return { prompts, calls, finalText, model }
}

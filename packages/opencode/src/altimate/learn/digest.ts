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
  /** Original one-based position when a streaming source omits middle calls. */
  index?: number
}

export interface DigestSource {
  prompts: string[]
  calls: DigestCall[]
  finalText?: string
  /** The provider/model used by the most recent assistant message. */
  model?: { providerID: string; modelID: string }
  /** Streaming sources retain a bounded sample and keep these totals separately. */
  callCount?: number
  files?: string[]
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
  /\bAuthorization[ \t]*:[ \t]*Bearer[ \t]+[^\s"'`]+/gi,
  /\bBearer[ \t]+(?!(?:tokens?|auth|authentication|scheme|header|credentials)(?=\s|$))[^\s"'`]+/gi,
  /(:\/\/[^\s/:@]*:)[^\s/@]+(@)/g,
  /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g,
  /(\b(?:ssn|social[ \t]+security(?:[ \t]+number)?)[ \t]*[:=]?[ \t]*)\d{9}\b/gi,
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
const SSHPASS_COMMAND = /sshpass(?:\.exe)?(?:[ \t]+(?:-[evVh]+(?=[ \t]|$)|-[pfdP](?:[ \t]*=[ \t]*|[ \t]+)?(?:"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s;&|`"']+)))*/iy
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

// Whole-word occurrences include prose, wrappers and paths. Each option rule scans only the
// earliest occurrence in a shell/sentence scope: later occurrences have suffixes contained in that
// scan, so their union costs O(number of rules * text length), never one suffix scan per tool name.
const COMMAND_NAME = /\b(?:mysql[\w-]*|mariadb[\w-]*|mongosh|mongo|sqlcmd|bcp|redis-cli|curl|docker|sshpass)(?:\.exe)?\b/gi

function commandSecrets(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  const active = new Map<RegExp, number>()
  const outer: Array<{ close: string; options: RegExp[] }> = []
  let previousFlag = false
  let docker = false

  function scan(start: number, end: number, option: RegExp) {
    for (const match of text.slice(start, end).matchAll(option)) {
      if (!match[1] || match[0].slice(match[1].length) === "[REDACTED]") continue
      spans.push({ start: start + match.index + match[1].length, end: start + match.index + match[0].length })
    }
  }

  function finish(end: number) {
    for (const [option, start] of active) scan(start, end, option)
    active.clear()
    previousFlag = false
    docker = false
  }

  // A final punctuation mark remains part of its argument (e.g. mysql -p!), but cannot let
  // password semantics leak into the next sentence. A trailing hostname dot before -p is not an end.
  function sentenceEnd(index: number): boolean {
    if (!".!?".includes(text[index])) return false
    let next = index + 1
    if (next === text.length) return true
    if (!/[ \t]/.test(text[next])) return false
    while (next < text.length && /[ \t]/.test(text[next])) next++
    return next === text.length || /[A-Z]/.test(text[next])
  }

  function recognize(start: number, end: number) {
    if (previousFlag) return
    for (const match of text.slice(start, end).matchAll(COMMAND_NAME)) {
      const tool = match[0]
      const at = start + match.index
      // Slicing around escapes must not invent a word boundary inside an identifier.
      if (at > 0 && /\w/.test(text[at - 1])) continue
      if (/^docker(?:\.exe)?$/i.test(tool)) {
        docker = true
      } else if (/^sshpass(?:\.exe)?$/i.test(tool)) {
        // A wrapper owns only its options, not its child's port flag. Sticky matching avoids
        // rescanning the remaining input for every sshpass occurrence.
        SSHPASS_COMMAND.lastIndex = at
        const wrapper = SSHPASS_COMMAND.exec(text)
        if (wrapper) scan(at, at + wrapper[0].length, PASSWORD_P)
      } else {
        const rule = COMMAND_RULES.find((rule) => rule.tool.test(tool))
        if (rule && !active.has(rule.option)) active.set(rule.option, at)
      }
    }
  }

  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === ")" || (ch === "`" && outer.at(-1)?.close === "`")) {
      finish(i)
      if (outer.at(-1)?.close === ch) {
        for (const option of outer.pop()!.options) active.set(option, i + 1)
      }
      i++
      continue
    }
    if (ch === "(" || ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      outer.push({ close: ch === "`" ? "`" : ")", options: [...active.keys()] })
      finish(i)
      i += ch === "$" ? 2 : 1
      continue
    }
    if (ch === "\n" || ch === "\r" || ";|&".includes(ch) || (ch === "$" && text[i + 1] === " ")) {
      finish(i)
      i += ch === "$" ? 2 : 1
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const start = i
    let unquoted = i
    let endOfSentence = false
    const dockerLogin = docker
    docker = false
    while (i < text.length && !/[\s;|&`()]/.test(text[i]) && !(text[i] === "$" && (text[i + 1] === "(" || text[i + 1] === " "))) {
      if (text[i] === "\\" || text[i] === '"' || text[i] === "'") {
        recognize(unquoted, i)
        const quote = text[i++]
        if (quote === "\\") i = Math.min(i + 1, text.length)
        else {
          while (i < text.length && text[i] !== quote) {
            if (text[i] === "\\" && quote === '"') i++
            i++
          }
          if (i < text.length) i++
        }
        unquoted = i
      } else {
        endOfSentence = sentenceEnd(i)
        i++
        if (endOfSentence) break
      }
    }
    recognize(unquoted, i)
    if (dockerLogin && text.slice(start, i).toLowerCase() === "login" && !active.has(PASSWORD_P)) {
      active.set(PASSWORD_P, start)
    }
    previousFlag = text[start] === "-"
    if (endOfSentence) finish(i)
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
      const start = match.index + match[1].length + (match[2]?.length ?? 0)
      // The assignment detector also catches keyword substrings for defense in depth. Numeric
      // settings such as max_tokens are ordinary counts unless the key names a credential.
      if (re === ASSIGNMENT && /^\d+(?:\.\d+)?$/.test(text.slice(start, match.index + match[0].length))) {
        let keyStart = match.index
        while (keyStart > 0 && /[A-Za-z0-9_.-]/.test(text[keyStart - 1])) keyStart--
        const key = text.slice(keyStart, match.index + match[1].length).replace(/([a-z])([A-Z])/g, "$1_$2")
        if (!/(?:password|passwd|pwd|secret|token|api[ \t_-]?key|access[_-]?key|private[_-]?key)(?:$|[_.-]|[0-9])/i.test(key)) continue
      }
      spans.push({ start, end: match.index + match[0].length })
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
      (src.files ?? writtenFiles(src.calls))
        .map((f) => `- ${redactSecrets(f)}`)
        .join("\n"),
    ),
    FILES_CAP,
  )
  const final = src.finalText ? clipBlock(redactSecrets(src.finalText), FINAL_CAP) : ""

  const lines = src.calls.map((c, i) => {
    const input = clip(redactSecrets(stringify(c.input)), INPUT_CAP)
    const result = c.error !== undefined ? `ERROR: ${clip(redactSecrets(c.error), OUTPUT_CAP)}` : clip(redactSecrets(c.output ?? ""), OUTPUT_CAP)
    return `${c.index ?? i + 1}. ${redactSecrets(c.name)}(${input}) → ${result}`
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

  function selectedLines(start: number, end: number): string[] {
    return lines.slice(start, end).flatMap((line, offset) => {
      const i = start + offset
      const index = src.calls[i].index ?? i + 1
      const previous = i ? src.calls[i - 1].index ?? i : 0
      return offset > 0 && index > previous + 1 ? [`… [${index - previous - 1} tool calls omitted]`, line] : [line]
    })
  }

  let body = selectedLines(0, lines.length).join("\n")
  if (body.length > budget) {
    // Keep the start and the end of the run; the middle is the least informative.
    const half = Math.floor(budget / 2)
    let a = 0
    let used = 0
    while (a < lines.length && used + lines[a].length + 1 <= half) used += lines[a++].length + 1
    let b = lines.length
    used = 0
    while (b > a && used + lines[b - 1].length + 1 <= half) used += lines[--b].length + 1
    const firstOmitted = a ? (src.calls[a - 1].index ?? a) + 1 : 1
    const lastOmitted = b < lines.length ? (src.calls[b].index ?? b + 1) - 1 : src.callCount ?? lines.length
    body = [...selectedLines(0, a), `… [${lastOmitted - firstOmitted + 1} tool calls omitted]`, ...selectedLines(b, lines.length)].join("\n")
  }
  const calls = `## Tool calls (${src.callCount ?? lines.length})\n${body || "(none)"}\n`
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

/** Keeps a bounded prefix and suffix without retaining the middle of a session. */
function headAndTail<T>(cap: number, size: (item: T) => number) {
  const head: T[] = []
  const tail: T[] = []
  let headSize = 0
  let tailSize = 0
  let headDone = false
  return {
    add(item: T) {
      const length = size(item)
      if (!headDone && headSize + length <= cap / 2) {
        head.push(item)
        headSize += length
        return
      }
      headDone = true
      tail.push(item)
      tailSize += length
      while (tailSize > cap / 2 && tail.length > 1) tailSize -= size(tail.shift()!)
    },
    values: () => [...head, ...tail],
  }
}

/** Accepts chronological messages; retained data stays close to DIGEST_CAP, regardless of session size. */
export function createDigestAccumulator() {
  const prompts = headAndTail<string>(4_500, (text) => text.length + 1)
  const calls = headAndTail<DigestCall>(14_000, (call) => JSON.stringify(call).length + 1)
  const files = new Set<string>()
  let fileSize = 0
  let callCount = 0
  let finalText: string | undefined
  let model: DigestSource["model"]

  // The current message is transient; only its bounded, fully redacted text is retained. Joining
  // before redaction preserves credential syntax even when it spans more than one text part.
  function text(message: MessageV2.WithParts, cap: number): string {
    const raw = message.parts.flatMap((part) => part.type === "text" &&
      !(message.info.role === "user" && (part.synthetic || part.ignored)) ? [part.text] : []).join("\n")
    return clipBlock(redactSecrets(raw), cap)
  }

  return {
    add(message: MessageV2.WithParts) {
      if (message.info.role === "user") {
        const prompt = text(message, PROMPT_CAP)
        if (prompt) prompts.add(prompt)
        return
      }
      if (message.info.role !== "assistant") return
      if (message.info.providerID && message.info.modelID)
        model = { providerID: message.info.providerID, modelID: message.info.modelID }
      const final = text(message, FINAL_CAP)
      if (final) finalText = final
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const state = part.state
        const input = state.status === "pending" ? undefined : state.input
        const raw = { name: part.tool, input }
        for (const file of writtenFiles([raw])) {
          const redacted = redactSecrets(file)
          if (fileSize + redacted.length + 3 > FILES_CAP || files.has(redacted)) continue
          files.add(redacted)
          fileSize += redacted.length + 3
        }
        calls.add({
          name: clip(redactSecrets(part.tool), 100),
          input: clip(redactSecrets(stringify(input)), INPUT_CAP),
          output: state.status === "completed" ? clip(redactSecrets(state.output), OUTPUT_CAP) : undefined,
          error: state.status === "error" ? clip(redactSecrets(state.error), OUTPUT_CAP) : undefined,
          index: ++callCount,
        })
      }
    },
    source(): DigestSource {
      return { prompts: prompts.values(), calls: calls.values(), finalText, model, callCount, files: [...files] }
    },
  }
}

export async function sourceFromMessageStream(messages: AsyncIterable<MessageV2.WithParts>): Promise<DigestSource> {
  const digest = createDigestAccumulator()
  for await (const message of messages) digest.add(message)
  return digest.source()
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

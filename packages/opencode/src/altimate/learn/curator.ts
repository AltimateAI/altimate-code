// altimate_change - new file
//
// Deterministic, pure curator. The reflector (an LLM) only proposes deltas; this
// module decides what actually lands in the playbook. Because the playbook is
// auto-loaded into every teammate's system prompt once published, ADD/EDIT text
// is linted hard: a bullet that fails lint is rejected, never repaired.
import { newId, type Bullet } from "./playbook"
import { hasHighEntropyToken, hasSecretPattern } from "./digest"

export const MAX_TEXT = 240
export const MAX_BULLETS = 25
export const MAX_ADDS = 3
export const MAX_EDITS = 3
export const MAX_REMOVES = 3
export const DEDUPE_THRESHOLD = 0.6
export const AUTO_REMOVE_MIN_HARMFUL = 2
/** Auto-remove also needs HARMFUL marks from this many distinct feedback inputs. */
export const AUTO_REMOVE_MIN_FEEDBACKS = 2

export type Op = "ADD" | "EDIT" | "REMOVE" | "HELPFUL" | "HARMFUL"

export interface Delta {
  op: Op
  id?: string
  text?: string
  reason: string
}

export interface Applied extends Delta {
  /** Why the curator changed what the reflector asked for, when it did. */
  note?: string
  /** For HELPFUL/HARMFUL: the bullet's counter after this delta. */
  count?: number
}

export interface Rejected {
  delta: Delta
  reason: string
}

/** Bullet id -> short hashes of the distinct feedback inputs that marked it HARMFUL. */
export type HarmfulFrom = Record<string, string[]>

export interface CurateResult {
  next: Bullet[]
  applied: Applied[]
  rejected: Rejected[]
  /** Updated provenance for `opts.harmfulFrom`; local state only, never published. */
  harmfulFrom: HarmfulFrom
}

// --- lint ---

const LINT_RULES: Array<[string, RegExp]> = [
  ["contains a comment marker", /<!--|-->/],
  [
    "contains a shell command",
    /\b(?:sudo|curl|wget|chmod|chown|mkfs|nc|ncat|netcat|powershell|pwsh)\b|\brm\s+(?:-\S+\s+)?\S|\b(?:ba|z)?sh\s+-c\b|\|\s*(?:ba|z)?sh\b|\beval\s|\$\(|;\s*rm\b|&&\s*(?:rm|curl|wget|sudo)\b|\bpython[0-9.]*\s+-c\b|\bnode\s+-e\b|\bperl\s+-e\b/i,
  ],
  [
    "contains a URL",
    // `scheme://`, `www.`, a `//host` reference, or a bare `domain.tld/path`. Dotted file names without a
    // following slash (`stg_x.sql`) and dbt selectors (`tag:nightly`) are not matched.
    /\b[a-z][a-z0-9+.-]*:\/\/\S|\bwww\.\S|(?:^|[\s(\[`'"=])\/\/[^\s/]|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S|\b(?:javascript|data|file|vbscript|ftps?|sftp|ssh|mailto|tel|blob|about|view-source|intent|smb|ldaps?|gopher|jar):(?=\S)/i,
  ],
  ["contains a markdown link or image", /!\[|\[[^\]]*\]\([^)]*\)/],
  ["contains an email address", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["contains a session or message id", /\b(?:ses|msg)_[A-Za-z0-9]+/],
  [
    "contains an absolute path or path escape",
    /(?:^|[\s(`'"=:])(?:\/[\w.@-]+|~\/|[A-Za-z]:[\\/])|(?:^|[\s/\\(`'"])\.\.(?:[\\/]|$|[\s)`'",;])|[\\/]\.\.(?:[\\/]|$|\s)/,
  ],
  [
    "weakens verification",
    /\bskip(?:ping|s|ped)?\s+(?:the\s+|all\s+|any\s+)?(?:tests?|checks?|ci|lint\w*|validation|verification|review|build)\b|\bignor(?:e|es|ing)\s+(?:the\s+|any\s+|all\s+)?(?:checks?|tests?|failures?|errors?|warnings?|lint\w*|ci)\b|\bdisabl(?:e|es|ed|ing)\b|\b(?:do(?:es)?\s+not|don'?t|never)\s+run\s+(?:dbt|the\s+(?:tests?|lint\w*)|tests?|lint\w*)|\bbypass\w*|--no-verify|\bturn(?:ing)?\s+off\b|\bwithout\s+(?:running\s+)?(?:the\s+)?(?:tests?|checks?)\b|\bno\s+need\s+to\s+(?:run|test|verify|check)\b/i,
  ],
  [
    "looks like prompt injection",
    /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|guidance)|\bdisregard\b|\bsystem\s+prompt\b|<\/?\s*(?:auto_loaded_skill|available_skills|system|assistant|user|instructions?)\b|\byou\s+are\s+now\b|\bnew\s+instructions\b/i,
  ],
]

/** Line terminators other than `\n`: U+2028/2029 and NEL split lines in markdown/JS consumers. */
const LINE_BREAKS = new RegExp("[\\r\\n\\u0085\\u2028\\u2029]")

/**
 * The form of `text` that is linted and stored: NFKC (folds fullwidth and compatibility forms such as
 * `ｃｕｒｌ`), with format (`\p{Cf}`, e.g. zero-width space) and control (`\p{Cc}`) characters removed so
 * they cannot split a word the lint rules look for. Tabs become spaces.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\t/g, " ").replace(/[\p{Cf}\p{Cc}]/gu, "")
}

/** First lint failure for `text`, or `undefined` when it is acceptable. */
export function lint(text: string): string | undefined {
  if (LINE_BREAKS.test(text.trim())) return "must be a single line"
  const t = normalizeText(text).trim()
  if (!t) return "empty text"
  if (LINE_BREAKS.test(t)) return "must be a single line"
  if (t.length > MAX_TEXT) return `longer than ${MAX_TEXT} characters`
  for (const [reason, re] of LINT_RULES) if (re.test(t)) return reason
  if (hasSecretPattern(t) || hasHighEntropyToken(t)) return "looks like a secret"
  return undefined
}

// --- similarity ---

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 1),
  )
}

export function jaccard(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (x.size === 0 && y.size === 0) return 1
  let inter = 0
  for (const t of x) if (y.has(t)) inter++
  return inter / (x.size + y.size - inter)
}

// --- curate ---

export interface CurateOptions {
  /** Injectable for tests. */
  newId?: (taken: Iterable<string>) => string
  /**
   * Short hash of this reflection's feedback. One reflection applies at most one
   * HARMFUL per bullet and counts once toward its distinct-feedback total.
   * Without it, HARMFUL marks accumulate but can never auto-remove.
   */
  feedbackId?: string
  /** Prior HARMFUL provenance (from local state). Not read from the playbook: it is published. */
  harmfulFrom?: HarmfulFrom
}

export function curate(current: Bullet[], deltas: Delta[], opts: CurateOptions = {}): CurateResult {
  const mint = opts.newId ?? newId
  let next = current.map((b) => ({ ...b }))
  const applied: Applied[] = []
  const rejected: Rejected[] = []
  let adds = 0
  let edits = 0
  let removes = 0
  const harmfulFrom: HarmfulFrom = {}
  const harmedNow = new Set<string>()
  // One reflection moves a bullet's helpful counter by at most 1, however many deltas (or duplicate ADDs) say so.
  const helpedNow = new Set<string>()
  for (const b of next) {
    // A counter lower than the recorded hashes means it was reset (rollback, hand edit): trust the counter.
    const prior = (opts.harmfulFrom?.[b.id] ?? []).slice(0, b.harmful)
    if (prior.length) harmfulFrom[b.id] = prior
  }
  // Bullets added in this pass are not evicted for being new (score 0): that would
  // make every ADD at the cap a no-op. They go only if nothing else can.
  const fresh = new Set<string>()

  const find = (id: string | undefined) => (id ? next.find((b) => b.id === id) : undefined)
  const reject = (delta: Delta, reason: string) => rejected.push({ delta, reason })

  for (const delta of deltas) {
    switch (delta.op) {
      case "ADD": {
        const bad = lint(delta.text ?? "")
        if (bad) {
          reject(delta, bad)
          break
        }
        const text = normalizeText(delta.text ?? "").trim()
        let best: Bullet | undefined
        let bestScore = 0
        for (const b of next) {
          const s = jaccard(text, b.text)
          if (s > bestScore) [best, bestScore] = [b, s]
        }
        if (best && bestScore >= DEDUPE_THRESHOLD) {
          if (helpedNow.has(best.id)) {
            reject(delta, "duplicate HELPFUL for this bullet in one reflection")
            break
          }
          helpedNow.add(best.id)
          best.helpful++
          applied.push({
            op: "HELPFUL",
            id: best.id,
            reason: delta.reason,
            note: `duplicate ADD (similarity ${bestScore.toFixed(2)})`,
          })
          break
        }
        if (adds >= MAX_ADDS) {
          reject(delta, `edit budget exceeded (max ${MAX_ADDS} ADDs per reflection)`)
          break
        }
        adds++
        const id = mint(next.map((b) => b.id))
        next.push({ id, text, helpful: 0, harmful: 0 })
        fresh.add(id)
        applied.push({ ...delta, id, text })
        break
      }
      case "EDIT": {
        const target = find(delta.id)
        if (!target) {
          reject(delta, "unknown bullet id")
          break
        }
        const bad = lint(delta.text ?? "")
        if (bad) {
          reject(delta, bad)
          break
        }
        if (edits >= MAX_EDITS) {
          reject(delta, `edit budget exceeded (max ${MAX_EDITS} EDITs per reflection)`)
          break
        }
        edits++
        const text = normalizeText(delta.text ?? "").trim()
        target.text = text
        applied.push({ ...delta, text })
        break
      }
      case "REMOVE": {
        if (!find(delta.id)) {
          reject(delta, "unknown bullet id")
          break
        }
        if (removes >= MAX_REMOVES) {
          reject(delta, `edit budget exceeded (max ${MAX_REMOVES} REMOVEs per reflection)`)
          break
        }
        removes++
        next = next.filter((b) => b.id !== delta.id)
        applied.push(delta)
        break
      }
      case "HELPFUL":
      case "HARMFUL": {
        const target = find(delta.id)
        if (!target) {
          reject(delta, "unknown bullet id")
          break
        }
        if (delta.op === "HELPFUL") {
          if (helpedNow.has(target.id)) {
            reject(delta, "duplicate HELPFUL for this bullet in one reflection")
            break
          }
          helpedNow.add(target.id)
          target.helpful++
        } else {
          if (harmedNow.has(target.id)) {
            reject(delta, "duplicate HARMFUL for this bullet in one reflection")
            break
          }
          harmedNow.add(target.id)
          target.harmful++
          if (opts.feedbackId) {
            const from = harmfulFrom[target.id] ?? []
            if (!from.includes(opts.feedbackId)) harmfulFrom[target.id] = [...from, opts.feedbackId]
          }
        }
        applied.push({ ...delta, count: delta.op === "HELPFUL" ? target.helpful : target.harmful })
        break
      }
      default:
        reject(delta, "unknown op")
    }
  }

  const doomed = next.filter(
    (b) =>
      b.harmful >= AUTO_REMOVE_MIN_HARMFUL &&
      b.harmful > b.helpful &&
      (harmfulFrom[b.id]?.length ?? 0) >= AUTO_REMOVE_MIN_FEEDBACKS,
  )
  for (const b of doomed) applied.push({ op: "REMOVE", id: b.id, reason: "auto: harmful outweighs helpful", note: "auto-remove" })
  next = next.filter((b) => !doomed.includes(b))

  while (next.length > MAX_BULLETS) {
    // Lowest net score first; ties go to the oldest (earliest in the list).
    const pool = next.some((b) => !fresh.has(b.id)) ? (b: Bullet) => !fresh.has(b.id) : () => true
    let victim = -1
    for (let i = 0; i < next.length; i++) {
      if (!pool(next[i])) continue
      if (victim < 0 || next[i].helpful - next[i].harmful < next[victim].helpful - next[victim].harmful) victim = i
    }
    applied.push({ op: "REMOVE", id: next[victim].id, reason: `evicted: over the ${MAX_BULLETS}-bullet cap`, note: "cap eviction" })
    next.splice(victim, 1)
  }

  for (const id of Object.keys(harmfulFrom)) if (!next.some((b) => b.id === id)) delete harmfulFrom[id]
  return { next, applied, rejected, harmfulFrom }
}

const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n)}...` : text)

/** One human-readable line per applied delta. `redact` scrubs secrets from echoed text. */
export function describeApplied(a: Applied, redact: (t: string) => string = (t) => t): string {
  const id = a.id ?? "?"
  switch (a.op) {
    case "ADD":
    case "EDIT":
      return `${a.op} ${id}: ${redact(a.text ?? "")}`
    case "REMOVE":
      return `REMOVE ${id} (${a.reason})`
    case "HELPFUL":
    case "HARMFUL": {
      const mark = a.op === "HELPFUL" ? "h" : "x"
      const why = a.note ? `${a.note}; ${redact(a.reason)}` : redact(a.reason)
      return `${a.op} ${id} (${mark}=${a.count ?? "?"}): ${why}`
    }
    default:
      return `${a.op} ${id}`
  }
}

/** One line per rejected delta: the reason and the first 60 characters of the offending text. */
export function describeRejected(r: Rejected, redact: (t: string) => string = (t) => t): string {
  const text = r.delta.text ? ` — "${clip(redact(r.delta.text))}"` : r.delta.id ? ` ${r.delta.id}` : ""
  return `REJECTED ${r.delta.op}: ${r.reason}${text}`
}

export const FEEDBACK_FLAG_NOTE =
  "note: feedback contains text that looks like instructions/shell commands; treated as data"

/** Deterministic check of raw feedback against the curator's shell and injection lint. */
export function flagSuspiciousFeedback(feedback: string): string | undefined {
  const text = normalizeText(feedback.replace(/\s+/g, " "))
  const hit = LINT_RULES.some(
    ([reason, re]) => (reason === "contains a shell command" || reason === "looks like prompt injection") && re.test(text),
  )
  return hit ? FEEDBACK_FLAG_NOTE : undefined
}

export function summarize(result: Pick<CurateResult, "applied" | "rejected">): string {
  const n = (op: Op, note?: string) =>
    result.applied.filter((a) => a.op === op && (note === undefined || a.note === note)).length
  const parts = [
    `+${n("ADD")} added`,
    `${n("EDIT")} edited`,
    `${n("HELPFUL")} helpful`,
    `${n("HARMFUL")} harmful`,
    `${n("REMOVE")} removed`,
  ].filter((p) => !/^\+?0 /.test(p))
  const rej = result.rejected.length
  if (rej) parts.push(`${rej} rejected (${[...new Set(result.rejected.map((r) => r.reason))].join("; ")})`)
  return parts.length ? parts.join(", ") : "no change"
}

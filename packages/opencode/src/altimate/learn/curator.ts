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
export const DEDUPE_THRESHOLD = 0.6
export const AUTO_REMOVE_MIN_HARMFUL = 2

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
}

export interface Rejected {
  delta: Delta
  reason: string
}

export interface CurateResult {
  next: Bullet[]
  applied: Applied[]
  rejected: Rejected[]
}

// --- lint ---

const LINT_RULES: Array<[string, RegExp]> = [
  ["contains a comment marker", /<!--|-->/],
  [
    "contains a shell command",
    /\b(?:sudo|curl|wget|chmod|chown|mkfs)\b|\brm\s+(?:-\S+\s+)?\S|\b(?:ba|z)?sh\s+-c\b|\|\s*(?:ba|z)?sh\b|\beval\s|\$\(|;\s*rm\b|&&\s*(?:rm|curl|wget|sudo)\b/i,
  ],
  ["contains a URL", /\b[a-z][a-z0-9+.-]*:\/\/\S|\bwww\.\S/i],
  [
    "contains an absolute path or path escape",
    /(?:^|[\s(`'"=:])(?:\/[\w.@-]+|~\/|[A-Za-z]:[\\/])|(?:^|[\s/\\(`'"])\.\.(?:[\\/]|$|[\s)`'",;])|[\\/]\.\.(?:[\\/]|$|\s)/,
  ],
  [
    "weakens verification",
    /\bskip(?:ping|s|ped)?\s+(?:the\s+|all\s+|any\s+)?(?:tests?|checks?|ci|lint\w*|validation|verification|review|build)\b|\bignor(?:e|es|ing)\s+(?:the\s+|any\s+|all\s+)?(?:checks?|tests?|failures?|errors?|warnings?|lint\w*|ci)\b|\bdisabl(?:e|es|ed|ing)\b|\bdo(?:es)?\s+not\s+run\s+(?:dbt|the\s+tests?|tests?)|\bdon'?t\s+run\s+(?:dbt|the\s+tests?|tests?)|\bbypass\w*|--no-verify|\bturn(?:ing)?\s+off\b|\bwithout\s+(?:running\s+)?(?:the\s+)?(?:tests?|checks?)\b|\bno\s+need\s+to\s+(?:run|test|verify|check)\b/i,
  ],
  [
    "looks like prompt injection",
    /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|guidance)|\bdisregard\b|\bsystem\s+prompt\b|<\/?\s*(?:auto_loaded_skill|available_skills|system|assistant|user|instructions?)\b|\byou\s+are\s+now\b|\bnew\s+instructions\b/i,
  ],
]

/** First lint failure for `text`, or `undefined` when it is acceptable. */
export function lint(text: string): string | undefined {
  const t = text.trim()
  if (!t) return "empty text"
  if (/[\r\n]/.test(t)) return "must be a single line"
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
}

export function curate(current: Bullet[], deltas: Delta[], opts: CurateOptions = {}): CurateResult {
  const mint = opts.newId ?? newId
  let next = current.map((b) => ({ ...b }))
  const applied: Applied[] = []
  const rejected: Rejected[] = []
  let adds = 0
  // Bullets added in this pass are not evicted for being new (score 0): that would
  // make every ADD at the cap a no-op. They go only if nothing else can.
  const fresh = new Set<string>()

  const find = (id: string | undefined) => (id ? next.find((b) => b.id === id) : undefined)
  const reject = (delta: Delta, reason: string) => rejected.push({ delta, reason })

  for (const delta of deltas) {
    switch (delta.op) {
      case "ADD": {
        const text = (delta.text ?? "").trim()
        const bad = lint(text)
        if (bad) {
          reject(delta, bad)
          break
        }
        let best: Bullet | undefined
        let bestScore = 0
        for (const b of next) {
          const s = jaccard(text, b.text)
          if (s > bestScore) [best, bestScore] = [b, s]
        }
        if (best && bestScore >= DEDUPE_THRESHOLD) {
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
        const text = (delta.text ?? "").trim()
        const bad = lint(text)
        if (bad) {
          reject(delta, bad)
          break
        }
        target.text = text
        applied.push({ ...delta, text })
        break
      }
      case "REMOVE": {
        if (!find(delta.id)) {
          reject(delta, "unknown bullet id")
          break
        }
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
        if (delta.op === "HELPFUL") target.helpful++
        else target.harmful++
        applied.push(delta)
        break
      }
      default:
        reject(delta, "unknown op")
    }
  }

  const doomed = next.filter((b) => b.harmful >= AUTO_REMOVE_MIN_HARMFUL && b.harmful > b.helpful)
  for (const b of doomed) applied.push({ op: "REMOVE", id: b.id, reason: "auto-removed: harmful outweighs helpful", note: "auto-remove" })
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

  return { next, applied, rejected }
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

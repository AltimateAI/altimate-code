// altimate_change - new file
//
// Deterministic, pure curator. The reflector (an LLM) only proposes deltas; this
// module decides what actually lands in the playbook. Because the playbook is
// auto-loaded into every teammate's system prompt once published, ADD/EDIT text
// is linted hard: a bullet that fails lint is rejected, never repaired.
import { newId, type Bullet } from "./playbook"
import { hasHighEntropyToken, hasSecretPattern } from "./digest"
import { sharedAnchors } from "./anchors"

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
  supersedes?: string
  coexists?: string[]
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
    "looks like prompt injection",
    /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|guidance)|\bdisregard\b|\bsystem\s+prompt\b|<\/?\s*(?:auto_loaded_skill|available_skills|system|assistant|user|instructions?)\b|\byou\s+are\s+now\b|\bnew\s+instructions\b/i,
  ],
]

// Each rule finds actions independently; negation belongs to the adjacent action, never its clause.
const VERIFICATION_TARGET = String.raw`(?:tests?|testing|checks?|ci|reviews?|lint\w*|hooks?|validation|verification|builds?|failures?|errors?|warnings?|contracts?|quality\s+gates?)`
const NEARBY_TARGET = String.raw`(?:[\w'’-]+\s+){0,6}?${VERIFICATION_TARGET}\b`
const VERIFICATION_BYPASS = new RegExp(
  String.raw`(?<![\w-])(?:skip(?:ping|s|ped)?|omit(?:ting|s|ted)?|disabl(?:e|es|ed|ing)|bypass(?:ing|es|ed)?|ignor(?:e|es|ed|ing)|exclud(?:e|es|ed|ing)|turn(?:ing|s|ed)?\s+off),?\s+(?=${NEARBY_TARGET})`,
  "gi",
)
const OPTIONAL_VERIFICATION = new RegExp(String.raw`\btreat(?:ing|s|ed)?\s+${NEARBY_TARGET}(?:\s+checks?)?\s+as\s+optional\b`, "gi")
// Keep every flag of one command together, but stop before another command or instruction.
const COMMAND_GAP = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?!\b(?:git|dbt|and|or|nor|but|however|then|yet|instead)\b)[^.;,\n"'])`
const EXPLICIT_BYPASS = new RegExp(
  String.raw`(?:\b(?:use|using|run|running)\s+)?(?:\bgit\s+(?:commit\b${COMMAND_GAP}{0,120}\s(?:-n\b|--no-verify\b)|-n\s+commit\b)|--no-verify|\bdbt\s+(?:test|build)\b${COMMAND_GAP}{0,100}--exclude(?:\s+|=)["']?(?:test(?:_type)?|resource_type:test)\b)`,
  "gi",
)
const MISSING_VERIFICATION = /\bwithout\s+(?:running\s+)?(?:the\s+)?(?:tests?|checks?)\b|\bno\s+need\s+to\s+(?:run|test|verify|check)\b/gi
const ADVERB = String.raw`(?:ever|even|just|always|[\w-]+ly)`
const ADJACENT_NEGATION = new RegExp(String.raw`\b(?:do\s+not|don['’]?t|never|avoid|must\s+not|should\s+not|no)\s+(?:${ADVERB}\s+)*$`, "i")
const OR_CONTINUATION = new RegExp(String.raw`^([\w'’\s-]*),?\s+\b(?:or|nor)\s+(?:${ADVERB}\s+)*$`, "i")
const OTHER_CONJUNCTION = /\b(?:and|but|however|then|yet|instead|or|nor)\b/i
const RUN_VERIFICATION = /\brun\s+(?:[\w'’-]+\s+){0,6}?(?:dbt|tests?|testing|lint\w*|checks?)\b/gi

function weakensVerification(text: string): boolean {
  const plain = text.replace(/`/g, "")
  const actions: Array<{ start: number; end: number }> = []
  // The lookahead leaves later verbs available to this same rule, even when target windows overlap.
  for (const match of plain.matchAll(VERIFICATION_BYPASS)) {
    actions.push({ start: match.index, end: match.index + match[0].trimEnd().length })
  }
  const explicit = [...plain.matchAll(EXPLICIT_BYPASS)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  actions.push(...explicit)
  for (const rule of [OPTIONAL_VERIFICATION, MISSING_VERIFICATION]) {
    for (const match of plain.matchAll(rule)) actions.push({ start: match.index, end: match.index + match[0].length })
  }
  actions.sort((a, b) => a.start - b.start)

  let previous: { end: number; negated: boolean } | undefined
  for (const action of actions) {
    const between = previous && plain.slice(previous.end, action.start)
    // Only an explicit or/nor joins a second bypass to the first prohibition. An intervening
    // conjunction, comma-separated instruction, or sentence starts a fresh instruction.
    const connector = between?.match(OR_CONTINUATION)
    const continued = previous?.negated && connector && !OTHER_CONJUNCTION.test(connector[1])
    const negated = ADJACENT_NEGATION.test(plain.slice(0, action.start)) || !!continued
    if (!negated) return true
    previous = { end: action.end, negated }
  }

  // A direct prohibition on running verification is itself a bypass. A prohibition on a known
  // bypass command ("Do not run dbt build --exclude test") has the opposite meaning.
  for (const match of plain.matchAll(RUN_VERIFICATION)) {
    if (ADJACENT_NEGATION.test(plain.slice(0, match.index))
      && !explicit.some((action) => action.start <= match.index && match.index < action.end)) return true
  }
  return false
}

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
  if (weakensVerification(t)) return "weakens verification"
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
  /** Model input before the lock was reacquired; destructive deltas must still match its text. */
  snapshot?: Bullet[]
  /**
   * Short hash of this reflection's feedback. One reflection applies at most one
   * HARMFUL per bullet and counts once toward its distinct-feedback total.
   * Without it, HARMFUL marks accumulate but can never auto-remove.
   */
  feedbackId?: string
  /** Prior HARMFUL provenance (from local state). Not read from the playbook: it is published. */
  harmfulFrom?: HarmfulFrom
  /** Earlier curation in this reflection: share budgets, counter guards and minted ids. */
  priorApplied?: Applied[]
}

export function curate(current: Bullet[], deltas: Delta[], opts: CurateOptions = {}): CurateResult {
  const mint = opts.newId ?? newId
  const priorApplied = opts.priorApplied ?? []
  let next = current.map((b) => ({ ...b }))
  const applied: Applied[] = []
  const rejected: Rejected[] = []
  const snapshot = opts.snapshot && new Map(opts.snapshot.map((b) => [b.id, b.text]))
  const currentText = new Map(current.map((b) => [b.id, b.text]))
  const changed = (id: string | undefined) => id !== undefined && snapshot !== undefined && snapshot.get(id) !== currentText.get(id)
  const staleReason = "changed concurrently; will be reconsidered"
  // Reject before deriving contradiction evidence: stale HARMFUL/REMOVE must not authorize an ADD
  // to implicitly supersede a newer rule. Compare against current, not our own edits within this pass.
  deltas = deltas.filter((delta) => {
    const target = delta.op === "EDIT" || delta.op === "REMOVE" || delta.op === "HARMFUL" ? delta.id : delta.supersedes
    if (!changed(target)) return true
    rejected.push({ delta, reason: staleReason })
    return false
  })
  let adds = priorApplied.filter((a) => a.op === "ADD" && !a.supersedes).length
  let edits = priorApplied.filter((a) => a.op === "EDIT" || (a.op === "ADD" && a.supersedes)).length
  let removes = priorApplied.filter((a) => a.op === "REMOVE" && !a.note).length
  const harmfulFrom: HarmfulFrom = {}
  const harmedNow = new Set(priorApplied.flatMap((a) => a.op === "HARMFUL" && a.id ? [a.id] : []))
  // One reflection moves a bullet's helpful counter by at most 1, however many deltas (or duplicate ADDs) say so.
  const helpedNow = new Set(priorApplied.flatMap((a) => a.op === "HELPFUL" && a.id ? [a.id] : []))
  for (const b of next) {
    // A counter lower than the recorded hashes means it was reset (rollback, hand edit): trust the counter.
    const prior = (opts.harmfulFrom?.[b.id] ?? []).slice(0, b.harmful)
    if (prior.length) harmfulFrom[b.id] = prior
  }
  // Bullets added in this pass are not evicted for being new (score 0): that would
  // make every ADD at the cap a no-op. They go only if nothing else can.
  const fresh = new Set(priorApplied.flatMap((a) => a.op === "ADD" && a.id ? [a.id] : []))
  const taken = new Set([...current.map((b) => b.id), ...priorApplied.flatMap((a) => a.id ? [a.id] : [])])
  // Evidence must precede overlap decisions, regardless of the reflector's delta order.
  const contradicted = new Set(current.filter((b) => b.harmful > b.helpful).map((b) => b.id))
  for (const delta of [...priorApplied, ...deltas]) {
    if (delta.id && (delta.op === "HARMFUL" || delta.op === "REMOVE")) contradicted.add(delta.id)
  }
  const positions = new Map(current.map((b, i) => [b.id, i]))
  const removed = new Map<string, Bullet>()
  const superseded = new Map<string, Bullet>()

  const find = (id: string | undefined) => (id ? next.find((b) => b.id === id) : undefined)
  const reject = (delta: Delta, reason: string) => rejected.push({ delta, reason })
  const relationships = (delta: Delta): string | undefined => {
    if (delta.supersedes !== undefined && !find(delta.supersedes))
      return `unknown supersedes bullet id ${delta.supersedes}`
    for (const id of delta.coexists ?? []) {
      if (!find(id)) return `unknown coexists bullet id ${id}`
      if (id === (delta.op === "EDIT" ? delta.id : delta.supersedes))
        return `coexists must name a different surviving bullet: ${id}`
    }
    return undefined
  }
  const overlap = (text: string, delta: Delta, except?: string): string | undefined => {
    const conflicts = next.flatMap((b) => {
      if (b.id === except || delta.coexists?.includes(b.id)) return []
      const shared = sharedAnchors(text, b.text)
      return shared.length ? [`${b.id} on ${shared.join(", ")}`] : []
    })
    if (conflicts.length)
      return `overlaps ${conflicts.join("; ")}: EDIT it, or ADD with "supersedes" or "coexists"`
    return undefined
  }

  for (const delta of deltas) {
    switch (delta.op) {
      case "ADD": {
        const bad = lint(delta.text ?? "")
        if (bad) {
          reject(delta, bad)
          break
        }
        const text = normalizeText(delta.text ?? "").trim()
        const invalid = relationships(delta)
        if (invalid) {
          reject(delta, invalid)
          break
        }
        // Keep earlier REMOVEs available for in-place supersession until this pass ends.
        const overlaps = [...next, ...removed.values()]
          .filter((b) => !delta.coexists?.includes(b.id) && sharedAnchors(text, b.text).length)
          .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!)
        const implicit = delta.supersedes === undefined && overlaps.length && overlaps.every((b) => contradicted.has(b.id))
          ? overlaps
          : []
        if (implicit.some((b) => changed(b.id))) {
          reject(delta, staleReason)
          break
        }
        if (delta.supersedes === undefined && !implicit.length) {
          let best: Bullet | undefined
          let bestScore = 0
          for (const b of next) {
            if (delta.coexists?.includes(b.id)) continue
            if (contradicted.has(b.id) && sharedAnchors(text, b.text).length) continue
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
        }
        const conflict = implicit.length ? undefined : overlap(text, delta, delta.supersedes)
        if (conflict) {
          reject(delta, conflict)
          break
        }
        const replacing = delta.supersedes !== undefined || implicit.length > 0
        if (replacing ? edits >= MAX_EDITS : adds >= MAX_ADDS) {
          reject(delta, `edit budget exceeded (max ${replacing ? MAX_EDITS : MAX_ADDS} ${replacing ? "EDITs" : "ADDs"} per reflection)`)
          break
        }
        const id = mint(taken)
        taken.add(id)
        const replacingId = delta.supersedes ?? implicit[0]?.id
        positions.set(id, replacingId ? positions.get(replacingId)! : taken.size)
        const bullet: Bullet = { id, text, helpful: 0, harmful: 0 }
        if (delta.coexists?.length) bullet.coexists = [...new Set(delta.coexists)]
        if (replacing) {
          edits++
          const targets = implicit.length ? implicit : [find(replacingId)!]
          for (const old of targets) {
            superseded.set(old.id, old)
            removed.delete(old.id)
            next = next.filter((b) => b.id !== old.id)
            const removal = applied.findIndex((a) => a.op === "REMOVE" && a.id === old.id)
            const entry: Applied = { op: "REMOVE", id: old.id, text: old.text, reason: `superseded by ${id}`, note: "superseded" }
            if (removal >= 0) applied[removal] = entry
            else applied.push(entry)
          }
          const index = next.findIndex((b) => positions.get(b.id)! > positions.get(id)!)
          next.splice(index < 0 ? next.length : index, 0, bullet)
        } else {
          adds++
          next.push(bullet)
        }
        fresh.add(id)
        applied.push({ ...delta, id, text, ...(implicit.length ? { supersedes: replacingId, note: "implicit supersede" } : {}) })
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
        const text = normalizeText(delta.text ?? "").trim()
        const invalid = relationships(delta) ?? overlap(text, delta, target.id)
        if (invalid) {
          reject(delta, invalid)
          break
        }
        if (edits >= MAX_EDITS) {
          reject(delta, `edit budget exceeded (max ${MAX_EDITS} EDITs per reflection)`)
          break
        }
        edits++
        // Compatibility was declared for the old text; an edit must declare it anew.
        for (const b of next) {
          if (b.coexists?.includes(target.id)) b.coexists = b.coexists.filter((id) => id !== target.id)
        }
        target.text = text
        delete target.coexists
        if (delta.coexists?.length) target.coexists = [...new Set(delta.coexists)]
        applied.push({ ...delta, text })
        break
      }
      case "REMOVE": {
        if (delta.id && superseded.has(delta.id)) break
        const target = find(delta.id)
        if (!target) {
          reject(delta, "unknown bullet id")
          break
        }
        if (removes >= MAX_REMOVES) {
          reject(delta, `edit budget exceeded (max ${MAX_REMOVES} REMOVEs per reflection)`)
          break
        }
        removes++
        removed.set(target.id, target)
        next = next.filter((b) => b.id !== delta.id)
        applied.push(delta)
        break
      }
      case "HELPFUL":
      case "HARMFUL": {
        const target = find(delta.id) ?? (delta.op === "HARMFUL" && delta.id ? superseded.get(delta.id) : undefined)
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
    // A newer lesson is protected from eviction just as it is from a stale REMOVE.
    const hasOlder = next.some((b) => !changed(b.id) && !fresh.has(b.id))
    let victim = -1
    for (let i = 0; i < next.length; i++) {
      if (changed(next[i].id) || (hasOlder && fresh.has(next[i].id))) continue
      if (victim < 0 || next[i].helpful - next[i].harmful < next[victim].helpful - next[victim].harmful) victim = i
    }
    if (victim < 0) break
    applied.push({ op: "REMOVE", id: next[victim].id, reason: `evicted: over the ${MAX_BULLETS}-bullet cap`, note: "cap eviction" })
    next.splice(victim, 1)
  }

  for (const id of Object.keys(harmfulFrom)) if (!next.some((b) => b.id === id)) delete harmfulFrom[id]
  const surviving = new Set(next.map((b) => b.id))
  for (const b of next) {
    if (!b.coexists) continue
    b.coexists = b.coexists.filter((id) => surviving.has(id))
    if (!b.coexists.length) delete b.coexists
  }
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

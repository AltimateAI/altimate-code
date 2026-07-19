// Deterministic normalizer for TraceFile (see tracing.ts).
//
// Design: a VERSIONED ALLOWLIST PROJECTION, not a scrub blacklist. Every field
// at every fixed-schema level (TraceFile, metadata, TraceSpan, span.model,
// span.tool, span.tokens, summary, summary.tokens, summary.topTools[]
// elements, summary.loops[] elements) is explicitly classified below as
// stable-keep / volatile-drop / volatile-canonicalize. `assertKnownKeys` fails
// LOUDLY on any field tracing.ts adds that hasn't been classified here, so the
// normalizer can never silently start hiding — or silently start leaking — a
// new field. Freeform payloads (span.input/output/attributes, and the two
// derived English-text fields, summary.narrative and the root span's closing
// `output`) cannot be schema-validated field-by-field; those get pattern-based
// volatile-content scrubbing instead (`scrubDynamicTokens`).
//
// This does NOT prove full behavioral equivalence: the trace is deliberately
// lossy (user messages truncated at USER_MESSAGE_INPUT_MAX_CHARS, tool output
// capped at 10,000 chars, no copied attachments, long traces elide their
// middle past ALTIMATE_TRACE_MAX_SPANS). "No diff" means "no diff in what the
// trace records," not "no behavioral difference at all." See
// docs/internal/2026-07-18-trace-golden-e2e-technique.md for the scope this
// is limited to (S5 parity / S7 continuation corroboration — NOT an S3
// security oracle).
//
// Ordering: `logToolCall` (tracing.ts:926) appends a tool span at COMPLETION
// time, not start time, and tool calls are dispatched concurrently by BOTH
// Batch (`Promise.all`, batch.ts:158) and the parallel session/prompt.ts
// resolver — confirmed structurally: `parentSpanId: this.currentGenerationSpanId
// ?? this.rootSpanId` (tracing.ts:928) means every tool call issued within one
// step is a direct sibling under that step's generation span, with no
// sub-span distinguishing "this one was batched" from "this one wasn't." So
// raw array position for `kind: "tool"` siblings reflects completion/event-
// loop race order, not real dispatch order, full stop — there is no
// trustworthy sequential sub-case to recover among them. Every OTHER kind
// (`session`, `generation`, `user-message`, the elision-marker `span`) is
// pushed synchronously at the real moment it occurs — `logStepStart` opens a
// generation span at step START, not finish — so raw array order for those
// IS a genuine, reproducible order.
//
// `computeRanks` encodes exactly this: siblings of kind `"tool"` under a
// given parent all share ONE rank (a "concurrent bucket" — no claim of
// order among them); every other-kind sibling gets a unique, strictly
// increasing rank in its real array order. (An earlier version of this
// derived rank from startTime/endTime interval overlap instead — dropped
// because wall-clock overlap is itself a noisy heuristic: a fast sibling can
// finish before a slower one starts even when both came from the same
// `Promise.all`, which would nondeterministically reclassify a genuinely
// concurrent group as "rank-unique" on one run and "same-rank" on another.)
// `buildDfsOrdinals` then assigns ordinals by (rank, then a stable content
// key — kind + name + normalized-input digest, NOT array/original-index)
// instead of raw array order, so two independent runs of the same
// concurrent scenario assign the SAME ordinal to the SAME logical tool call
// regardless of which one happened to complete first. The `rank` also
// survives into the normalized output so match.ts can tell which sibling
// groups are single spans (safe to diff 1:1 by id) vs. genuinely concurrent
// (must be diffed as an unordered multiset) — belt-and-suspenders with the
// content-key ordinal assignment above, not a substitute for it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TraceFile, TraceSpan } from "@/altimate/observability/tracing"

export interface NormalizeOptions {
  /** Absolute path(s) to replace with `<REPO>`. Defaults to `process.cwd()`. */
  repoRoots?: string[]
  /** Absolute path(s) to replace with `<HOME>`. Defaults to `os.homedir()`. */
  homeRoots?: string[]
  /**
   * Absolute path(s) to replace with `<TMP>`. Defaults to `os.tmpdir()` plus
   * common macOS/Linux temp-dir prefixes, so goldens built on a Mac still
   * normalize traces recorded on Linux CI (and vice versa).
   */
  tmpRoots?: string[]
}

export interface NormalizedSpan {
  id: string
  parentId: string | null
  /**
   * Sibling rank under the same parent, derived from each raw span's `kind`
   * (see computeRanks) — NOT from array position or startTime/endTime
   * overlap. `kind: "tool"` siblings always share one rank (their completion
   * order is never trustworthy, by construction — see computeRanks); every
   * other kind gets a strictly increasing rank in its real, synchronous
   * chronological order. Spans sharing a rank are a concurrent group that
   * match.ts must compare as a multiset, not pair by id.
   */
  rank: number
  name: string
  kind: TraceSpan["kind"]
  status: TraceSpan["status"]
  statusMessage?: string
  interrupted?: boolean
  model?: { modelId?: string; providerId?: string; variant?: string }
  finishReason?: string
  /** Bucketed, not exact — exact token counts/costs vary by provider pricing and are not "behavior". */
  hasTokens?: boolean
  hasCost?: boolean
  /**
   * Canonicalized to `call:<ordinal-of-first-occurrence-of-this-raw-id>` — the
   * raw tool-call id itself is provider-random, but which spans share (or
   * don't share) a raw id is real, reproducible information, so it's
   * preserved as an equality/uniqueness pattern rather than dropped.
   */
  toolCallId?: string
  input?: unknown
  output?: unknown
  attributes?: Record<string, unknown>
}

export interface NormalizedTrace {
  version: number
  sessionId: "<SID>"
  metadata: {
    title?: string
    model?: string
    providerId?: string
    agent?: string
    variant?: string
    prompt?: string
    /** Arbitrary tags are scenario config, not runtime nondeterminism — kept, sorted for determinism. */
    tags?: string[]
  }
  spans: NormalizedSpan[]
  summary: {
    status: TraceFile["summary"]["status"]
    totalToolCalls: number
    totalGenerations: number
    error?: string
    /** count kept (real behavior signal); totalDuration dropped; re-sorted (count desc, name asc — see below). */
    topTools?: Array<{ name: string; count: number }>
    /** Loop detection is a real behavior signal; inputHash (a derived digest) is dropped, description is scrubbed. */
    loops?: Array<{ tool: string; count: number; description: string }>
    /** Derived English summary text; kept with cost/duration/token-count phrases scrubbed (see scrubDynamicTokens). */
    narrative?: string
  }
}

// ---------------------------------------------------------------------------
// Allowlist: every key TraceFile/TraceSpan/summary can carry, per schema
// level, and what happens to it. Any key NOT in the relevant set below is
// unclassified — assertKnownKeys throws rather than silently drop or leak it.
// ---------------------------------------------------------------------------

/** TraceFile top level. `spans`/`summary`/`metadata` handled structurally below; the rest here. */
const TRACE_FILE_KEYS = new Set([
  "version", // stable-keep
  "traceId", // volatile-drop (UUIDv7, tracing.ts:528)
  "sessionId", // volatile-drop (replaced with "<SID>")
  "startedAt", // volatile-drop (wall-clock timestamp)
  "endedAt", // volatile-drop (wall-clock timestamp)
  "metadata", // structural — see METADATA_KEYS
  "spans", // structural — see SPAN_KEYS
  "summary", // structural — see SUMMARY_KEYS
])

const METADATA_KEYS = new Set([
  "title", // stable-keep
  "model", // stable-keep
  "providerId", // stable-keep
  "agent", // stable-keep
  "variant", // stable-keep
  "prompt", // stable-keep (scrubbed for paths/dynamic tokens)
  "userId", // volatile-drop (per-user identity, not scenario behavior)
  "environment", // volatile-drop (deploy environment, not scenario behavior)
  "version", // volatile-drop (app release version — bumping it must not flap goldens)
  "tags", // stable-keep, sorted (arbitrary but scenario-configured, not runtime-random)
])

const SPAN_KEYS = new Set([
  "spanId", // volatile-drop (replaced with DFS ordinal)
  "parentSpanId", // volatile-drop (replaced with DFS ordinal)
  "name", // stable-keep (scrubbed for session/generation dynamic parts)
  "kind", // stable-keep
  "startTime", // volatile-drop (timing; not used for ordering — see computeRanks's kind-based partial order)
  "endTime", // volatile-drop (timing; not used for ordering — see computeRanks's kind-based partial order)
  "status", // stable-keep
  "statusMessage", // stable-keep (scrubbed)
  "interrupted", // stable-keep
  "model", // structural — see SPAN_MODEL_KEYS
  "finishReason", // stable-keep
  "tokens", // volatile-canonicalize — collapsed to hasTokens (exact counts vary by provider pricing)
  "cost", // volatile-canonicalize — collapsed to hasCost
  "tool", // structural — see SPAN_TOOL_KEYS
  "input", // stable-keep (scrubbed for paths/dynamic tokens)
  "output", // stable-keep (scrubbed for paths/dynamic tokens)
  "attributes", // structural — see VOLATILE_ATTRIBUTE_KEYS filtering
])

/**
 * Compile-time pin, sitting right next to `SPAN_KEYS` on purpose: if
 * `TraceSpan` (tracing.ts) gains, loses, or renames a field without
 * `SpanKeyLiteral` below being updated to match, `_SpanKeysPinnedToTraceSpan`
 * stops typechecking and `bun run typecheck` fails — unconditionally, before
 * any test even runs. `SpanKeyLiteral` is a hand-maintained literal-string
 * mirror of `SPAN_KEYS` (TypeScript has no way to turn a runtime `Set` into a
 * type), so the two must always be edited together. This is the compile-time
 * half of "reject unknown until classified"; `assertKnownKeys` below is the
 * runtime half, firing on live data (a real or synthetic trace) that a type
 * check alone can't see.
 */
type SpanKeyLiteral =
  | "spanId"
  | "parentSpanId"
  | "name"
  | "kind"
  | "startTime"
  | "endTime"
  | "status"
  | "statusMessage"
  | "interrupted"
  | "model"
  | "finishReason"
  | "tokens"
  | "cost"
  | "tool"
  | "input"
  | "output"
  | "attributes"
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type AssertTrue<T extends true> = T
// Unused by design — this type's only job is to exist and typecheck.
type _SpanKeysPinnedToTraceSpan = AssertTrue<Equals<keyof TraceSpan, SpanKeyLiteral>>

const SPAN_MODEL_KEYS = new Set(["modelId", "providerId", "variant"]) // all stable-keep

const SPAN_TOOL_KEYS = new Set([
  "callId", // volatile-canonicalize (provider-random; toolCallId is rewritten to a first-occurrence-ordinal label instead — see computeToolCallIdLabels)
  "durationMs", // volatile-drop (timing)
])

/** TraceSpan.tokens (TokenUsage) — every field volatile-drop; collapsed to hasTokens. */
const SPAN_TOKENS_KEYS = new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"])

const SUMMARY_KEYS = new Set([
  "totalTokens", // volatile-drop (exact magnitude, not behavior)
  "totalCost", // volatile-drop
  "totalToolCalls", // stable-keep
  "totalGenerations", // stable-keep
  "duration", // volatile-drop (timing)
  "status", // stable-keep
  "error", // stable-keep (scrubbed)
  "tokens", // structural — see SUMMARY_TOKENS_KEYS (all volatile-drop)
  "loops", // structural — see LOOP_ELEMENT_KEYS
  "narrative", // volatile-canonicalize — kept with embedded cost/duration/token-count scrubbed
  "topTools", // structural — see TOP_TOOL_ELEMENT_KEYS
])

/** TraceFile.summary.tokens — note: unlike TokenUsage this object has no "total" field. */
const SUMMARY_TOKENS_KEYS = new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite"])

const LOOP_ELEMENT_KEYS = new Set([
  "tool", // stable-keep
  "inputHash", // volatile-drop (derived digest, not independently meaningful once dropped from description)
  "count", // stable-keep
  "description", // stable-keep, scrubbed (embeds the inputHash as literal text — must go through scrubDynamicTokens)
])

const TOP_TOOL_ELEMENT_KEYS = new Set([
  "name", // stable-keep
  "count", // stable-keep
  "totalDuration", // volatile-drop (timing)
])

/**
 * The allowlist projection this enforces (only fields listed in `allowed`
 * survive; everything else throws) is an intentional design choice, not an
 * oversight — see the module-level comment at the top of this file. A
 * silent-drop of an unrecognized field would let a real new TraceSpan/
 * TraceFile field (added in tracing.ts) quietly vanish from every golden
 * forever with no signal; throwing instead forces a human to classify it
 * (stable-keep / volatile-drop / volatile-canonicalize) before it can be
 * normalized at all.
 */
function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string) {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new Error(
      `normalize: unknown field(s) at "${label}": ${unknown.join(", ")}. ` +
        `Classify each as stable-keep / volatile-drop / volatile-canonicalize in normalize.ts before accepting this golden.`,
    )
  }
}

const VOLATILE_ATTRIBUTE_KEYS = new Set([
  "pid",
  "hostname",
  "host",
  "cwd",
  "env",
  "platform",
  "arch",
  "nodeVersion",
  "user",
  "uid",
  "gid",
  "timestamp",
  "time",
  "date",
  "durationMs",
  "duration",
])

// ---------------------------------------------------------------------------
// Kind-based rank derivation (the partial-order fix)
// ---------------------------------------------------------------------------

interface RankedChild {
  span: TraceSpan
  originalIndex: number
}

/** Groups spans by parentSpanId, treating an unknown/dangling parentSpanId as root — same rule buildDfsOrdinals uses. */
function groupByParent(spans: TraceSpan[]): Map<string | null, RankedChild[]> {
  const knownIds = new Set(spans.map((s) => s.spanId))
  const byParent = new Map<string | null, RankedChild[]>()
  spans.forEach((span, originalIndex) => {
    const parentKey = span.parentSpanId && knownIds.has(span.parentSpanId) ? span.parentSpanId : null
    const bucket = byParent.get(parentKey)
    if (bucket) bucket.push({ span, originalIndex })
    else byParent.set(parentKey, [{ span, originalIndex }])
  })
  return byParent
}

/**
 * Derives a per-sibling-group `rank` purely from each span's own `kind`, not
 * timing. `kind: "tool"` siblings under a given parent always share ONE
 * rank — a "concurrent bucket" — because their array order reflects
 * completion time (`logToolCall` appends on finish, tracing.ts:926), and
 * both `Promise.all` dispatchers (Batch, batch.ts:158; the parallel
 * session/prompt.ts resolver) mean that order is a race outcome, not a
 * dispatch order, with no trustworthy sub-case to recover. An earlier
 * version of this function tried to recover a partial order from
 * startTime/endTime interval overlap instead: siblings whose intervals
 * don't overlap got distinct, increasing ranks (claiming a real order),
 * while overlapping ones shared a rank. That's unsound across runs — a fast
 * sibling can finish before a slower one starts even when both came from the
 * same `Promise.all` call, so whether two siblings' intervals "overlap" can
 * itself flip between two runs of the identical scenario under ordinary
 * scheduling jitter, silently reclassifying a genuinely concurrent pair as
 * rank-unique on one run and rank-tied on another — which is exactly the
 * false-positive diff this harness exists to prevent.
 *
 * Every OTHER kind (`session`, `generation`, `user-message`, the
 * elision-marker `span`) is pushed synchronously at the real moment it
 * occurs — `logStepStart` opens a generation span at step START, not finish
 * (tracing.ts:786); `logUserMessage` appends in real time (tracing.ts:761).
 * So raw array order for those kinds IS a genuine, reproducible order, and
 * each such sibling gets its own strictly increasing rank in that order.
 *
 * The concurrent-bucket treatment ONLY applies to a `kind: "tool"` span
 * whose parent is itself a `kind: "generation"` span — because that's the
 * one topology `logToolCall` actually races on (`parentSpanId:
 * this.currentGenerationSpanId ?? this.rootSpanId`, tracing.ts:928). When no
 * generation is active, `logToolCall` attaches the tool directly to the
 * session root instead, alongside ordered siblings like `user-message` and
 * `generation` — and THAT ordering is real and reproducible, not a race.
 * Blindly bucketing every `kind: "tool"` span regardless of its parent
 * erased this real order and let a reordering of a root-attached tool
 * around a user-message/generation sibling normalize byte-identically and
 * false-pass — see codex-tracegolden-code-review.md finding #4 (half A).
 */
function computeRanks(spans: TraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const byParent = groupByParent(spans)
  const ranks = new Map<string, number>()
  // Sentinel rank for the shared tool-kind bucket. Ordered ranks below start
  // at 0 and only increase, so -1 can never collide with a real ordered
  // rank — the two kinds of rank are never compared against each other
  // within one parent's sibling group.
  const TOOL_BUCKET_RANK = -1
  for (const [parentKey, siblings] of byParent) {
    const parentIsGeneration = parentKey !== null && byId.get(parentKey)?.kind === "generation"
    let nextOrderedRank = 0
    for (const { span } of siblings) {
      if (span.kind === "tool" && parentIsGeneration) {
        ranks.set(span.spanId, TOOL_BUCKET_RANK)
      } else {
        ranks.set(span.spanId, nextOrderedRank)
        nextOrderedRank += 1
      }
    }
  }
  return ranks
}

/**
 * Deterministic content key for ordering same-rank (concurrent) siblings:
 * `kind`, then `name`, then the full stably-stringified `input`, then the
 * full stably-stringified `output` — not a hash, to avoid any collision
 * risk, and `stableStringify` already produces a canonical,
 * key-order-independent serialization, so two structurally identical
 * inputs/outputs always produce the same key. This is what lets two
 * independent runs of the same concurrent scenario assign the SAME ordinal
 * to the SAME logical tool call, regardless of which one happened to
 * complete first.
 *
 * `output` is included (not just `input`) because two same-name/same-input
 * concurrent siblings that resolve to DIFFERENT outputs are, in fact,
 * distinguishable — omitting output collapsed them onto the raw-array-order
 * fallback below, which is a race outcome, not a stable key. See
 * codex-tracegolden-code-review.md finding #3.
 */
function toolContentKey(span: TraceSpan): string {
  return `${span.kind} ${span.name} ${stableStringify(span.input ?? null)} ${stableStringify(span.output ?? null)}`
}

/**
 * Builds spanId → ordinal ("s0", "s1", ...) via DFS pre-order, root-first,
 * siblings ordered by (rank, then a stable content key) rather than raw
 * array position. Rank alone already fully orders non-tool siblings (each
 * gets a unique rank from computeRanks); the content key only matters
 * WITHIN the shared tool-bucket rank, where it sorts by each span's own
 * `kind`/`name`/normalized-`input` — never by array position or completion
 * order — so two independent runs of the same concurrent scenario produce
 * the SAME ordinal assignment for the SAME logical tool call. This is what
 * makes normalize()'s OWN output order-invariant across runs, not just a
 * property match.ts has to work around downstream.
 *
 * The one case this can't fully resolve is two tool spans with
 * byte-identical (kind, name, input) — genuinely indistinguishable
 * concurrent duplicates — where the final tiebreak falls back to
 * original-index. That residual is harmless: match.ts's rank-aware multiset
 * comparison treats same-signature spans as interchangeable regardless of
 * which physical ordinal either run happened to assign them.
 */
function buildDfsOrdinals(spans: TraceSpan[], ranks: Map<string, number>): Map<string, string> {
  const byParent = groupByParent(spans)
  const ordinals = new Map<string, string>()
  let counter = 0
  const visit = (parentId: string | null) => {
    const children = byParent.get(parentId) ?? []
    const sorted = [...children].sort((a, b) => {
      const ra = ranks.get(a.span.spanId) ?? 0
      const rb = ranks.get(b.span.spanId) ?? 0
      if (ra !== rb) return ra - rb
      const ka = toolContentKey(a.span)
      const kb = toolContentKey(b.span)
      if (ka !== kb) return ka < kb ? -1 : 1
      return a.originalIndex - b.originalIndex
    })
    for (const { span } of sorted) {
      ordinals.set(span.spanId, `s${counter}`)
      counter += 1
      visit(span.spanId)
    }
  }
  visit(null)

  if (ordinals.size !== spans.length) {
    throw new Error(
      `normalize: DFS ordinal assignment covered ${ordinals.size}/${spans.length} spans — ` +
        `likely a cycle in parentSpanId links`,
    )
  }
  return ordinals
}

/**
 * Canonicalizes raw provider tool-call ids to a label based on the ordinal
 * of their FIRST DFS occurrence, so distinct raw ids map to distinct
 * labels, and two calls that (incorrectly) share one raw id map to the SAME
 * label — preserving the raw id's equality/uniqueness PATTERN without
 * leaking the literal (provider-random, non-reproducible) value.
 *
 * The prior behavior rewrote `toolCallId` to the span's OWN ordinal
 * (`call:${id}`), independent of the raw callId value entirely. That threw
 * away the one thing worth keeping: whether two spans share a raw callId at
 * all. Two sibling calls with distinct raw ids, and two calls incorrectly
 * sharing one duplicate raw id, both normalized byte-identically and
 * matched successfully — hiding an S7-relevant continuation-correctness
 * regression. See codex-tracegolden-code-review.md finding #5.
 */
function computeToolCallIdLabels(spans: TraceSpan[], ordinals: Map<string, string>): Map<string, string> {
  const withOrdinal = spans
    .filter((s) => s.tool?.callId !== undefined)
    .map((s) => ({ span: s, ordinal: ordinals.get(s.spanId) ?? "s0" }))
    .sort((a, b) => Number(a.ordinal.slice(1)) - Number(b.ordinal.slice(1)))

  const firstOrdinalByRawId = new Map<string, string>()
  for (const { span, ordinal } of withOrdinal) {
    const rawId = span.tool!.callId!
    if (!firstOrdinalByRawId.has(rawId)) {
      firstOrdinalByRawId.set(rawId, ordinal)
    }
  }

  const labels = new Map<string, string>()
  for (const { span } of withOrdinal) {
    const rawId = span.tool!.callId!
    labels.set(span.spanId, `call:${firstOrdinalByRawId.get(rawId)}`)
  }
  return labels
}

// ---------------------------------------------------------------------------
// Path scrubbing (unchanged from the prior version — still correct)
// ---------------------------------------------------------------------------

/**
 * Expands each root with its `fs.realpathSync()` resolution, so a golden
 * built with one root form (e.g. macOS's `/var/folders/...` symlink) still
 * matches a trace recorded through the other form (`/private/var/folders/...`)
 * — and vice versa. This is the fix for the platform-specific `/private<HOME>`
 * leak: `replaceAllPrefixed` (below) is literal substring replacement, so a
 * root and its realpath must BOTH be registered as scrub prefixes, longest
 * first, or whichever form isn't the literal prefix of the recorded string
 * survives as leaked text. Non-existent paths (synthetic test roots, or a
 * root for a fixture already torn down) are left as-is; realpath resolution
 * is best-effort, not required.
 */
function withRealpathVariants(roots: string[]): string[] {
  const out = new Set<string>()
  for (const root of roots) {
    if (!root) continue
    out.add(root)
    try {
      const real = fs.realpathSync(root)
      if (real) out.add(real)
    } catch {
      // Path doesn't exist (synthetic test root, torn-down fixture) — skip silently.
    }
  }
  return [...out]
}

function resolvedRoots(input: string[] | undefined, fallback: string[]): string[] {
  const roots = input && input.length > 0 ? input : fallback
  const expanded = withRealpathVariants(roots)
  // Longest-first so a nested tmp dir under a repo root (or vice versa) matches its more specific prefix.
  return [...new Set(expanded)].sort((a, b) => b.length - a.length)
}

function defaultTmpRoots(): string[] {
  return [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders"]
}

interface RootEntry {
  root: string
  placeholder: string
}

/**
 * Merges repo/home/tmp roots into a single longest-root-first list. A single
 * merged pass (rather than three separate category passes) is required
 * because a root from one category can be a strict prefix of a root from
 * another — e.g. a CliFixture's home dir is itself created inside the OS tmp
 * dir with a per-run-random suffix (`$TMPDIR/oc-cli-<random>`). If the
 * generic tmp root ran first it would consume just its own prefix and leave
 * the random suffix exposed as literal, nondeterministic text — the specific
 * (longer) home root must always win over the generic (shorter) tmp root it
 * happens to live inside.
 */
function buildRootEntries(repoRoots: string[], homeRoots: string[], tmpRoots: string[]): RootEntry[] {
  const entries: RootEntry[] = [
    ...repoRoots.map((root) => ({ root, placeholder: "<REPO>" })),
    ...homeRoots.map((root) => ({ root, placeholder: "<HOME>" })),
    ...tmpRoots.map((root) => ({ root, placeholder: "<TMP>" })),
  ]
  return entries.filter((e) => e.root).sort((a, b) => b.root.length - a.root.length)
}

// ---------------------------------------------------------------------------
// Dynamic-token scrubbing — pattern-based, for freeform text that can't be
// schema-validated field-by-field (input/output/attributes/narrative/error).
// Patterns are ordered so more-specific matches (human dates) run before
// more-general ones that could otherwise partially consume them.
// ---------------------------------------------------------------------------

// `simpleHash().toString(36)` embedded verbatim in loop-summary descriptions (tracing.ts); a signed
// 32-bit hash can toString(36) with a leading "-", matched here so the sign doesn't leak either.
const LOOP_HASH_PATTERN = /\(hash: -?[0-9a-z]+\)/g
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
// Fork-minted prefixed ids: ses_/prt_/msg_/call_ (see PartID/session id generators).
const PREFIXED_ID_PATTERN = /\b(?:ses|prt|msg|call)_[A-Za-z0-9]+\b/g
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g
// `new Date().toDateString()` shape, e.g. "Sat Jul 18 2026" — embedded verbatim in the system prompt (system.ts:87).
const HUMAN_DATE_PATTERN = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{4}\b/g
// `Platform: ${process.platform}` (system.ts:81).
const PLATFORM_LINE_PATTERN = /Platform: \S+/g
// formatDurationShort's exact output shapes (tracing.ts:396-402): "150ms", "2.3s", "1m5s".
const DURATION_PHRASE_PATTERN = /\b\d+ms\b|\b\d+\.\d+s\b|\b\d+m\d+s\b/g
// `$${cost.toFixed(4)}`-style cost strings embedded in narrative/root-span output.
const COST_PHRASE_PATTERN = /\$\d+(?:\.\d+)?/g
// A tool that creates its own scratch dir directly under the OS temp root (e.g.
// `mkdtemp` -> `$TMPDIR/diffverify-CGXm/`) leaves a per-run-random segment behind AFTER
// the `<TMP>` root prefix has been scrubbed. The driver only knows `fixture.home` and
// cannot enumerate temp dirs a tool creates, so canonicalize the entire first path
// segment under `<TMP>` to a stable placeholder — any directory a tool makes directly
// there is inherently per-run, so collapsing it keeps nested paths (`.../newfile.txt`)
// deterministic instead of flapping on the random suffix. Runs AFTER path scrubbing has
// produced the literal `<TMP>`, so it is a no-op on text that never carried a temp path.
const TMP_SUBDIR_PATTERN = /(<TMP>)\/[^\/"'\s]+/g

/** Scrubs volatile dynamic content (ids, timestamps, dates, platform, durations, costs, temp subdirs) out of freeform text. */
function scrubDynamicTokens(text: string): string {
  return text
    .replace(LOOP_HASH_PATTERN, "(hash: <HASH>)")
    .replace(UUID_PATTERN, "<UUID>")
    .replace(PREFIXED_ID_PATTERN, "<ID>")
    .replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>")
    .replace(HUMAN_DATE_PATTERN, "<DATE>")
    .replace(PLATFORM_LINE_PATTERN, "Platform: <PLATFORM>")
    .replace(DURATION_PHRASE_PATTERN, "<DUR>")
    .replace(COST_PHRASE_PATTERN, "<COST>")
    .replace(TMP_SUBDIR_PATTERN, "$1/<TMPDIR>")
}

/** Recursively replaces absolute-path prefixes anywhere inside a JSON-cloneable value with placeholders. */
function scrubPaths(value: unknown, entries: RootEntry[]): unknown {
  if (typeof value === "string") return scrubText(value, entries)
  if (Array.isArray(value)) return value.map((v) => scrubPaths(v, entries))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubPaths(v, entries)
    }
    return out
  }
  return value
}

/** Path scrubbing followed by dynamic-token scrubbing — every string that flows through input/output/attributes gets both passes. */
function scrubText(text: string, entries: RootEntry[]): string {
  let out = text
  for (const { root, placeholder } of entries) out = replaceAllPrefixed(out, root, placeholder)
  return scrubDynamicTokens(out)
}

function replaceAllPrefixed(text: string, root: string, placeholder: string): string {
  if (!root) return text
  const normalizedRoot = root.endsWith(path.sep) ? root.slice(0, -1) : root
  if (!normalizedRoot) return text
  return text.split(normalizedRoot).join(placeholder)
}

function scrubAttributes(
  attributes: Record<string, unknown> | undefined,
  entries: RootEntry[],
): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  const out: Record<string, unknown> = {}
  let any = false
  for (const [key, value] of Object.entries(attributes)) {
    if (VOLATILE_ATTRIBUTE_KEYS.has(key)) continue
    out[key] = scrubPaths(value, entries)
    any = true
  }
  return any ? out : undefined
}

// `kind: "session"` spans are named after the trace's own session id (a
// random-per-run `ses_...` identifier) and `kind: "generation"` spans are
// named `generation-<promptPartId>`, where the part id is also random-per-run
// (see tracing.ts). Neither is a filesystem path, so scrubPathString never
// touches them — they need their own targeted normalization or every trace
// flaps on its own span names.
const SESSION_NAME_PATTERN = /^ses_[A-Za-z0-9]+$/
const GENERATION_NAME_PATTERN = /^generation-.+$/

function scrubSpanName(span: TraceSpan, sessionId: string): string {
  if (span.kind === "session" && (span.name === sessionId || SESSION_NAME_PATTERN.test(span.name))) return "<SID>"
  if (span.kind === "generation" && GENERATION_NAME_PATTERN.test(span.name)) return "generation"
  return span.name
}

function normalizeSpan(
  span: TraceSpan,
  ordinals: Map<string, string>,
  ranks: Map<string, number>,
  sessionId: string,
  entries: RootEntry[],
  toolCallIdLabels: Map<string, string>,
): NormalizedSpan {
  assertKnownKeys(span as unknown as Record<string, unknown>, SPAN_KEYS, `spans[spanId=${span.spanId}]`)
  if (span.model) assertKnownKeys(span.model as unknown as Record<string, unknown>, SPAN_MODEL_KEYS, "span.model")
  if (span.tool) assertKnownKeys(span.tool as unknown as Record<string, unknown>, SPAN_TOOL_KEYS, "span.tool")
  if (span.tokens) assertKnownKeys(span.tokens as unknown as Record<string, unknown>, SPAN_TOKENS_KEYS, "span.tokens")

  const id = ordinals.get(span.spanId)
  if (!id) throw new Error(`normalize: span ${span.spanId} missing from ordinal map`)
  const parentId = span.parentSpanId ? (ordinals.get(span.parentSpanId) ?? null) : null

  const out: NormalizedSpan = {
    id,
    parentId,
    rank: ranks.get(span.spanId) ?? 0,
    name: scrubSpanName(span, sessionId),
    kind: span.kind,
    status: span.status,
  }
  if (span.statusMessage !== undefined) out.statusMessage = scrubText(span.statusMessage, entries)
  if (span.interrupted !== undefined) out.interrupted = span.interrupted
  if (span.model) {
    out.model = {
      modelId: span.model.modelId,
      providerId: span.model.providerId,
      variant: span.model.variant,
    }
  }
  if (span.finishReason !== undefined) out.finishReason = span.finishReason
  if (span.tokens !== undefined) out.hasTokens = span.tokens.total > 0
  if (span.cost !== undefined) out.hasCost = span.cost > 0
  if (span.tool?.callId !== undefined) out.toolCallId = toolCallIdLabels.get(span.spanId)
  if (span.input !== undefined) out.input = scrubPaths(span.input, entries)
  if (span.output !== undefined) out.output = scrubPaths(span.output, entries)
  const attrs = scrubAttributes(span.attributes, entries)
  if (attrs) out.attributes = attrs
  return out
}

/**
 * Normalizes a TraceFile into a diffable, deterministic shape. Idempotent and
 * stable: calling this twice on the same TraceFile with the same options
 * always produces deep-equal (and JSON.stringify-identical) output — but see
 * the module-level comment on rank ties: two DIFFERENT recordings of the same
 * scenario are only guaranteed identical ordinal assignment for
 * non-overlapping (rank-unique) siblings. Concurrent siblings must be
 * compared via match.ts's rank-aware multiset logic, not raw equality.
 *
 * Fails loudly (throws) rather than silently drop or leak an unclassified
 * field — see assertKnownKeys and the allowlist sets above.
 */
export function normalize(trace: TraceFile, options: NormalizeOptions = {}): NormalizedTrace {
  assertKnownKeys(trace as unknown as Record<string, unknown>, TRACE_FILE_KEYS, "TraceFile")
  assertKnownKeys(trace.metadata as unknown as Record<string, unknown>, METADATA_KEYS, "metadata")
  assertKnownKeys(trace.summary as unknown as Record<string, unknown>, SUMMARY_KEYS, "summary")
  if (trace.summary.tokens) {
    assertKnownKeys(trace.summary.tokens as unknown as Record<string, unknown>, SUMMARY_TOKENS_KEYS, "summary.tokens")
  }
  for (const t of trace.summary.topTools ?? []) {
    assertKnownKeys(t as unknown as Record<string, unknown>, TOP_TOOL_ELEMENT_KEYS, "summary.topTools[]")
  }
  for (const l of trace.summary.loops ?? []) {
    assertKnownKeys(l as unknown as Record<string, unknown>, LOOP_ELEMENT_KEYS, "summary.loops[]")
  }

  const repoRoots = resolvedRoots(options.repoRoots, [process.cwd()])
  const homeRoots = resolvedRoots(options.homeRoots, [os.homedir()])
  const tmpRoots = resolvedRoots(options.tmpRoots, defaultTmpRoots())
  const entries = buildRootEntries(repoRoots, homeRoots, tmpRoots)

  const ranks = computeRanks(trace.spans)
  const ordinals = buildDfsOrdinals(trace.spans, ranks)
  const toolCallIdLabels = computeToolCallIdLabels(trace.spans, ordinals)
  const spans = trace.spans
    .map((span) => normalizeSpan(span, ordinals, ranks, trace.sessionId, entries, toolCallIdLabels))
    // Canonical order: DFS order (== ordinal order), not raw storage order. This makes the diff
    // robust to append-order jitter between two structurally-identical runs (e.g. two spans opened
    // in the same tick finishing in a different wall-clock order) while still preserving the
    // parent/child hierarchy and each parent's own rank-derived child ordering.
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))

  const topTools = trace.summary.topTools
    ?.map((t) => ({ name: t.name, count: t.count }))
    // count desc (real signal) then name asc (deterministic tiebreak) — the raw topTools array ties
    // on Map-insertion order, which is completion order and therefore not reproducible (tracing.ts:1332).
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const loops = trace.summary.loops
    ?.map((l) => ({
      tool: l.tool,
      count: l.count,
      description: scrubDynamicTokens(l.description),
    }))
    // Multiple loops retain first-detection/completion order in the raw summary, which is not
    // reproducible across runs. Sort by a stable semantic key: tool name, then count, then the
    // (already-scrubbed) description as a final tiebreak.
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.count - b.count || a.description.localeCompare(b.description))

  return {
    version: trace.version,
    sessionId: "<SID>",
    metadata: {
      title: trace.metadata.title,
      model: trace.metadata.model,
      providerId: trace.metadata.providerId,
      agent: trace.metadata.agent,
      variant: trace.metadata.variant,
      prompt: trace.metadata.prompt ? scrubText(trace.metadata.prompt, entries) : trace.metadata.prompt,
      tags: trace.metadata.tags ? [...trace.metadata.tags].sort() : undefined,
    },
    spans,
    summary: {
      status: trace.summary.status,
      totalToolCalls: trace.summary.totalToolCalls,
      totalGenerations: trace.summary.totalGenerations,
      error: trace.summary.error ? scrubText(trace.summary.error, entries) : trace.summary.error,
      topTools,
      loops,
      narrative: trace.summary.narrative ? scrubDynamicTokens(trace.summary.narrative) : trace.summary.narrative,
    },
  }
}

/** Deterministic key order for stable JSON.stringify comparisons across two normalize() calls. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2)
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

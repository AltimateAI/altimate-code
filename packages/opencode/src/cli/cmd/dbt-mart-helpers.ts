// altimate_change start — dbt-mart-helpers: shared pure helpers for the dbt mart
// optimizer commands (dbt-optimize, dbt-parity, dbt-impact, dbt-factor).
// Manifest lookup, proof normalization, and the compiled-SQL → raw-model mapper
// that decides whether an engine rewrite can be written back into a dbt model
// without losing its Jinja. No yargs import, so all of it is unit-testable.
import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import { createTwoFilesPatch } from "diff"

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestNode {
  unique_id?: string
  name?: string
  resource_type?: string
  original_file_path?: string
  patch_path?: string | null
  raw_code?: string
  compiled_code?: string | null
  relation_name?: string | null
  config?: Record<string, unknown>
  depends_on?: { nodes?: string[] }
  [key: string]: unknown
}

export interface Manifest {
  nodes?: Record<string, ManifestNode>
  child_map?: Record<string, string[]>
  [key: string]: unknown
}

export type ManifestLoad = { ok: true; manifest: Manifest; path: string } | { ok: false; error: string }

/** Resolve and parse the manifest. An explicit path must exist; otherwise the
 *  conventional `<project>/target/manifest.json` is required — these commands
 *  need the model's file path and compiled SQL, which only the manifest has. */
export function loadManifest(projectDir: string, manifestArg?: string): ManifestLoad {
  const p = manifestArg ? path.resolve(manifestArg) : path.join(projectDir, "target", "manifest.json")
  if (!existsSync(p) || !statSync(p).isFile())
    return {
      ok: false,
      error: manifestArg
        ? `manifest not found: ${p}`
        : `no manifest at ${p} — run \`dbt compile\` (not just \`dbt parse\`: the compiled SQL is needed) or pass --manifest`,
    }
  try {
    return { ok: true, manifest: JSON.parse(readFileSync(p, "utf-8")) as Manifest, path: p }
  } catch (e) {
    return { ok: false, error: `cannot read manifest ${p}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** A model node by name or unique_id. Ambiguous names (two packages) resolve to
 *  the root-project candidate only when exactly one is not from a dependency. */
export function findModel(manifest: Manifest, name: string): ManifestNode | undefined {
  const nodes = Object.values(manifest.nodes ?? {}).filter((n) => n.resource_type === "model")
  const byId = nodes.find((n) => n.unique_id === name)
  if (byId) return byId
  const matches = nodes.filter((n) => n.name === name)
  return matches.length === 1 ? matches[0] : undefined
}

/** Direct downstream models of a node (from `child_map`, models only). */
export function downstreamModels(manifest: Manifest, uniqueId: string): ManifestNode[] {
  const kids = manifest.child_map?.[uniqueId] ?? []
  return kids
    .map((id) => manifest.nodes?.[id])
    .filter((n): n is ManifestNode => !!n && n.resource_type === "model")
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

export type ProofStatus = "proven" | "refuted" | "undecidable" | "invalid_sql" | "unknown"

export interface ProofDifference {
  aspect?: string
  description?: string
  severity?: string
}

export interface NormalizedProof {
  status: ProofStatus
  confidence?: number
  differences: ProofDifference[]
  reason?: string
}

/** The engine tags its proof enum as `verdict` today; the plan spoke of
 *  `kind`. Accept both, and a bare string. An unrecognized value is
 *  `unknown`, which every caller treats like `undecidable` — never as proven. */
export function normalizeProof(p: unknown): NormalizedProof {
  if (typeof p === "string") return { status: proofStatus(p), differences: [] }
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>
  const status = proofStatus(o.verdict ?? o.kind ?? o.status)
  return {
    status,
    confidence: typeof o.confidence === "number" ? o.confidence : undefined,
    differences: Array.isArray(o.differences) ? (o.differences as ProofDifference[]) : [],
    reason: typeof o.reason === "string" ? o.reason : undefined,
  }
}

function proofStatus(v: unknown): ProofStatus {
  const s = typeof v === "string" ? v.toLowerCase() : ""
  if (s === "proven" || s === "refuted" || s === "undecidable" || s === "invalid_sql") return s
  return "unknown"
}

/** One line for a proof: status plus the evidence that status needs. */
export function formatProof(p: NormalizedProof): string {
  switch (p.status) {
    case "proven":
      return `PROVEN equivalent${p.confidence !== undefined ? ` (confidence ${p.confidence})` : ""}`
    case "refuted": {
      const d = p.differences.map((x) => `${x.aspect ? `${x.aspect}: ` : ""}${x.description ?? ""}`).filter(Boolean)
      return `REFUTED — ${d.length ? d.join("; ") : "differences not stated"}`
    }
    case "invalid_sql":
      return `INVALID SQL — ${p.reason ?? "the rewrite does not bind"} (never applicable)`
    case "undecidable":
      return `UNDECIDABLE — ${p.reason ?? "no reason given"} (a data parity run is the only remaining bar)`
    default:
      return "UNKNOWN proof status (treated as undecidable)"
  }
}

// ---------------------------------------------------------------------------
// Compiled SQL → raw model mapping
// ---------------------------------------------------------------------------

/** A Jinja expression in the raw model and what it rendered to. */
export interface JinjaBinding {
  jinja: string
  rendered: string
}

export type Alignment =
  | { ok: true; header: string; bindings: JinjaBinding[]; droppedJinjaComments: boolean }
  | { ok: false; reason: string }

const EXPR = /\{\{[\s\S]*?\}\}/g
const REF_LIKE = /^\{\{-?\s*(ref|source)\s*\(/
const CONFIG = /^\{\{-?\s*config\s*\(/
const THIS = /^\{\{-?\s*this\s*-?\}\}$/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A literal raw-model segment as a regex that tolerates whitespace changes. */
function literalPattern(seg: string): string {
  return seg
    .split(/\s+/)
    .filter((t) => t.length)
    .map(escapeRegex)
    .join("\\s+")
}

/**
 * Align a raw dbt model with its compiled SQL. Succeeds only when the raw
 * model's Jinja is limited to `config()` (renders to nothing), `ref()`,
 * `source()` and `this` — i.e. when the compiled SQL IS the raw body with
 * relation names substituted. Anything else (control flow, macros, `var()`)
 * means the compiled text was produced by code a rewrite cannot be mapped
 * back through, and the alignment refuses with the reason.
 */
export function alignRawToCompiled(raw: string, compiled: string): Alignment {
  const statement = raw.match(/\{%-?\s*(\w+)/)
  if (statement)
    return {
      ok: false,
      reason: `the model uses Jinja control flow (\`{% ${statement[1]} … %}\`), so its compiled SQL is one branch of a template — a rewrite of it cannot be written back over the template safely`,
    }
  const src = raw.replace(/\{#[\s\S]*?#\}/g, "")

  const exprs = [...src.matchAll(EXPR)]
  let header = ""
  const parts: string[] = []
  const captureExprs: string[] = []
  let last = 0
  for (const m of exprs) {
    const e = m[0]
    const lit = src.slice(last, m.index)
    if (lit.trim()) parts.push(literalPattern(lit))
    if (CONFIG.test(e)) {
      if (captureExprs.length || src.slice(0, m.index).trim())
        return { ok: false, reason: "the `{{ config() }}` block is not at the top of the model" }
      // The header is taken from the RAW text so Jinja comments above the
      // config block survive.
      header = raw.slice(0, raw.indexOf(e) + e.length)
    } else if (REF_LIKE.test(e) || THIS.test(e)) {
      parts.push("(.+?)")
      captureExprs.push(e)
    } else {
      return {
        ok: false,
        reason: `the model renders \`${e.length > 60 ? e.slice(0, 57) + "...}}" : e}\`, which is not a ref/source/config — its compiled output cannot be mapped back to the template`,
      }
    }
    last = (m.index ?? 0) + e.length
  }
  const tail = src.slice(last)
  if (tail.trim()) parts.push(literalPattern(tail))

  const re = new RegExp("^\\s*" + parts.join("\\s*") + "\\s*$")
  const m = compiled.match(re)
  if (!m)
    return {
      ok: false,
      reason:
        "the compiled SQL does not line up with the raw model — a stale target/ (re-run `dbt compile`), or a ref dbt renders as more than a relation name (microbatch filtering)",
    }
  const bindings: JinjaBinding[] = []
  for (const [i, jinja] of captureExprs.entries()) {
    const rendered = m[i + 1].trim()
    const prior = bindings.find((b) => b.rendered === rendered)
    // Two different Jinja expressions rendering to the same relation would make
    // the reverse mapping ambiguous.
    if (prior && normJinja(prior.jinja) !== normJinja(jinja))
      return { ok: false, reason: `two different refs render to ${rendered}; the reverse mapping is ambiguous` }
    if (!prior) bindings.push({ jinja, rendered })
  }
  const body = raw.slice(header.length)
  return { ok: true, header, bindings, droppedJinjaComments: /\{#[\s\S]*?#\}/.test(body) }
}

function normJinja(s: string): string {
  return s.replace(/\s+/g, "").replace(/"/g, "'")
}

/** Identifier parts of a rendered relation, honouring double quotes. */
export function relationParts(rendered: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"]|"")*)"|([^."\s]+)/g
  for (const m of rendered.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2])
  return out
}

/** A regex matching a relation with each part optionally quoted. */
function relationRegex(rendered: string): RegExp {
  const parts = relationParts(rendered)
  const body = parts.map((p) => `"?${escapeRegex(p)}"?`).join("\\s*\\.\\s*")
  return new RegExp(`(?<![\\w."])${body}(?![\\w"])`, "gi")
}

export type RawMapping =
  | { ok: true; sql: string; warnings: string[] }
  | { ok: false; reason: string }

/** Comparable form of SQL: no comments, collapsed whitespace, no quotes, lowercase. */
export function normalizeSqlText(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * Map an engine rewrite of a model's COMPILED SQL back onto its RAW file.
 *
 * Safe only when (1) the raw model aligns with its compiled SQL (see
 * {@link alignRawToCompiled}), (2) the proposal's `before_sql` is that compiled
 * SQL (not a fragment), and (3) every relation in the rewrite maps back to a
 * ref/source. Each failure is a refusal with the reason; the caller prints the
 * compiled-SQL patch instead and does not write.
 */
export function mapRewriteToRaw(input: {
  raw: string
  compiled: string
  beforeSql: string
  afterSql: string
}): RawMapping {
  const align = alignRawToCompiled(input.raw, input.compiled)
  if (!align.ok) return align
  if (normalizeSqlText(input.beforeSql) !== normalizeSqlText(input.compiled))
    return {
      ok: false,
      reason:
        "the proposal's before_sql is not the model's compiled SQL (a fragment, or a different compile) — applying its after_sql would replace more than it rewrote",
    }
  let body = input.afterSql.trim()
  const ordered = [...align.bindings].sort((a, b) => b.rendered.length - a.rendered.length)
  for (const b of ordered) body = body.replace(relationRegex(b.rendered), () => b.jinja)
  // Anything still spelled as a schema-qualified relation of a binding was not
  // mapped (e.g. re-quoted differently) and would hardcode an environment.
  for (const b of align.bindings) {
    const parts = relationParts(b.rendered)
    if (parts.length < 2) continue
    const tail = parts.slice(-2)
    const re = new RegExp(`"?${escapeRegex(tail[0])}"?\\s*\\.\\s*"?${escapeRegex(tail[1])}"?(?![\\w"])`, "i")
    if (re.test(body))
      return {
        ok: false,
        reason: `the rewrite references ${b.rendered} in a form that could not be mapped back to \`${b.jinja}\``,
      }
  }
  const warnings: string[] = []
  const rawBody = input.raw.slice(input.raw.indexOf(align.header) + align.header.length)
  if (/--|\/\*/.test(rawBody) && !/--|\/\*/.test(body))
    warnings.push("the engine's rewrite carries no SQL comments; the model's comments are dropped by this patch")
  if (align.droppedJinjaComments) warnings.push("Jinja comments ({# … #}) are dropped by this patch")
  const sql = (align.header ? align.header + "\n\n" : "") + body + "\n"
  return { ok: true, sql, warnings }
}

/** Map model-level SQL (a new model, or an edited consumer) onto Jinja:
 *  every rendered relation in `bindings` becomes its ref/source. */
export function relationsToRefs(sql: string, bindings: JinjaBinding[]): string {
  let out = sql
  for (const b of [...bindings].sort((a, c) => c.rendered.length - a.rendered.length))
    out = out.replace(relationRegex(b.rendered), () => b.jinja)
  return out
}

// ---------------------------------------------------------------------------
// Patches + misc
// ---------------------------------------------------------------------------

/** A unified diff of one file, `--- a/<file>` / `+++ b/<file>`. */
export function unifiedPatch(file: string, before: string, after: string): string {
  return createTwoFilesPatch(
    before ? `a/${file}` : "/dev/null",
    after ? `b/${file}` : "/dev/null",
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  )
    .split("\n")
    .filter((l) => !l.startsWith("====="))
    .join("\n")
}

/** POSIX-shell quote, for the follow-up commands this CLI prints. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
// altimate_change end

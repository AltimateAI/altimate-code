import { type Finding, type Severity } from "./finding"
import { type VerdictEnvelope } from "./verdict"

/**
 * Render a verdict envelope for humans (PR summary markdown) and for the VCS
 * inline-comment API. Kept separate from the engine so posting surfaces
 * (GitHub/GitLab/TUI) share one renderer.
 */

export const REVIEW_MARKER = "<!-- altimate-code-review -->"

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🛑",
  warning: "⚠️",
  suggestion: "💡",
}

const VERDICT_LABEL: Record<VerdictEnvelope["verdict"], string> = {
  APPROVE: "✅ Approved",
  COMMENT: "💬 Reviewed with comments",
  REQUEST_CHANGES: "🛑 Changes requested",
}

/** One-line headline used at the top of the summary and as the check title. */
export function verdictHeadline(env: VerdictEnvelope): string {
  const { critical, warning, suggestion } = env.summary
  const counts =
    [critical && `${critical} critical`, warning && `${warning} warning`, suggestion && `${suggestion} suggestion`]
      .filter(Boolean)
      .join(", ") || "no findings"
  // tierClassified is optional in the schema — guard against externally-built
  // envelopes that mark tierForced without threading the original classification.
  const tierLabel = env.tierForced
    ? `${env.tier} tier — forced (was ${env.tierClassified ?? "unknown"})`
    : `${env.tier} tier`
  return `${VERDICT_LABEL[env.verdict]} — ${counts} (${tierLabel})`
}

/** Default size budget for the posted PR comment (characters). */
export const SUMMARY_BUDGET_CHARS = 5_000
/** The same rule on this many models or more collapses into one bullet. */
export const GROUP_MIN_MODELS = 3

export interface RenderOptions {
  /** Character budget for the comment; findings beyond it are counted, not listed.
   *  `Infinity` renders everything (local CLI output). */
  maxChars?: number
}

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker. */
export function renderSummary(env: VerdictEnvelope, opts: RenderOptions = {}): string {
  const maxChars = opts.maxChars ?? SUMMARY_BUDGET_CHARS
  const lines: string[] = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""]

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no changed model resolved against a dbt manifest, so lineage, equivalence and",
      "> data-impact checks were skipped. Wire `manifest_path` (and optionally warehouse creds) for the full verdict.",
      "",
    )
  }
  lines.push(...coverageNotes(env, budget(maxChars, NOTES_SHARE)))

  // G1 (Round 18) — surface classifier reasons when --explain-tier populated
  // them, so a customer can see why the review ran at this tier. Also surfaces
  // when --force-tier bypassed the classifier (tierReasons is auto-populated).
  // Truncate the rendered summary on very large diffs: classifyPR appends one
  // reason per file forcing FULL tier (e.g. every touched schema.yml or every
  // PII column), which bloats the comment on wide PRs. The full list stays in
  // the signed envelope's tierReasons[]; the summary shows the first 8.
  if (env.tierReasons && env.tierReasons.length) {
    const RENDER_CAP = 8
    // Pick an inline-code-span fence longer than any backtick run inside `r`
    // so a path like `packages/…/foo`bar`.sql` cannot terminate the span
    // (cubic-review P3).
    const spans = env.tierReasons.slice(0, RENDER_CAP).map((r) => {
      const runs = r.match(/`+/g)
      const maxRun = runs ? Math.max(...runs.map((run) => run.length)) : 0
      const fence = "`".repeat(maxRun + 1)
      // If the reason itself starts/ends with a backtick, pad with a space so
      // the leading/trailing backtick isn't glued to the fence.
      const pad = /^`|`$/.test(r) ? " " : ""
      return `${fence}${pad}${r}${pad}${fence}`
    })
    // Whole reasons only, within the tier line's share of the budget.
    const prefix = `> 🧭 **Tier: ${env.tier}** — `
    const shown = takeWhole(spans, budget(maxChars, TIER_SHARE) - prefix.length - 60, ", ")
    const rest = env.tierReasons.length - shown.length
    const overflow = rest ? `${shown.length ? " " : ""}(+${rest} more in verdict envelope)` : ""
    lines.push(`${prefix}${shown.join(", ")}${overflow}`, "")
  }

  const tail: string[] = []
  if (env.override) {
    tail.push(
      `> 🔓 **Break-glass override** by @${env.override.by}: ${clip(env.override.reason, budget(maxChars, OVERRIDE_SHARE))}`,
      `> (would have been \`${env.override.priorVerdict}\`)`,
      "",
    )
  }
  tail.push(
    "---",
    `<sub>altimate dbt-pr-review · verdict \`${env.verdict}\`` +
      (env.signature ? ` · signed \`${env.signature.slice(0, 18)}…\`` : "") +
      (env.manifestHash ? ` · manifest \`${env.manifestHash.slice(0, 10)}\`` : "") +
      (env.scope?.baseRef ? ` · base \`${env.scope.baseRef}\`` : "") +
      (env.ai?.state === "ok" && env.ai.model ? ` · AI \`${env.ai.model}\`` : "") +
      "</sub>",
  )

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
    return [...lines, ...tail].join("\n")
  }

  // Findings fill the budget left after the fixed parts, most severe first.
  // Listing stops at the first bullet that does not fit, so a later, shorter
  // finding is never shown while a more severe one is hidden. What does not fit
  // is counted per severity, never silently dropped: the envelope keeps every
  // finding. The reserve keeps room for the "… N more finding(s)" line.
  const overflowReserve = 260
  let used = [...lines, ...tail].join("\n").length + overflowReserve
  const hidden: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0 }
  let full = false
  const grouped = groupBySeverity(env.findings)
  for (const sev of ["critical", "warning", "suggestion"] as const) {
    const items = grouped[sev]
    if (!items.length) continue
    // Uncapped (local) output lists every finding with its own location.
    const bullets = bulletsFor(items, maxChars !== Infinity)
    const shown: string[] = []
    let shownCount = 0
    // Room for the heading in its longest form (`k of N`).
    let headCost = `### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${items.length} of ${items.length})`.length + 3
    for (const b of bullets) {
      const cost = b.text.length + 1 + headCost
      if (full || used + cost > maxChars) {
        full = true
        hidden[sev] += b.count
        continue
      }
      shown.push(b.text)
      shownCount += b.count
      used += cost
      headCost = 0
    }
    if (!shown.length) continue
    const count = shownCount < items.length ? `${shownCount} of ${items.length}` : `${items.length}`
    lines.push(`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${count})`, "", ...shown, "")
  }
  const hiddenTotal = hidden.critical + hidden.warning + hidden.suggestion
  if (hiddenTotal) {
    const bySeverity = (["critical", "warning", "suggestion"] as const)
      .filter((sev) => hidden[sev])
      .map((sev) => `${hidden[sev]} ${sev}`)
      .join(", ")
    lines.push(
      `> … ${hiddenTotal} more finding(s) not shown (${bySeverity}) to keep this comment short — the full list is in the job log ` +
        "and in the verdict envelope (`altimate review --json --output <file>`).",
      "",
    )
  }
  return [...lines, ...tail].join("\n")
}

// Shares of the comment budget for the fixed metadata, so it never crowds out
// the findings or pushes the comment past the budget on its own.
const TIER_SHARE = 0.15
const NOTES_SHARE = 0.25
const OVERRIDE_SHARE = 0.1

/** `share` of a finite budget; unlimited stays unlimited. */
function budget(maxChars: number, share: number): number {
  return maxChars === Infinity ? Infinity : Math.floor(maxChars * share)
}

/** The leading whole units whose `sep`-joined length fits in `max`. */
function takeWhole(units: string[], max: number, sep: string): string[] {
  const out: string[] = []
  let len = 0
  for (const u of units) {
    const next = len + (out.length ? sep.length : 0) + u.length
    if (next > max) break
    out.push(u)
    len = next
  }
  return out
}

/** Free text cut at a word boundary to fit `max` (with `…`). */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, Math.max(0, max - 1))
  return `${cut.replace(/\s+\S*$/, "") || cut}…`
}

/** Backticked names blanked, so the same rule on different models/columns
 *  normalizes to the same text. */
function blankNames(s: string): string {
  return s.replace(/`[^`]*`/g, "`…`")
}

/** A finding's title without its leading `model: ` or `file: `, with its model
 *  name and backticked names blanked: the title half of the grouping key. */
function groupKeyTitle(f: Finding): string {
  const prefixes = [f.model, f.file, f.file.split("/").pop()].filter((p): p is string => !!p)
  const lead = prefixes.find((p) => f.title.startsWith(`${p}: `))
  let title = lead ? f.title.slice(lead.length + 2) : f.title
  // `Model orders modified — …`: the model named mid-title, as a whole word.
  if (f.model)
    title = title.replace(new RegExp(`(?<![\\w.])${f.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), "…")
  return blankNames(title)
}

/** The backticked values in a finding's title and body other than its own model
 *  and file: what tells one member of a group from another. */
function distinguishingValues(f: Finding): string[] {
  const own = new Set([f.model, f.file].filter(Boolean))
  const values = [...`${f.title} ${f.body}`.matchAll(/`([^`]*)`/g)].map((m) => m[1]).filter((v) => !own.has(v))
  return [...new Set(values)]
}

// A budgeted bullet's body is clipped to this, so one long finding cannot fill
// the comment and hide the titles of the most severe findings.
const BULLET_BODY_MAX = 600
// As for the title (a wide model's PII title lists every column), so a single
// bullet always fits the room the capped notes leave.
const BULLET_TITLE_MAX = 200
// A grouped bullet's model list; its body and per-model detail share
// BULLET_BODY_MAX, so a grouped bullet is no larger than a single one.
const BULLET_NAMES_MAX = 200

/** `clip`, never ending inside a code span: an unpaired backtick is cut back. */
function clipTitle(text: string, max: number): string {
  const clipped = clip(text, max)
  if (clipped === text) return clipped
  const body = clipped.slice(0, -1)
  const ticks = (body.match(/`/g) ?? []).length
  return ticks % 2 ? `${body.slice(0, body.lastIndexOf("`")).trimEnd()}…` : clipped
}

/** Render findings of one severity as bullets. With `group`, findings that say
 *  the same thing (same category, title and body once names are blanked) on
 *  GROUP_MIN_MODELS or more distinct models collapse into one bullet. */
function bulletsFor(items: Finding[], group: boolean): Array<{ text: string; count: number }> {
  // Budgeted (grouped) output clips bodies; local output keeps them whole.
  const bodyOf = (text: string) => (group ? clip(text, BULLET_BODY_MAX) : text)
  const titleOf = (text: string) => (group ? clipTitle(text, BULLET_TITLE_MAX) : text)
  const groups = new Map<string, Finding[]>()
  for (const f of items) {
    // The body is part of the key: one rule with different messages (e.g. a
    // dialect check naming different functions) is different findings.
    const key = group ? JSON.stringify([f.category, groupKeyTitle(f), blankNames(oneLine(f.body))]) : f.id
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  const out: Array<{ text: string; count: number }> = []
  for (const g of groups.values()) {
    // Group by distinct models: several findings of one rule on the SAME model
    // (e.g. two different columns) are distinct issues and stay separate bullets.
    const names = [...new Set(g.map((f) => f.model ?? f.file))]
    if (group && names.length >= GROUP_MIN_MODELS) {
      const listed = takeWhole(
        names.slice(0, 8).map((n) => `\`${n}\``),
        BULLET_NAMES_MAX,
        ", ",
      )
      const shown = listed.join(", ")
      const more = names.length > listed.length ? `${listed.length ? " " : ""}(+${names.length - listed.length} more)` : ""
      // Members that differ by more than their model (another function, a second
      // column on one model): list each member's own values.
      const values = g.map((f) => ({ f, v: distinguishingValues(f) }))
      const differ = values.some(({ v }) => v.join("\u0000") !== values[0].v.join("\u0000"))
      const hasDetail = differ && values.some(({ v }) => v.length)
      // Show a body verbatim only when every member says exactly that;
      // otherwise its names belong to one model, so show the blanked form. With
      // a per-model detail the body takes half the budget and the detail the rest.
      const same = g.every((f) => f.body === g[0].body)
      const bodyText = same ? oneLine(g[0].body) : blankNames(oneLine(g[0].body))
      const body = hasDetail ? clip(bodyText, BULLET_BODY_MAX / 2) : bodyOf(bodyText)
      // Whole entries that fit, so a cut never lands inside a code span or drops
      // the count of the rest.
      const entries = values
        .slice(0, 8)
        .map(({ f, v }) => `\`${f.model ?? f.file}\`: ${v.map((x) => `\`${x}\``).join(", ") || "—"}`)
      const kept = takeWhole(entries, BULLET_BODY_MAX - body.length, " · ")
      const rest = values.length - kept.length
      const detail = hasDetail ? `  ${kept.join(" · ")}${rest ? `${kept.length ? " " : ""}(+${rest} more)` : ""}  \n` : ""
      const unverified = g.some((f) => f.degraded) ? " · _unverified_" : ""
      out.push({
        text:
          `- **${titleOf(groupKeyTitle(g[0]))}** — ${g.length} findings across ${names.length} model(s): ${shown}${more}  \n` +
          `  ${body}  \n${detail}  <sub>${g[0].category}${unverified}</sub>`,
        count: g.length,
      })
      continue
    }
    for (const f of g) {
      const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
      out.push({
        text: `- **${titleOf(f.title)}**  \n  ${bodyOf(oneLine(f.body))}  \n  <sub>\`${loc}\`${f.degraded ? " · _unverified_" : ""} · ${f.category}</sub>`,
        count: 1,
      })
    }
  }
  return out
}

/**
 * What the review could not fully check, each on its own line: undecidable
 * findings, models without compiled SQL, files outside the dbt project, and
 * the advisory AI lane when it did not run. Kept separate from the lint-only
 * banner so one undecidable finding never mislabels a manifest-backed run.
 */
export function coverageNotes(env: VerdictEnvelope, maxChars = Infinity): string[] {
  const notes: string[] = []
  // Diagnostic reasons are clipped only in a budgeted comment; local output is whole.
  const reasonOf = (text: string) => (maxChars === Infinity ? text : clip(text, 200))
  const undecided = env.findings.filter((f) => f.degraded).length
  if (undecided) notes.push(`${undecided} finding(s) could not be decided by the engine and are marked _unverified_.`)
  const unverified = env.scope?.unverified ?? []
  if (unverified.length) {
    // One line per reason: models can lack the head compile or the base compile.
    const byReason = new Map<string, string[]>()
    for (const u of unverified) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.path])
    for (const [reason, paths] of byReason) {
      const label = `${paths.length} model(s) not verified by the engine — ${reasonOf(reason)}`
      // Whole paths only: at most 5, and within an even share of the notes budget.
      const shown = takeWhole(
        paths.slice(0, 5).map((p) => `\`${p}\``),
        maxChars / (byReason.size + 1) - label.length - 30,
        ", ",
      )
      const more = paths.length > shown.length ? `${shown.length ? " and " : " "}${paths.length - shown.length} more` : ""
      notes.push(`${label}:${shown.length ? " " : ""}${shown.join(", ")}${more}.`)
    }
    notes.push("Run `dbt compile` (and compile the base into `target-base/`) for equivalence and lineage checks.")
  }
  if (env.scope?.outOfScopeFiles)
    notes.push(`${env.scope.outOfScopeFiles} changed file(s) outside the dbt project were not reviewed.`)
  if (env.scope?.movedUnchangedFiles)
    notes.push(
      `${env.scope.movedUnchangedFiles} file(s) moved without edits (no content changes to review). ` +
        "Folder-level config in `dbt_project.yml` (`+schema`, `+materialized`, `+tags`) can still change where and how a moved model builds.",
    )
  if (env.ai && env.ai.state !== "ok") {
    const what = { skipped: "skipped", timeout: "timed out", error: "failed" }[env.ai.state]
    notes.push(`Advisory AI review ${what}${env.ai.reason ? `: ${reasonOf(env.ai.reason)}` : ""}.`)
  }
  // Whole notes within the budget; the rest are counted.
  const lines = takeWhole(
    notes.map((n) => `> ℹ️ ${n}`),
    maxChars - 80,
    "\n",
  )
  if (lines.length < notes.length) lines.push(`> ℹ️ +${notes.length - lines.length} more note(s) in the verdict envelope.`)
  return lines.length ? [...lines, ""] : []
}

/** GitHub `pulls.createReview` inline comments — only findings with a line. */
export interface InlineComment {
  path: string
  line: number
  side: "RIGHT"
  body: string
}

/** Hidden per-finding marker on inline comments, keyed by the finding's stable
 *  fingerprint (rule, file, model, column — not the line), so a rerun can tell
 *  which findings are already on the PR. */
export function findingMarker(id: string): string {
  return `<!-- altimate-finding:${id} -->`
}

/** Finding ids already posted, read from existing inline comment bodies. Only
 *  the marker `inlineComments` appends at the very end counts: one inside the
 *  body can be echoed PR text (SQL or an AI finding quoting it). */
export function postedFindingIds(bodies: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>()
  for (const b of bodies) {
    const m = /<!-- altimate-finding:([\w-]+) -->\s*$/.exec(b ?? "")
    if (m) out.add(m[1])
  }
  return out
}

/** Line numbers on the head side of a unified diff that GitHub accepts for an
 *  inline comment: added lines and context lines inside a hunk. */
export function commentableLines(diff: string | undefined): Set<number> {
  const out = new Set<number>()
  if (!diff) return out
  let right = 0
  let inHunk = false
  const rows = diff.split("\n")
  if (rows[rows.length - 1] === "") rows.pop() // the diff's trailing newline, not a line
  for (const line of rows) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      right = Number(h[1])
      inHunk = true
      continue
    }
    // File headers (`--- a/…`, `+++ b/…`) only occur outside a hunk.
    if (!inHunk || line.startsWith("\\")) continue
    // A blank context line may have lost its leading space in transit.
    if (line.startsWith("+") || line.startsWith(" ") || line === "") out.add(right++)
    else if (!line.startsWith("-")) inHunk = false
  }
  return out
}

/**
 * Inline comments for findings with a line. With `commentable` (every file the
 * PR lists, mapped to its head-side commentable lines, see `commentableLines`),
 * only lines inside the PR's diff hunks are kept: GitHub rejects the whole batch
 * over one line outside the diff. A file listed with `undefined` lines has
 * unknown hunks (GitHub omits the patch for large diffs): its lines are
 * attempted, and the 422 fallback covers a miss. A file the PR does not list
 * gets no inline comment. The finding keeps its line in the envelope and summary.
 */
export function inlineComments(
  env: VerdictEnvelope,
  alreadyPosted: Set<string> = new Set(),
  commentable?: Map<string, Set<number> | undefined>,
): InlineComment[] {
  const onDiff = (file: string, line: number) => {
    if (!commentable) return true
    if (!commentable.has(file)) return false
    const lines = commentable.get(file)
    return !lines || lines.has(line)
  }
  return env.findings
    .filter((f) => typeof f.startLine === "number" && !alreadyPosted.has(f.id) && onDiff(f.file, f.startLine))
    .map((f) => ({
      path: f.file,
      line: f.startLine!,
      side: "RIGHT" as const,
      body: `${SEVERITY_EMOJI[f.severity]} **${f.title}**\n\n${f.body}\n\n${findingMarker(f.id)}`,
    }))
}

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const out: Record<Severity, Finding[]> = { critical: [], warning: [], suggestion: [] }
  for (const f of findings) out[f.severity].push(f)
  return out
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}

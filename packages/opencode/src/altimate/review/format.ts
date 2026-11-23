import { type Finding, type Severity, type Confidence, SEVERITY_ORDER, blankNames, groupKeyTitle, verifierDemoted } from "./finding"
import { type VerdictEnvelope, type PostingPolicy, DEFAULT_POSTING_POLICY } from "./verdict"

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
/** The same finding on this many models or more collapses into one bullet. */
export const GROUP_MIN_MODELS = 2

export interface RenderOptions {
  /** Character budget for the comment; findings beyond it are counted, not listed.
   *  `Infinity` renders everything (local CLI output). */
  maxChars?: number
  /** Finding ids already commented inline on the PR (see postedFindingIds). */
  alreadyPosted?: Set<string>
  /** False when the summary is the only output (local CLI, agent tool): every
   *  finding is then rendered in full instead of as an inline one-liner. */
  inline?: boolean
  /** False renders a clean run even under `silentWhenClean` (to replace an
   *  earlier summary that listed findings). */
  allowSilent?: boolean
  /** Head-side commentable lines per file (see commentableLines): findings
   *  outside them are not posted inline, so they render in full here. */
  commentable?: Map<string, Set<number>>
}

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker.
 *  Returns `""` for a clean run under `silentWhenClean`: nothing to post. */
export function renderSummary(env: VerdictEnvelope, opts: RenderOptions = {}): string {
  const maxChars = opts.maxChars ?? SUMMARY_BUDGET_CHARS
  const notes = coverageNotes(env)
  if (
    !env.findings.length &&
    !notes.length &&
    !env.summary.degraded &&
    !env.override &&
    env.verdict === "APPROVE" &&
    opts.allowSilent !== false &&
    postingPolicy(env).silentWhenClean
  )
    return ""

  const lines: string[] = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""]

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no changed model resolved against a dbt manifest, so lineage, equivalence and",
      "> data-impact checks were skipped. Wire `manifest_path` (and optionally warehouse creds) for the full verdict.",
      "",
    )
  }
  lines.push(...notes)

  const tail: string[] = []
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
    const shown = env.tierReasons.slice(0, RENDER_CAP).map(codeSpan).join(", ")
    const overflow =
      env.tierReasons.length > RENDER_CAP
        ? ` (+${env.tierReasons.length - RENDER_CAP} more in verdict envelope)`
        : ""
    tail.push(`> 🧭 **Tier: ${env.tier}** — ${shown}${overflow}`, "")
  }
  if (env.override) {
    tail.push(
      `> 🔓 **Break-glass override** by @${env.override.by}: ${env.override.reason}`,
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
      (env.ai?.tokens ? ` · tokens ${(env.ai.tokens.inputTotal + env.ai.tokens.output).toLocaleString("en-US")}` : "") +
      "</sub>",
  )

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
    return [...lines, ...tail].join("\n")
  }

  // Findings posted inline get a one-line pointer here; the comment on the
  // diff carries the detail. Pre-existing findings sit in a collapsed list.
  const deferredIds = new Set(inlineComments(env, opts.alreadyPosted, opts.commentable).deferred.map((f) => f.id))
  const posting = postingPolicy(env)
  const inline =
    opts.inline === false
      ? []
      : env.findings.filter((f) => inlineEligible(f, posting, opts.commentable) && !deferredIds.has(f.id))
  const inlineIds = new Set(inline.map((f) => f.id))
  const preExisting = env.findings.filter((f) => f.preExisting && !inlineIds.has(f.id))
  const rest = env.findings.filter((f) => !f.preExisting && !inlineIds.has(f.id))
  if (inline.length) {
    lines.push(
      `### Inline (${inline.length})`,
      "",
      ...inline.map((f) => `- \`${f.file}:${f.startLine}\` — ${f.title}`),
      "",
    )
  }

  // Findings fill the budget left after the fixed parts, most severe first.
  // What does not fit is counted, never silently dropped: the envelope keeps
  // every finding. The reserve keeps room for the "… N more finding(s)" line.
  const overflowReserve = 220
  let used = [...lines, ...tail].join("\n").length + overflowReserve
  let hidden = 0
  // Uncapped (local) output lists every finding with its own location.
  const group = maxChars !== Infinity
  const fit = (heading: string[], bullets: Array<{ text: string; count: number }>, close: string[]) => {
    let headed = false
    for (const b of bullets) {
      const cost = b.text.length + 1 + (headed ? 0 : heading.join("\n").length + close.join("\n").length + 2)
      if (used + cost > maxChars) {
        hidden += b.count
        continue
      }
      if (!headed) {
        lines.push(...heading)
        headed = true
      }
      lines.push(b.text)
      used += cost
    }
    if (headed) lines.push(...close, "")
  }
  const grouped = groupBySeverity(rest)
  for (const sev of ["critical", "warning", "suggestion"] as const) {
    const items = grouped[sev]
    if (!items.length) continue
    fit([`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${items.length})`, ""], bulletsFor(items, group), [])
  }
  if (preExisting.length) {
    fit(
      [`<details><summary>Pre-existing (${preExisting.length})</summary>`, ""],
      bulletsFor(preExisting, group),
      ["", "</details>"],
    )
  }
  if (hidden) {
    lines.push(
      `> … ${hidden} more finding(s) not shown to keep this comment short — the full list is in the verdict envelope ` +
        "(`altimate review --json`, or the action's `--output` artifact).",
      "",
    )
  }
  return [...lines, ...tail].join("\n")
}

/** Render findings of one severity as bullets. With `group`, findings that say
 *  the same thing (same category, title and body once names are blanked) on
 *  GROUP_MIN_MODELS or more distinct models collapse into one bullet. */
function bulletsFor(items: Finding[], group: boolean): Array<{ text: string; count: number }> {
  const groups = new Map<string, Finding[]>()
  for (const f of items) {
    // The body is part of the key: one rule with different messages (e.g. a
    // dialect check naming different functions) is different findings.
    const key = group ? `${f.category}|${groupKeyTitle(f)}|${blankNames(oneLine(f.body))}` : f.id
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
      const shown = names.slice(0, 8).map((n) => `\`${n}\``).join(", ")
      const more = names.length > 8 ? ` (+${names.length - 8} more)` : ""
      // Show a body verbatim only when every member says exactly that;
      // otherwise its names belong to one model, so show the blanked form.
      const body = oneLine(clampBody(g.every((f) => f.body === g[0].body) ? g[0].body : blankNames(g[0].body)))
      const unverified = g.some((f) => f.degraded) ? " · _unverified_" : ""
      out.push({
        text:
          `- **${groupKeyTitle(g[0])}** — ${g.length} findings across ${names.length} model(s): ${shown}${more}  \n` +
          `  ${body}  \n  <sub>${g[0].category}${unverified}</sub>`,
        count: g.length,
      })
      continue
    }
    for (const f of g) {
      const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
      out.push({
        text:
          `- **${f.title}**  \n` +
          (f.evidenceLine ? `  ${evidenceText(f)}  \n` : "") +
          `  ${oneLine(clampBody(f.body))}  \n  <sub>\`${loc}\`${f.degraded ? " · _unverified_" : ""} · ${f.category}</sub>`,
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
export function coverageNotes(env: VerdictEnvelope): string[] {
  const notes: string[] = []
  const undecided = env.findings.filter((f) => f.degraded).length
  if (undecided) notes.push(`${undecided} finding(s) could not be decided by the engine and are marked _unverified_.`)
  const unverified = env.scope?.unverified ?? []
  const byReason = new Map<string, string[]>()
  for (const u of unverified) {
    const paths = byReason.get(u.reason)
    if (paths) paths.push(u.path)
    else byReason.set(u.reason, [u.path])
  }
  for (const [reason, paths] of byReason) {
    const head = paths.slice(0, 5).map((p) => `\`${p}\``).join(", ")
    const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ""
    const hint = /compiled SQL/.test(reason)
      ? " Run `dbt compile` (and compile the base into `target-base/`) for equivalence and lineage checks."
      : ""
    notes.push(`${paths.length} model(s) not fully verified — ${reason}: ${head}${more}.${hint}`)
  }
  if (env.engineErrors?.length) {
    const list = env.engineErrors.map((e) => `${e.method} ×${e.count} (${e.reason})`).join("; ")
    notes.push(`Some engine checks failed and did not run: ${list}. This verdict is not a clean approval.`)
  }
  // The ledger lists out-of-scope and moved files by path; the count lines are
  // for envelopes that carry only the counts.
  const ledger = notReviewedLedger(env)
  const listed = new Set(ledger.map((e) => e.path))
  const scopePaths = env.scope?.notReviewed ?? []
  if (env.scope?.outOfScopeFiles && !scopePaths.some((e) => /^outside the dbt project/.test(e.reason) && listed.has(e.path)))
    notes.push(`${env.scope.outOfScopeFiles} changed file(s) outside the dbt project were not reviewed.`)
  if (env.scope?.movedUnchangedFiles && !scopePaths.some((e) => /^moved without edits/.test(e.reason) && listed.has(e.path)))
    notes.push(
      `${env.scope.movedUnchangedFiles} file(s) moved without edits; their SQL was not re-reviewed. ${MOVED_HINT}`,
    )
  if (env.policy?.changedInPr?.length) {
    notes.push(
      `This PR changes the review policy (\`.altimate/review.yml\`: ${env.policy.changedInPr.join(", ")}). ` +
        "The base branch's policy was applied; the change takes effect after merge.",
    )
  }
  if (env.ai && env.ai.state !== "ok") {
    const what = { skipped: "skipped", timeout: "timed out", error: "failed" }[env.ai.state]
    notes.push(`Advisory AI review ${what}${env.ai.reason ? `: ${env.ai.reason}` : ""}.`)
  } else if (env.ai?.reason) {
    // Some calls answered and some failed: the files in the failed calls were not reviewed by the AI.
    notes.push(`Advisory AI review partly failed: ${env.ai.reason}.`)
  }
  const out = notes.length ? [...notes.map((n) => `> ℹ️ ${n}`), ""] : []
  return [...out, ...ledgerBlock(ledger)]
}

/** Paths shown in the "Not reviewed" block at most; the rest are counted. */
export const LEDGER_MAX_PATHS = 30

/** The coverage ledger minus the `unverified` entries, which have their own
 *  note above it. */
function notReviewedLedger(env: VerdictEnvelope): Array<{ path: string; reason: string }> {
  const unverified = new Set((env.scope?.unverified ?? []).map((u) => `${u.path}\0${u.reason}`))
  return (env.scope?.notReviewed ?? []).filter((e) => !unverified.has(`${e.path}\0${e.reason}`))
}

const MOVED_HINT =
  "Folder-level config in `dbt_project.yml` (`+schema`, `+materialized`, `+tags`) can still change where and how a moved model builds."

/** Collapsed "Not reviewed: n file(s)" block, grouped by reason. */
function ledgerBlock(ledger: Array<{ path: string; reason: string }>): string[] {
  if (!ledger.length) return []
  const byReason = new Map<string, string[]>()
  for (const e of ledger) byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), e.path])
  const lines = [`<details><summary>Not reviewed: ${ledger.length} file(s)</summary>`, ""]
  let shown = 0
  for (const [reason, paths] of byReason) {
    if (shown >= LEDGER_MAX_PATHS) break
    const take = paths.slice(0, LEDGER_MAX_PATHS - shown)
    shown += take.length
    // Escape Markdown emphasis so a glob like `**/*.md` in a reason renders literally.
    lines.push(`${reason.replace(/([*_])/g, "\\$1")} (${paths.length}):`, ...take.map((p) => `- ${codeSpan(p)}`))
    if (/^moved without edits/.test(reason)) lines.push("", MOVED_HINT)
    lines.push("")
  }
  if (ledger.length > shown) lines.push(`… and ${ledger.length - shown} more`, "")
  lines.push("</details>", "")
  return lines
}

/** GitHub `pulls.createReview` inline comments — only findings with a line.
 *  A multi-line range (a suggestion block) sets `start_line`/`start_side`. */
export interface InlineComment {
  path: string
  line: number
  side: "RIGHT"
  start_line?: number
  start_side?: "RIGHT"
  body: string
}

/** Rendered length cap for a finding body; the envelope keeps the full text. */
export const BODY_MAX_CHARS = 600

/** Cut `body` to at most `max` characters at a sentence boundary (a word
 *  boundary when no sentence ends late enough) and append "…". A code fence
 *  left open by the cut is closed. */
export function clampBody(body: string, max = BODY_MAX_CHARS): string {
  if (body.length <= max) return body
  const head = body.slice(0, max - 1)
  const sentence = Math.max(...[". ", "! ", "? ", ".\n", "\n\n"].map((t) => head.lastIndexOf(t)))
  const word = head.search(/\s\S*$/)
  const cut = sentence >= max / 2 ? sentence + 1 : word > 0 ? word : head.length
  let out = head.slice(0, cut).trimEnd() + "…"
  if ((out.match(/^```/gm) ?? []).length % 2) out += "\n```"
  return out
}

/** Inline code span for `s`, fenced longer than any backtick run inside it. */
function codeSpan(s: string): string {
  const runs = s.match(/`+/g)
  const fence = "`".repeat((runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1)
  // A leading/trailing backtick needs a space so it isn't glued to the fence.
  const pad = /^`|`$/.test(s) ? " " : ""
  return `${fence}${pad}${s}${pad}${fence}`
}

/** `` `file:line` — `<source line>` ``: the line a finding quotes as evidence. */
function evidenceText(f: Finding): string {
  const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
  return `\`${loc}\` — ${codeSpan(oneLine(f.evidenceLine ?? ""))}`
}

/** A GitHub suggestion block replacing the comment's line range. */
function suggestionBlock(replacement: string): string {
  const runs = replacement.match(/`{3,}/g)
  const fence = "`".repeat(Math.max(3, ...(runs ?? []).map((r) => r.length + 1)))
  return `${fence}suggestion\n${replacement}\n${fence}`
}

/** Hidden per-finding marker on inline comments, keyed by the finding's stable
 *  fingerprint (rule, file, model, column — not the line), so a rerun can tell
 *  which findings are already on the PR. */
export function findingMarker(id: string): string {
  return `<!-- altimate-finding:${id} -->`
}

/** Finding ids already posted, read from existing inline comment bodies. */
export function postedFindingIds(bodies: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>()
  for (const b of bodies) for (const m of (b ?? "").matchAll(/<!-- altimate-finding:([\w-]+) -->/g)) out.add(m[1])
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

/** The posting policy an envelope was produced under (defaults for envelopes
 *  from releases that did not record one). */
export function postingPolicy(env: VerdictEnvelope): PostingPolicy {
  return env.policy?.posting ?? DEFAULT_POSTING_POLICY
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 3, medium: 2, low: 1, unknown: 0 }

/** Whether a finding may be posted as an inline comment: an inline-tier rule
 *  (AI findings default to inline in `ruleTier`) that the verifier did not move
 *  to the summary, on a line the PR added, at or above the severity floor.
 *  With `commentable` (head-side commentable lines per file, see
 *  `commentableLines`), the line must also be inside the PR's diff hunks:
 *  GitHub rejects the whole batch over one line outside the diff. A file with
 *  no entry has unknown hunks (GitHub omits the patch for large diffs): its
 *  lines are attempted, and the 422 fallback covers a miss. */
export function inlineEligible(f: Finding, posting: PostingPolicy, commentable?: Map<string, Set<number>>): boolean {
  // The verifier's demotion wins over any tier, including a config rule that
  // re-tiers AI findings to `inline` after the AI lane ran.
  if (verifierDemoted(f) || f.tier !== "inline") return false
  if (f.preExisting || typeof f.startLine !== "number") return false
  if (commentable?.has(f.file) && !commentable.get(f.file)!.has(f.startLine)) return false
  return SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[posting.inlineSeverityFloor]
}

/**
 * Inline comments for this run: eligible findings not already on the PR, most
 * severe and most confident first, capped at the posting budget. Findings over
 * the budget are `deferred` and stay in the summary. A finding whose line is
 * outside the diff (see `commentable`) keeps its line in the envelope and is
 * listed in the summary instead.
 */
export function inlineComments(
  env: VerdictEnvelope,
  alreadyPosted: Set<string> = new Set(),
  commentable?: Map<string, Set<number>>,
): { comments: InlineComment[]; deferred: Finding[] } {
  const posting = postingPolicy(env)
  const fresh = env.findings
    .filter((f) => inlineEligible(f, posting, commentable) && !alreadyPosted.has(f.id))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence] ||
        a.file.localeCompare(b.file) ||
        a.startLine! - b.startLine!,
    )
  const comments = fresh.slice(0, posting.inlineBudget).map((f): InlineComment => {
    const parts = [`${SEVERITY_EMOJI[f.severity]} **${f.title}**`]
    if (f.evidenceLine) parts.push(evidenceText(f))
    parts.push(clampBody(f.body))
    const s = f.suggestion
    if (s) parts.push(suggestionBlock(s.replacement))
    parts.push(findingMarker(f.id))
    const body = parts.join("\n\n")
    // GitHub applies a suggestion to the comment's line range, so the
    // comment spans exactly the replaced lines.
    if (!s) return { path: f.file, line: f.startLine!, side: "RIGHT", body }
    return {
      path: f.file,
      line: s.endLine,
      side: "RIGHT",
      ...(s.startLine !== s.endLine ? { start_line: s.startLine, start_side: "RIGHT" as const } : {}),
      body,
    }
  })
  return { comments, deferred: fresh.slice(posting.inlineBudget) }
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

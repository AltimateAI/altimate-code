// altimate_change - new file
// Explicit GitHub review import: fetch/preview first, persist redacted signals after consent,
// then use the same claimed, bounded reflection path as live capture and bootstrap.
import fs from "node:fs/promises"
import { bootstrapSince, DEFAULT_MAX_REFLECTIONS, type BootstrapModel, type BootstrapSummary } from "./bootstrap"
import { buildDigest, redactSecrets } from "./digest"
import { buildPrompt, FEEDBACK_CAP, DEFAULT_TIMEOUT_MS, type GenerateUsage } from "./reflect"
import { reflectSessionSignals, errText } from "./session-reflect"
import * as Signals from "./signals"
import * as Store from "./store"
import { DEFAULT_NAME, validateName } from "./playbook"
import { readReviewState, updateReviewState, type ReviewCheckpoint } from "./review-state"
import { resolveReviewRepo, checkReviewAccess, fetchReviews, type ReviewExecutor, type ReviewComment } from "./review-github"

export const DEFAULT_REVIEW_LIMIT = 50
export const DEFAULT_REVIEW_BOTS = [
  "coderabbitai", "kilo-code-bot", "cubic-dev-ai", "cursor", "dependabot", "renovate",
  "github-actions", "chatgpt-codex-connector", "claude",
]

export interface ImportReviewsOptions {
  root: string
  name?: string
  repo?: string
  since?: string
  limit?: number
  includeBots?: boolean
  bots?: readonly string[]
  reviewBots?: readonly string[]
  maxReflections?: number
  maxStored?: number
  yes?: boolean
  dryRun?: boolean
}

export interface ImportReviewsDeps {
  resolveModel: () => Promise<BootstrapModel>
  out: (text: string) => void
  isTTY: boolean
  confirm: () => Promise<boolean>
  now?: () => number
  exec?: ReviewExecutor
  sleep?: (ms: number) => Promise<void>
}

type DropReason = "pr author" | "bot" | "state" | "empty" | "lgtm" | "emoji" | "short" | "duplicate" | "duplicate text"
export interface ImportReviewsSummary extends BootstrapSummary {
  prsScanned: number
  commentsFetched: number
  commentsKept: number
  commentsDropped: Record<DropReason, number>
  paused: boolean
}

function dropReason(comment: ReviewComment, bots: Set<string>, includeBots: boolean): DropReason | undefined {
  const login = comment.author?.login.toLowerCase() ?? ""
  if (login && login === comment.prAuthor?.toLowerCase()) return "pr author"
  if (!includeBots && (comment.author?.__typename === "Bot" || login.endsWith("[bot]") || bots.has(login))) return "bot"
  if (comment.type === "review" && !["APPROVED", "CHANGES_REQUESTED"].includes(comment.state ?? "")) return "state"
  const body = comment.body.trim()
  if (!body) return "empty"
  const words = body.replace(/:[a-z0-9_+-]+:/gi, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().toLowerCase().replace(/\s+/g, " ")
  if (!words) return "emoji"
  if (/^(?:(?:lgtm|looks good to me)\s*)+$/.test(words)) return "lgtm"
  if (body.length < 20 || words.replace(/\s/g, "").length < 10) return "short"
}

const tokenEstimate = (text: string) => Math.ceil(text.length / 4)
const sessionFor = (key: string, number: number) => `review:${key}/pull/${number}`
const priority = (a: Signals.NewSignal, b: Signals.NewSignal) => Number(b.resolved === true) - Number(a.resolved === true)

function summaryLine(summary: ImportReviewsSummary) {
  return `Review import summary: ${summary.prsScanned} PRs scanned; ${summary.commentsFetched} comments fetched, ${summary.commentsKept} kept, ${Object.values(summary.commentsDropped).reduce((a, b) => a + b, 0)} dropped (${Object.entries(summary.commentsDropped).map(([reason, count]) => `${reason}: ${count}`).join(", ")}); ${summary.signalsAdded} signals added.`
}

function batches(signals: Signals.NewSignal[]) {
  const result: Signals.NewSignal[][] = []
  for (const signal of signals) {
    const current = result.at(-1)
    const size = (items: Signals.NewSignal[]) => items.map((s) => `[${s.kind}] ${s.text}`).join("\n\n").length
    if (!current || size([...current, signal]) > FEEDBACK_CAP) result.push([signal])
    else current.push(signal)
  }
  return result
}

export async function importReviews(options: ImportReviewsOptions, deps: ImportReviewsDeps): Promise<ImportReviewsSummary | undefined> {
  const now = deps.now ?? Date.now
  const name = options.name ?? DEFAULT_NAME
  validateName(name)
  const limit = options.limit ?? DEFAULT_REVIEW_LIMIT
  const maxReflections = options.maxReflections ?? DEFAULT_MAX_REFLECTIONS
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be an integer >= 1.")
  if (!Number.isSafeInteger(maxReflections) || maxReflections < 0) throw new Error("--max-reflections must be an integer >= 0.")
  const since = bootstrapSince(options.since ?? "30d", now())
  const repo = await resolveReviewRepo(options.root, options.repo, deps.exec)
  await checkReviewAccess(repo, deps.exec)
  const key = `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase()
  const bots = new Set([...DEFAULT_REVIEW_BOTS, ...options.bots ?? [], ...options.reviewBots ?? []].map((login) => login.trim().toLowerCase()).filter(Boolean))
  const scope = JSON.stringify([options.since ?? "30d", !!options.includeBots, [...bots].sort()])
  const checkpoint = (await readReviewState(options.root, name)).repositories[key]
  const matching = checkpoint?.scope === scope
  const stored = await Signals.readSignalsSnapshot(options.root, name)
  const imported = stored.filter((s) => s.source === "import-reviews" && s.messageID?.startsWith(`${key}/`))
  const known = new Set([...(checkpoint?.seenIDs ?? []), ...imported.flatMap((s) => s.messageID ? [s.messageID] : [])])
  const pending = matching ? checkpoint.pending.filter((pr) => Date.parse(pr.mergedAt) >= since &&
    imported.some((s) => s.sessionID === sessionFor(key, pr.number) && s.status === "open" && pr.messageIDs.includes(s.messageID!)))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, limit) : []
  // Finish consented, bounded work before moving the fetch cursor. On scope changes, refetch
  // so old bot/date choices cannot silently enlarge the newly displayed scope.
  const fetched = pending.length ? undefined : await fetchReviews({
    repo, since, limit, cursor: matching ? checkpoint.cursor : undefined,
  }, { exec: deps.exec, now, sleep: deps.sleep })
  const prs = fetched?.prs ?? pending
  const summary: ImportReviewsSummary = {
    prsScanned: fetched?.prsScanned ?? 0, commentsFetched: fetched?.comments.length ?? 0,
    commentsKept: 0, commentsDropped: { "pr author": 0, bot: 0, state: 0, empty: 0, lgtm: 0, emoji: 0, short: 0, duplicate: 0, "duplicate text": 0 },
    signalsFound: 0, signalsAdded: 0, reflectionsRun: 0, candidatesAdded: 0, candidatesEdited: 0,
    inputTokens: 0, outputTokens: 0, tokensEstimated: false, failures: 0, paused: fetched?.paused ?? false,
  }
  const signals: Signals.NewSignal[] = []
  const eligible = new Set<string>()
  const texts = new Set<string>()
  for (const comment of fetched?.comments ?? []) {
    const reason = dropReason(comment, bots, !!options.includeBots)
    if (reason) { summary.commentsDropped[reason]++; continue }
    // Deduplicate before resolved-thread sorting so the first URL stays the provenance.
    const textKey = `${comment.prNumber}/${comment.body.trim().replace(/\s+/g, " ").toLowerCase()}`
    if (texts.has(textKey)) { summary.commentsDropped["duplicate text"]++; continue }
    texts.add(textKey)
    const messageID = `${key}/${comment.type}/${comment.id}`
    eligible.add(messageID)
    if (known.has(messageID)) { summary.commentsDropped.duplicate++; continue }
    known.add(messageID)
    signals.push({
      kind: "review", source: "import-reviews", sessionID: sessionFor(key, comment.prNumber), messageID,
      text: Signals.clipSignalText(`${comment.path ? `${comment.path}\n` : ""}${comment.body}`),
      reason: "GitHub PR review", provenance: Signals.redactProvenance(comment.url), resolved: comment.resolved,
    })
  }
  signals.sort(priority)
  summary.commentsKept = signals.length
  const plans = prs.map((pr) => ({
    pr, sessionID: sessionFor(key, pr.number),
    signals: [
      ...imported.filter((s) => s.status === "open" && s.sessionID === sessionFor(key, pr.number) &&
        (s.messageID && (pending.length > 0
          ? pending.find((p) => p.number === pr.number)?.messageIDs.includes(s.messageID)
          : eligible.has(s.messageID)))),
      ...signals.filter((s) => s.sessionID === sessionFor(key, pr.number)),
    ].sort(priority),
  }))
  const all = plans.flatMap((p) => p.signals)
  summary.signalsFound = all.length
  const model = await deps.resolveModel()
  const label = `${model.providerID}/${model.modelID}`
  const files = Store.paths(options.root, name)
  const read = (file: string) => fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const lessonChars = ((await read(files.candidate)) ?? (await read(files.approved)) ?? "").length
  let estimatedInput = 0
  let estimatedReflections = 0
  for (const plan of plans) for (const batch of batches(plan.signals)) {
    if (estimatedReflections >= maxReflections) break
    const request = buildPrompt({ digest: buildDigest({ prompts: [], calls: [] }), bullets: [], kind: "review",
      feedback: batch.map((s) => `[${s.kind}] ${s.text}`).join("\n\n") })
    estimatedInput += tokenEstimate(request.system + request.prompt) + Math.ceil(lessonChars / 4)
    estimatedReflections++
  }
  deps.out(`Review import scope: ${key}; ${prs.length} PR(s), ${summary.commentsFetched} comment(s) fetched, ${all.length} signal(s) (${all.length - signals.length} pending).`)
  deps.out(`Merged since ${new Date(fetched?.cursor.since ?? since).toISOString()}; newest updated PRs first; limit ${limit}.`)
  deps.out(`Model/provider: ${label}. Estimated input tokens: ${estimatedInput} for up to ${estimatedReflections} reflection(s), excluding candidate growth.`)
  deps.out("Review import sends these redacted comments to this model and stages candidate lessons only.")
  if (fetched?.paused) deps.out(`GitHub rate limit low; fetch paused${fetched.resetAt ? ` until ${fetched.resetAt}` : ""}. Rerun to resume from the last completed PR.`)
  if (fetched?.truncated) deps.out("GitHub's 1,000-result search ceiling was reached. Use a narrower --since for further imports; the completed comments remain available below.")
  if (options.dryRun) {
    for (const signal of all) deps.out(`[${signal.messageID}]${signal.resolved === undefined ? "" : ` [resolved: ${signal.resolved}]`} ${Signals.clipSignalText(signal.text)}\n${Signals.redactProvenance(signal.provenance ?? "")}`)
    deps.out(summaryLine(summary))
    deps.out("Dry run: nothing sent and no review state changed.")
    return
  }
  if (!options.yes) {
    if (!deps.isTTY) throw new Error("Refusing to import reviews without confirmation in a non-interactive session; pass --yes or --dry-run.")
    if (!(await deps.confirm())) { deps.out("Cancelled. Nothing sent."); return }
  }
  // Append first: a crash before checkpoint publication replays the PR safely via message IDs.
  summary.signalsAdded = (await Signals.appendSignals(options.root, signals, name)).length
  await updateReviewState(options.root, (state) => {
    const current = state.repositories[key]
    const next: ReviewCheckpoint = current ?? { scope, seenIDs: [], pending: [] }
    next.seenIDs = [...new Set([...next.seenIDs, ...signals.map((s) => s.messageID!)])]
    const unchanged = JSON.stringify(current?.cursor) === JSON.stringify(checkpoint?.cursor) && current?.scope === checkpoint?.scope
    if (unchanged || current?.scope === scope) {
      const waiting = new Map((next.scope === scope ? next.pending : []).map((pr) => [pr.number, pr]))
      for (const plan of plans) if (plan.signals.length) waiting.set(plan.pr.number, {
        ...plan.pr,
        messageIDs: [...new Set([...(waiting.get(plan.pr.number)?.messageIDs ?? []), ...plan.signals.map((s) => s.messageID!)])],
      })
      next.pending = [...waiting.values()]
    }
    // A concurrent importer may have already advanced a different scope/cursor. Preserve it.
    if (unchanged) {
      next.scope = scope
      if (fetched) {
        next.cursor = fetched.complete && !fetched.paused ? undefined : fetched.cursor
        next.resetAt = fetched.resetAt
      }
    }
    state.repositories[key] = next
  }, name)

  let stopped = false
  for (const plan of plans) {
    const allowed = new Set(plan.signals.map((s) => s.messageID))
    while (!stopped && summary.reflectionsRun < maxReflections) {
      const open = (await Signals.listSignals(options.root, { session: plan.sessionID }, name))
        .filter((s) => s.source === "import-reviews" && allowed.has(s.messageID))
      if (!open.length) break
      const batch = batches(open.sort(priority))[0] as Signals.Signal[]
      deps.out(`Reflecting PR #${plan.pr.number}: ${open.length} open signal(s) (${summary.reflectionsRun + 1}/${maxReflections})...`)
      try {
        const result = await reflectSessionSignals({
          root: options.root, name, sessionID: plan.sessionID, maxStored: options.maxStored,
          signalIDs: batch.map((s) => s.id), modelLabel: label, recoverPending: false,
          loadSource: async () => ({ prompts: [], calls: [] }),
          getGenerate: async () => {
            summary.reflectionsRun++
            let usage: GenerateUsage | undefined
            const generate = await model.generate(AbortSignal.timeout(DEFAULT_TIMEOUT_MS), (value) => { usage = value })
            return async (request) => {
              usage = undefined
              const estimated = tokenEstimate(request.system + request.prompt)
              summary.inputTokens += estimated
              let completed = false
              try {
                const output = await generate(request)
                const measured = usage as GenerateUsage | undefined
                summary.inputTokens += (measured?.inputTokens ?? estimated) - estimated
                summary.outputTokens += measured?.outputTokens ?? tokenEstimate(JSON.stringify(output) ?? "")
                if (measured?.inputTokens === undefined || measured?.outputTokens === undefined) summary.tokensEstimated = true
                completed = true
                return output
              } finally { if (!completed) summary.tokensEstimated = true }
            }
          },
        })
        if (result.status === "none") { stopped = true; break }
        summary.candidatesAdded += result.result.curated.applied.filter((delta) => delta.op === "ADD").length
        summary.candidatesEdited += result.result.curated.applied.filter((delta) => delta.op === "EDIT").length
        const remaining = await Signals.listSignals(options.root, { session: plan.sessionID }, name)
        if (result.signals.some((s) => remaining.some((r) => r.id === s.id))) {
          deps.out("Feedback remains open after curation; stopping for review before retrying.")
          stopped = true
        }
      } catch (error) {
        summary.failures++
        deps.out(`Reflection failed for PR #${plan.pr.number}: ${redactSecrets(errText(error))}. Signals remain open.`)
        stopped = true
      }
    }
    if (stopped) break
  }
  // Read open signals while holding the same lock as checkpoint mutation.
  const updated = await updateReviewState(options.root, async (state) => {
    const open = await Signals.listSignals(options.root, {}, name)
    const current = state.repositories[key]
    current.pending = current.pending.filter((pr) => open.some((s) => s.sessionID === sessionFor(key, pr.number) && s.source === "import-reviews" &&
      s.messageID && pr.messageIDs.includes(s.messageID)))
  }, name)
  if (model.cost) summary.estimatedCost = (summary.inputTokens * model.cost.input + summary.outputTokens * model.cost.output) / 1_000_000
  deps.out(summaryLine(summary))
  deps.out(`${summary.reflectionsRun} reflections run; candidate lessons: ${summary.candidatesAdded} added, ${summary.candidatesEdited} edited.`)
  deps.out(`Tokens${summary.tokensEstimated ? " (estimated)" : ""}: ${summary.inputTokens} input, ${summary.outputTokens} output. Estimated cost: ${summary.estimatedCost === undefined ? "unavailable (provider has no rates)" : `$${summary.estimatedCost.toFixed(6)}`}.`)
  if (updated.repositories[key].cursor?.truncated)
    deps.out("GitHub search was truncated; use a narrower --since for further fetching.")
  else if (stopped || updated.repositories[key].cursor || updated.repositories[key].pending.length)
    deps.out("Unfinished reviews remain queued; rerun `learn import-reviews` with the same scope to continue.")
  deps.out("Next: `learn show`, then `learn promote` after review.")
  return summary
}

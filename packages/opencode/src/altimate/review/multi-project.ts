import path from "node:path"
import { realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { collectChangedFiles, gitRepoRoot, listFilesAt, listWorkingTreeFiles, resolveReviewBase } from "./git"
import { reviewPullRequest, type ReviewPullRequestOptions } from "./run"
import { applyMode, signEnvelope, summarize, VerdictEnvelope, type RiskTier, type Verdict } from "./verdict"
import type { ChangedFile } from "./diff-filter"

/**
 * Multi-project review (`altimate review --all-projects`): a PR in a mono-repo
 * can change several dbt projects. Each touched project is reviewed on its own
 * (its policy, manifest and layout) and the results are merged into one signed
 * verdict envelope, so the PR gets one comment.
 */

const PROJECT_FILE = /(^|\/)dbt_project\.ya?ml$/
const IGNORED_DIR = /(^|\/)(dbt_packages|target|node_modules)\//

const VERDICT_RANK: Record<Verdict, number> = { APPROVE: 0, COMMENT: 1, REQUEST_CHANGES: 2 }
const TIER_RANK: Record<RiskTier, number> = { trivial: 0, lite: 1, full: 2 }
const OUTSIDE_PROJECT = /^outside the dbt project/
/** Reason for a file outside every reviewed project (the projects are listed in `scope.projects`). */
const OUTSIDE_ALL = "outside the dbt projects reviewed"

/** Repo-relative roots ("" = repo root) of every dbt project at the head side. */
export async function discoverDbtProjects(gitRoot: string, head?: string): Promise<string[]> {
  const files = (head ? await listFilesAt(gitRoot, head) : await listWorkingTreeFiles(gitRoot)) ?? []
  const roots = new Set<string>()
  for (const f of files) {
    if (!PROJECT_FILE.test(f) || IGNORED_DIR.test(f)) continue
    roots.add(path.posix.dirname(f) === "." ? "" : path.posix.dirname(f))
  }
  return [...roots].sort()
}

/** The deepest project root containing the repo-relative path `p`, or undefined. */
export function owningProject(p: string, roots: string[]): string | undefined {
  let best: string | undefined
  for (const r of roots) {
    if (r !== "" && !p.startsWith(r + "/")) continue
    if (best === undefined || r.length > best.length) best = r
  }
  return best
}

/** Assign each changed file to the deepest project containing it (new path first, then the old path of a rename). */
export function assignToProjects(
  files: ChangedFile[],
  roots: string[],
): { byProject: Map<string, ChangedFile[]>; unassigned: ChangedFile[] } {
  const byProject = new Map<string, ChangedFile[]>()
  const unassigned: ChangedFile[] = []
  for (const f of files) {
    const root = owningProject(f.path, roots) ?? (f.oldPath ? owningProject(f.oldPath, roots) : undefined)
    if (root === undefined) unassigned.push(f)
    else byProject.set(root, [...(byProject.get(root) ?? []), f])
  }
  return { byProject, unassigned }
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** `abs` relative to the repo root in POSIX form, or undefined when outside it. */
function repoRel(gitRootReal: string, abs: string): string | undefined {
  const rel = path.relative(gitRootReal, abs).replace(/\\/g, "/")
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return undefined
  return rel
}

export async function reviewAllProjects(opts: ReviewPullRequestOptions): Promise<VerdictEnvelope> {
  const gitRoot = (await gitRepoRoot(opts.cwd)) ?? opts.cwd
  const gitRootReal = await canonical(gitRoot)

  // Collect the PR's changed files once, against the same merge-base reviewPullRequest resolves.
  const collected =
    opts.changedFiles ??
    (await (async () => {
      const resolved = await resolveReviewBase({ cwd: opts.cwd, base: opts.base, head: opts.head })
      return collectChangedFiles({ base: resolved.sha, head: opts.head, cwd: opts.cwd })
    })())

  const roots = await discoverDbtProjects(gitRoot, opts.head)
  const { byProject, unassigned } = assignToProjects(collected, roots)
  const touched = roots.filter((r) => byProject.has(r))
  if (touched.length === 0) return reviewPullRequest(opts)

  // An explicit --manifest belongs to the project that contains it; the others auto-discover.
  const manifestAbs = opts.manifestPath
    ? await canonical(path.isAbsolute(opts.manifestPath) ? opts.manifestPath : path.join(opts.cwd, opts.manifestPath))
    : undefined
  const manifestRel = manifestAbs ? repoRel(gitRootReal, manifestAbs) : undefined
  const manifestOwner = manifestRel !== undefined ? owningProject(manifestRel, roots) : undefined
  // A manifest outside every project (CI's `$RUNNER_TEMP/manifest.json`) can't be matched by
  // path; it goes to the touched project when there is only one.
  const manifestFor = (root: string) =>
    root === manifestOwner || (manifestOwner === undefined && touched.length === 1) ? manifestAbs : undefined
  const optsFor = (root: string): ReviewPullRequestOptions => ({
    ...opts,
    cwd: path.join(gitRootReal, root),
    manifestPath: manifestFor(root),
  })

  if (touched.length === 1) {
    // Invoked from inside the touched project: exactly the single-project review.
    const cwdRel = repoRel(gitRootReal, await canonical(opts.cwd))
    if (cwdRel !== undefined && owningProject(cwdRel + "/", roots) === touched[0]) return reviewPullRequest(opts)
  }
  if (manifestAbs && !touched.some((r) => manifestFor(r))) {
    const where = manifestOwner === undefined ? "is outside every dbt project" : `belongs to ${manifestOwner || "."}, which this PR does not change`
    process.stderr.write(
      `⚠️  --manifest ${opts.manifestPath} ${where}, so no reviewed project uses it; each project auto-discovers its own. Place the manifest inside the project it describes (e.g. its target/), or review that project on its own.\n`,
    )
  }
  if (touched.length === 1) return reviewPullRequest(optsFor(touched[0]))

  // Each project sees its own files plus the files outside every project (so
  // those are listed as not reviewed); other projects' files are left out.
  const prFiles = collected.map((f) => f.path)
  const runs: ProjectRun[] = []
  for (const root of touched) {
    const own = byProject.get(root)!
    process.stderr.write(`ℹ️  reviewing dbt project ${root || "."} (${own.length} changed file(s))\n`)
    const env = await reviewPullRequest({ ...optsFor(root), changedFiles: [...own, ...unassigned], prFiles })
    runs.push({ root, paths: own.map((f) => f.path), env })
  }
  return mergeProjectEnvelopes(runs, opts.mode)
}

/** One project's review: its repo-relative root, the changed files assigned to it, and its envelope. */
export interface ProjectRun {
  root: string
  paths: string[]
  env: VerdictEnvelope
}

/** Merge per-project envelopes into one signed envelope (see reviewAllProjects). */
export function mergeProjectEnvelopes(
  runs: ProjectRun[],
  modeOverride?: VerdictEnvelope["mode"],
): VerdictEnvelope {
  const first = runs[0].env
  const envs = runs.map((r) => r.env)

  const seenIds = new Set<string>()
  const findings = envs.flatMap((e) => e.findings).filter((f) => !seenIds.has(f.id) && !!seenIds.add(f.id))

  const mode = modeOverride ?? (envs.some((e) => e.mode === "gate") ? "gate" : first.mode)
  const worst = (vs: Verdict[]) => vs.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a))
  const idealVerdict = worst(envs.map((e) => e.idealVerdict))
  // Each project's verdict already has its own mode applied: a comment-mode project never blocks.
  const verdict = applyMode(worst(envs.map((e) => e.verdict)), mode)
  const tier = envs.map((e) => e.tier).reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a))
  const tierReasons = [...new Set(envs.flatMap((e) => e.tierReasons ?? []))]

  // A path some project reviewed is not "outside the dbt project" for the PR.
  const reviewed = new Set(runs.flatMap((r) => r.paths))
  const notReviewed: Array<{ path: string; reason: string }> = []
  const seenEntry = new Set<string>()
  for (const e of envs) {
    for (const n of e.scope?.notReviewed ?? []) {
      const outside = OUTSIDE_PROJECT.test(n.reason)
      if (outside && reviewed.has(n.path)) continue
      const key = outside ? `outside\0${n.path}` : `${n.path}\0${n.reason}`
      if (seenEntry.has(key)) continue
      seenEntry.add(key)
      notReviewed.push(outside ? { path: n.path, reason: OUTSIDE_ALL } : n)
    }
  }
  const outsideCount = notReviewed.filter((n) => OUTSIDE_PROJECT.test(n.reason)).length
  const movedCount = envs.reduce((s, e) => s + (e.scope?.movedUnchangedFiles ?? 0), 0)
  const unverified = envs.flatMap((e) => e.scope?.unverified ?? [])

  const engineErrors = new Map<string, { method: string; reason: string; count: number }>()
  for (const err of envs.flatMap((e) => e.engineErrors ?? [])) {
    const key = `${err.method}\0${err.reason}`
    const prev = engineErrors.get(key)
    engineErrors.set(key, prev ? { ...prev, count: prev.count + err.count } : { ...err })
  }

  // Per-project values are recorded in `scope.projects`; the top level carries one only when every project agrees.
  const shared = <T>(vals: T[]): T | undefined =>
    vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] : undefined
  const classified = envs.map((e) => e.tierClassified)
  const merged: VerdictEnvelope = {
    version: first.version,
    verdict,
    idealVerdict,
    mode,
    tier,
    tierReasons: tierReasons.length ? tierReasons : undefined,
    tierForced: first.tierForced,
    tierClassified: classified.every((t) => t !== undefined)
      ? classified.reduce((a, b) => (TIER_RANK[b!] > TIER_RANK[a!] ? b : a))
      : undefined,
    findings,
    summary: summarize(findings, envs.some((e) => e.summary.degraded)),
    engine: first.engine,
    manifestHash: shared(envs.map((e) => e.manifestHash)),
    staleManifest: envs.some((e) => e.staleManifest) ? true : undefined,
    engineErrors: engineErrors.size ? [...engineErrors.values()] : undefined,
    policy: mergePolicy(envs),
    scope: {
      baseRef: first.scope?.baseRef,
      baseSha: first.scope?.baseSha,
      baseSource: first.scope?.baseSource,
      outOfScopeFiles: outsideCount || undefined,
      movedUnchangedFiles: movedCount || undefined,
      unverified: unverified.length ? unverified : undefined,
      notReviewed,
      projects: runs.map((r) => ({
        root: r.root,
        files: r.paths.length,
        verdict: r.env.verdict,
        mode: r.env.mode,
        manifestHash: r.env.manifestHash,
        policyHash: r.env.policy?.hash,
      })),
    },
    ai: mergeAi(runs),
    generatedAt: first.generatedAt,
  }
  return signEnvelope(VerdictEnvelope.parse(merged))
}

/** Least-trusted source first: a policy the PR controls outranks the defaults, which outrank the base branch's. */
const POLICY_SOURCE_RANK = { base: 0, default: 1, working_tree: 2 } as const

/** One project's policy when all agree; otherwise the least-trusted source, a hash of every
 *  project's hash, every setting the PR changes, and the posting policy only if shared. */
function mergePolicy(envs: VerdictEnvelope[]): VerdictEnvelope["policy"] {
  const policies = envs.map((e) => e.policy)
  if (policies.some((p) => !p)) return undefined
  const all = policies as NonNullable<VerdictEnvelope["policy"]>[]
  if (all.every((p) => JSON.stringify(p) === JSON.stringify(all[0]))) return all[0]
  const changed = [...new Set(all.flatMap((p) => p.changedInPr ?? []))]
  const postings = all.map((p) => JSON.stringify(p.posting))
  return {
    source: all.map((p) => p.source).reduce((a, b) => (POLICY_SOURCE_RANK[b] > POLICY_SOURCE_RANK[a] ? b : a)),
    hash: createHash("sha256").update(all.map((p) => p.hash).join("\n")).digest("hex").slice(0, 16),
    changedInPr: changed.length ? changed : undefined,
    posting: postings.every((x) => x === postings[0]) ? all[0].posting : undefined,
  }
}

function mergeAi(runs: Array<{ root: string; env: VerdictEnvelope }>): VerdictEnvelope["ai"] {
  const lanes = runs.filter((r) => r.env.ai)
  if (!lanes.length) return undefined
  const first = lanes[0].env.ai!
  const ok = lanes.find((r) => r.env.ai!.state === "ok")?.env.ai
  const sum = (pick: (a: NonNullable<VerdictEnvelope["ai"]>) => number | undefined) => {
    const vals = lanes.map((r) => pick(r.env.ai!)).filter((v): v is number => v !== undefined)
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined
  }
  const tokenLanes = lanes.map((r) => r.env.ai!.tokens).filter((t) => t !== undefined)
  const tokens = tokenLanes.length
    ? tokenLanes.reduce((a, b) => ({
        input: a.input + b.input,
        inputTotal: a.inputTotal + b.inputTotal,
        output: a.output + b.output,
        reasoning: a.reasoning + b.reasoning,
        cacheRead: a.cacheRead + b.cacheRead,
      }))
    : undefined
  // The worst state wins (a sibling's error or timeout is not hidden by another project's ok),
  // with that project's reason; `skipped` (nothing to send) ranks below `ok`.
  const worst = lanes.reduce((a, b) => (AI_STATE_RANK[b.env.ai!.state] > AI_STATE_RANK[a.env.ai!.state] ? b : a))
  const state = worst.env.ai!.state
  const reason = worst.env.ai!.reason
  const base = ok ?? first
  return {
    ...base,
    state,
    reason: state === "ok" ? base.reason : reason && lanes.length > 1 ? `${worst.root || "."}: ${reason}` : reason,
    model: base.model ?? first.model,
    calls: sum((a) => a.calls),
    tokens,
    cost: sum((a) => a.cost),
    durationMs: sum((a) => a.durationMs),
    projects: lanes.map((r) => ({ root: r.root, state: r.env.ai!.state, reason: r.env.ai!.reason, calls: r.env.ai!.calls })),
  }
}

const AI_STATE_RANK: Record<NonNullable<VerdictEnvelope["ai"]>["state"], number> = { skipped: 0, ok: 1, timeout: 2, error: 3 }

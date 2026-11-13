// altimate_change - new file
//
// Notices for the person's own workspace review requests (skills and knowledge bases): when the owner approves or
// rejects one, it is kept and shown the same way a rule review is. Like a rule review notice (`state.notices` of the
// rules state), it is kept durably in this state (`notices`), not only published: `rule.proposal.reviewed` reaches a TUI
// that is listening now, and a TUI that was not (closed, its event stream dropped) shows it from the rules summary
// (`review_notices`) when it next starts or refreshes. The TUI remembers per project which notices it showed.
//
// - What is noticed: a submission this client has seen pending (from `skill publish`, or an earlier poll) that the
//   server now lists as approved (`active`) or `rejected`; and one this client has seen approved (or pending) that an
//   owner or admin then removed from the workspace (`retired`, by someone else: the person's own removal is not news).
//   A superseded one (replaced by the author's newer submission) or a withdrawn one is let go silently. Decisions on
//   requests this client never saw pending are history, not news.
// - State: in the person's own state directory, outside every repository (`<state>/workspace-reviews/<digest>.json`), one
//   file per API URL, tenant, account (the person, `user:<id>`) and workspace. Another account or workspace reads
//   another file, so a switch, relink or sign-in as someone else never shows or records this one's notices. Bounded:
//   `MAX_PENDING` ids seen pending, `MAX_SEEN` decisions recorded, `MAX_NOTICES` notices kept for replay.
// - A decision is recorded (`seen`, and its notice kept) under a lock per file, so two processes do not record it twice,
//   and only in the file of the scope the list was fetched for.
// - Never on the prompt path: the rules service polls on its refresh timer (`REFRESH_MS`). Reading the kept notices
//   (`stored`) asks no server.
// - A failed fetch (offline, 401, 403, a server without review) changes nothing: no notice, no state written.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { workspacesOn } from "../learn/config"
import { ReviewApi } from "./review-api"

const log = Log.create({ service: "workspace.review-notices" })
export const MAX_PENDING = 200
/** After a server and tenant answer that they have no review, the poll asks them again only after this long. */
/** Pending requests past the page cap asked for by id per poll. */
export const MAX_LOOKUPS = 10
export const UNSUPPORTED_BACKOFF_MS = 6 * 60 * 60 * 1000
/** When each server and tenant (`apiUrl|tenant`) last answered "no review", in this process. */
const unsupportedAt = new Map<string, number>()
/** Tests: forget what servers answered. */
export function resetForTest(): void {
  unsupportedAt.clear()
}
export const MAX_SEEN = 500
/** Approved requests tracked, so their removal from the workspace is noticed. */
export const MAX_APPROVED = 200
/** Notices kept for a client to replay, newest last: as many as the rules state keeps. */
export const MAX_NOTICES = 50
const LOCK = { staleMs: 60_000, timeoutMs: 10_000 }

export const Scope = z.object({
  apiUrl: z.string(),
  tenant: z.string(),
  /** The person (`user:<id>`), not the key: rotating the key keeps the state. */
  account: z.string(),
  datamateId: z.number().int(),
})
export type Scope = z.infer<typeof Scope>

export const Notice = z.object({
  public_id: z.string(),
  kind: z.enum(["skill", "knowledge"]),
  name: z.string(),
  /** `retired`: removed from the workspace after approval. */
  status: z.enum(["active", "rejected", "retired"]),
  reason: z.string().optional(),
  reviewer: z.string().optional(),
  /** When it was decided (the server's `reviewed_at`, else `updated_at`). */
  at: z.string(),
})
export type Notice = z.infer<typeof Notice>

export const State = z.object({
  version: z.literal(1),
  scope: Scope,
  /** Contribution ids this client has seen pending. */
  pending: z.array(z.string()).default([]),
  /** Contribution ids this client has seen approved (`active`), whose removal is noticed. Absent from older files. */
  approved: z.array(z.string()).default([]),
  /** `<public_id>:<status>` of decisions already recorded as notices. */
  seen: z.array(z.string()).default([]),
  /** The recorded notices, kept for clients to show (replayed from the rules summary). */
  notices: z.array(Notice).default([]),
})
export type State = z.infer<typeof State>

const sameScope = (a: Scope, b: Scope) =>
  a.apiUrl === b.apiUrl && a.tenant === b.tenant && a.account === b.account && a.datamateId === b.datamateId

export function dir(): string {
  return path.join(Global.Path.state, "workspace-reviews")
}

/** The state file of `scope`: one per API URL, tenant, account and workspace. */
export function stateFile(scope: Scope): string {
  const key = JSON.stringify([scope.apiUrl, scope.tenant, scope.account, scope.datamateId])
  return path.join(dir(), createHash("sha256").update(key).digest("hex") + ".json")
}

/** The state of `scope`, or undefined when there is none, it cannot be read, or it names another scope. */
export async function read(scope: Scope): Promise<State | undefined> {
  const raw = await fs.readFile(stateFile(scope), "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const state = State.parse(JSON.parse(raw))
    return sameScope(state.scope, scope) ? state : undefined
  } catch {
    return undefined
  }
}

async function write(state: State): Promise<void> {
  const file = stateFile(state.scope)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Read-modify-write of `scope`'s state under its lock. */
async function locked<T>(scope: Scope, change: (state: State) => Promise<{ state: State; result: T }>): Promise<T> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 })
  return Flock.withLock(
    `workspace-reviews:${path.basename(stateFile(scope))}`,
    async () => {
      const current = (await read(scope)) ?? { version: 1 as const, scope, pending: [], approved: [], seen: [], notices: [] }
      const { state, result } = await change(current)
      const next = cap(state)
      if (JSON.stringify(next) !== JSON.stringify(current)) await write(next)
      return result
    },
    { dir: dir(), ...LOCK },
  )
}

function cap(state: State): State {
  return {
    ...state,
    pending: state.pending.slice(-MAX_PENDING),
    // The ids already tracked are kept, in their order: a newer approval waits for room rather than evicting one, so
    // the tracked set (and the file) does not change from poll to poll.
    approved: state.approved.slice(0, MAX_APPROVED),
    seen: state.seen.slice(-MAX_SEEN),
    notices: state.notices.slice(-MAX_NOTICES),
  }
}

const keyOf = (id: string, status: string) => `${id}:${status}`

/** The decisions in `items` this client has not recorded yet: the caller's own, seen pending before, or a removal by
 * someone else of one seen pending or approved before. Pure. */
export function decided(state: State, items: readonly ReviewApi.Contribution[]): Notice[] {
  const pending = new Set(state.pending)
  const approved = new Set(state.approved)
  const seen = new Set(state.seen)
  return items.flatMap((item): Notice[] => {
    if (!item.is_mine || seen.has(keyOf(item.public_id, item.status))) return []
    if (item.status === "retired") {
      // Removed by someone else from a workspace this client saw it in (approved, or still pending before that).
      if (item.decided_by_me || (!approved.has(item.public_id) && !pending.has(item.public_id))) return []
    } else if (item.status !== "active" && item.status !== "rejected") return []
    else if (!pending.has(item.public_id)) return []
    return [
      {
        public_id: item.public_id,
        kind: item.kind,
        name: item.name,
        status: item.status,
        ...(item.review_reason ? { reason: item.review_reason } : {}),
        ...(item.reviewed_by_name ? { reviewer: item.reviewed_by_name } : {}),
        at: item.reviewed_at ?? item.updated_at,
      },
    ]
  })
}

/** The state after `items` was listed and `shown` notices were recorded (kept for replay, and marked seen). A decision
 * not recorded stays pending; a superseded or withdrawn request is let go. Approved ones are tracked until they are
 * removed. With the whole list (`complete`), ids it no longer holds are let go. */
export function advance(state: State, items: readonly ReviewApi.Contribution[], shown: readonly Notice[], complete: boolean): State {
  const mine = items.filter((item) => item.is_mine)
  const listed = new Set(mine.map((item) => item.public_id))
  const shownIds = new Set(shown.map((notice) => notice.public_id))
  const settled = new Set(
    mine
      .filter(
        (item) =>
          item.status === "superseded" ||
          item.status === "withdrawn" ||
          item.status === "retired" ||
          ((item.status === "active" || item.status === "rejected") && (shownIds.has(item.public_id) || !state.pending.includes(item.public_id))),
      )
      .map((item) => item.public_id),
  )
  const pending = [...new Set([...state.pending, ...mine.filter((item) => item.status === "pending").map((item) => item.public_id)])].filter(
    (id) => !settled.has(id) && (!complete || listed.has(id)),
  )
  // Approved ones are tracked until anything else (retired, or gone from a complete list) settles them. An approved one
  // still pending here is kept pending too, until its approval is recorded.
  const ended = new Set(mine.filter((item) => item.status !== "active").map((item) => item.public_id))
  const tracked = state.approved.filter((id) => !ended.has(id) && (!complete || listed.has(id)))
  const known = new Set(tracked)
  const added = mine.filter((item) => item.status === "active" && !known.has(item.public_id)).map((item) => item.public_id)
  const approved = [...tracked, ...added].slice(0, MAX_APPROVED)
  const seen = [...new Set([...state.seen, ...shown.map((notice) => keyOf(notice.public_id, notice.status))])]
  return { ...state, pending, approved, seen, notices: [...state.notices, ...shown] }
}

/** Remember a request this client just submitted as pending, so its decision is noticed even before the next poll lists
 * it. Best-effort: failing costs at most that one notice. */
export async function recordSubmitted(scope: Scope, contribution: Pick<ReviewApi.Contribution, "public_id" | "status">): Promise<void> {
  if (contribution.status !== "pending") return
  await locked(scope, async (state) => ({
    state: { ...state, pending: [...state.pending.filter((id) => id !== contribution.public_id), contribution.public_id] },
    result: undefined,
  })).catch((error) => log.warn("could not record a submitted review request", { error: String(error) }))
}

export type PollResult =
  | { status: "off" | "signed_out" | "not_linked" | "account_changed" | "account_unconfirmed" | "unsupported" }
  | { status: "failed"; error: string }
  | { status: "done"; recorded: Notice[] }

export interface PollDeps {
  /** Tell clients listening now about a newly recorded notice (best-effort: one not listening replays it from the kept
   * notices). */
  announce?(notice: Notice): Promise<void>
}

/** Fetch the person's requests on the project's workspace and record the decisions not recorded yet, then announce
 * them. Never throws. */
export async function poll(directory: string, deps: PollDeps = {}): Promise<PollResult> {
  try {
    return await pollUnsafe(directory, deps)
  } catch (error) {
    log.warn("workspace review notices failed", { error: String(error) })
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

async function pollUnsafe(directory: string, deps: PollDeps): Promise<PollResult> {
  if (!workspacesOn()) return { status: "off" }
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }, { RulesSync }] = await Promise.all([
    import("./api-client"),
    import("./state"),
    import("../rules/sync"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { status: "signed_out" }
  // A server that said it has no review is not asked again (nor is the link or the account resolved) for a while.
  const server = `${actAs.url.replace(/\/+$/, "")}|${actAs.instance}`
  const absentSince = unsupportedAt.get(server)
  if (absentSince !== undefined && Date.now() - absentSince < UNSUPPORTED_BACKOFF_MS) return { status: "unsupported" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  if (outcome.status !== "bound") return { status: "not_linked" }
  const digest = credentialDigest(actAs.url, actAs.instance, actAs.apiKey)
  // The binding was resolved with the ambient credential: it must still be the captured one.
  if ((await accountDigest()) !== digest) return { status: "account_changed" }
  const account = await RulesSync.accountOf(actAs)
  if (!account) return { status: "account_unconfirmed" }
  const scope = scopeOf(actAs.url, actAs.instance, account, outcome.binding.datamateId)
  let listed: Awaited<ReturnType<typeof ReviewApi.listMine>>
  try {
    listed = await ReviewApi.listMine(scope.datamateId, actAs)
  } catch (error) {
    // Nothing is decided by a failure: a 401/403 or an outage leaves the state as it was.
    if (ReviewApi.unavailable(error)) {
      unsupportedAt.set(server, Date.now())
      return { status: "unsupported" }
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
  // Past the page cap, a request still pending or approved here may be one the list never reached (newer requests push
  // it down, and a decision or removal does not move it up): each such one is asked for by id, a few per poll.
  // One the server no longer has (404) is let go; one that could not be read stays and is asked again later, behind
  // the others, so a few that keep failing never take every lookup.
  const gone = new Set<string>()
  let looked: string[] = []
  if (!listed.complete) {
    const listedIds = new Set(listed.items.map((item) => item.public_id))
    const kept = await read(scope)
    looked = [...new Set([...(kept?.pending ?? []), ...(kept?.approved ?? [])])].filter((id) => !listedIds.has(id)).slice(0, MAX_LOOKUPS)
    for (const id of looked) {
      const item = await ReviewApi.getMine(scope.datamateId, id, actAs).then(
        (found) => (found === null ? (gone.add(id), undefined) : found),
        () => undefined,
      )
      if (item) listed = { ...listed, items: [...listed.items, item] }
    }
  }
  const result = await locked(scope, async (state): Promise<{ state: State; result: PollResult }> => {
    // Recorded only for the account it was fetched for: another sign-in meanwhile records nothing.
    if ((await accountDigest()) !== digest) return { state, result: { status: "account_changed" } }
    const recorded = decided(state, listed.items)
    // A row this version could not read may be one of the pending requests: only a list read in full lets one go.
    const next = advance(state, listed.items, recorded, listed.complete && listed.skipped === 0)
    const asked = new Set(looked)
    const behind = (ids: string[]) => {
      const left = ids.filter((id) => !gone.has(id))
      return [...left.filter((id) => !asked.has(id)), ...left.filter((id) => asked.has(id))]
    }
    return {
      state: { ...next, pending: behind(next.pending), approved: behind(next.approved) },
      result: { status: "done", recorded },
    }
  })
  if (result.status === "done")
    for (const notice of result.recorded) await deps.announce?.(notice).catch((error) => log.warn("could not announce a review notice", { error: String(error) }))
  return result
}

/** The notices kept for the project's workspace and the person signed in now, oldest first; none when workspaces are
 * off, nobody is signed in, the project has no local link, or the person is not known yet in this process. For the
 * rules summary, which clients replay, so it never waits on the network: when the person is not known yet, asking who
 * they are starts in the background and this answers none; the review poll learns it too and asks clients to replay. */
export async function stored(directory: string): Promise<Notice[]> {
  if (!workspacesOn()) return []
  try {
    const [{ WorkspaceApi }, { readLocalBinding, credentialDigest, accountDigest }, { RulesSync }] = await Promise.all([
      import("./api-client"),
      import("./state"),
      import("../rules/sync"),
    ])
    const actAs = await WorkspaceApi.captureCredentials()
    if (!actAs) return []
    const { readPin, resolveWithinRoot } = await import("./pin")
    // The workspace the poll resolves, from what is on hand (no network): the IDE's pin for this tree outranks the
    // project's link, as in `resolveBindingOutcome`. A malformed pin, or one for another tree, names no workspace here.
    const pin = readPin()
    if (pin.kind === "invalid") return []
    if (pin.kind === "valid" && resolveWithinRoot(directory, pin.root) === null) return []
    const binding = pin.kind === "valid" ? { datamateId: pin.datamateId } : await readLocalBinding(directory)
    if (!binding) return []
    // The link was read with the credential signed in now: it must still be the captured one, or one account's
    // notices could be paired with another account's link.
    if ((await accountDigest()) !== credentialDigest(actAs.url, actAs.instance, actAs.apiKey)) return []
    const account = await RulesSync.knownAccount(actAs)
    if (!account) {
      void RulesSync.accountOf(actAs).catch(() => undefined)
      return []
    }
    return (await read(scopeOf(actAs.url, actAs.instance, account, binding.datamateId)))?.notices ?? []
  } catch (error) {
    log.warn("could not read the kept review notices", { error: String(error) })
    return []
  }
}

/** The state scope of a person (`user:<id>`) on workspace `datamateId` of a server and tenant. */
export function scopeOf(apiUrl: string, tenant: string, account: string, datamateId: number): Scope {
  return { apiUrl: apiUrl.replace(/\/+$/, ""), tenant, account, datamateId }
}

export * as ReviewNotices from "./review-notices"

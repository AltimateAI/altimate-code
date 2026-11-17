// altimate_change - new file
//
// "What changed" for everyone on a workspace: the skills and knowledge added to, updated in or removed from what the
// workspace gives its team since this person last looked, as one line a client shows when a session starts (the TUI;
// the IDE extension through `GET /altimate/workspace/activity`). Read from altimate-backend's
// `GET /datamates/{id}/activity`, which only lists what is already recorded and looks back at most 30 days.
//
// Each client (`host`) keeps its own last look, per server, tenant, account and workspace, in the person's own state
// directory (`<state>/workspace-activity/<digest>.json`), never in a repository. The first look records where to start
// from and says nothing: what happened before is history, not news (as review decisions are treated). The mark is the
// newest change's own server time, so a local clock that is off plays no part. The server stamps a change with the time
// its transaction started, so one that commits late can land behind the mark: each look asks again from `OVERLAP_MS`
// before it and drops the changes it already reported, by the `id` the server gives each one (a server without ids is
// asked from the mark itself, as before).
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { classify } from "../rules/api"
import { printable } from "../rules/printable"
import { altimateRequest, type ActAs } from "./api-client"

/** How many changes one look reads: room for the ones the overlap reads again. */
export const LIMIT = 50
/** The most the server gives in one answer: a look whose page was cut inside the overlap reads again with this. */
export const MAX_LIMIT = 100
/** How far behind the mark each look asks again, for changes that committed late. */
export const OVERLAP_MS = 5 * 60_000
/** How many names the line gives for one kind of change. */
const NAMED = 3
/** The longest name the line gives, and the longest line. */
const NAME_MAX = 40
const LINE_MAX = 300

export const Item = z.object({
  /** The change, stable across answers. Absent from older servers. */
  id: z.string().optional(),
  /** The skill or knowledge base, stable within the workspace. Absent from older servers. */
  subject: z.string().optional(),
  kind: z.enum(["skill", "knowledge"]),
  name: z.string(),
  action: z.enum(["added", "updated", "removed"]),
  actor_name: z.string().nullable().optional(),
  at: z.string(),
})
export type Item = z.infer<typeof Item>

const Activity = z.object({ items: z.array(z.unknown()), has_more: z.boolean().default(false) })

/** Changes after `since` (all of the last 30 days without it), newest first. A row this version cannot read is
 * skipped. Throws a classified `RulesApiError`. */
export async function fetchActivity(datamateId: number, since: string | undefined, actAs: ActAs, limit = LIMIT) {
  try {
    const raw = await altimateRequest<unknown>("GET", `/${datamateId}/activity`, {
      base: "/datamates",
      actAs,
      query: { limit: String(limit), ...(since ? { since } : {}) },
    })
    const page = Activity.parse(raw)
    const items = page.items.flatMap((row) => {
      const parsed = Item.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
    return { items, hasMore: page.has_more }
  } catch (error) {
    throw classify(error, "reviews_not_available")
  }
}

/** One client's last look: the server time of the newest change it was given ("" when it first looked at an empty
 * window), the ids it reported within `OVERLAP_MS` of that, whether the server gives ids (then each look asks from
 * `OVERLAP_MS` before the mark), and `from`: when that look's page was cut, the oldest time it read. Below `from` the
 * ids are incomplete, so an unrecorded change there is taken as already seen ("" when the ids are complete). */
export const Mark = z.object({
  at: z.string(),
  ids: z.array(z.object({ id: z.string(), at: z.string() })).default([]),
  overlap: z.boolean().default(false),
  from: z.string().default(""),
})
export type Mark = z.infer<typeof Mark>

const Seen = z.object({
  version: z.literal(1),
  scope: z.object({ apiUrl: z.string(), tenant: z.string(), account: z.string(), datamateId: z.number() }),
  /** Per client. A plain string is a mark from before ids. */
  seen: z.record(z.string(), z.union([z.string(), Mark])).default({}),
})
type Seen = z.infer<typeof Seen>
type Scope = Seen["scope"]

export const markOf = (value: Seen["seen"][string] | undefined): Mark | undefined =>
  value === undefined ? undefined : typeof value === "string" ? { at: value, ids: [], overlap: false, from: "" } : value

/** How many reported ids a mark keeps: past that, the oldest go and `from` moves up to cover them. */
const MAX_IDS = 200

/** A server time as a fixed-width UTC string with microseconds, which the server keeps: two of them compare as
 * strings, exactly. One without a zone is UTC, as the server keeps them. `undefined` when it is not a time. */
export function precise(at: string, shiftMs = 0): string | undefined {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?([zZ]|[+-]\d\d:?\d\d)?$/.exec(at)
  if (!match) return undefined
  const whole = Date.parse(`${match[1]}${match[3] ?? "Z"}`)
  if (Number.isNaN(whole)) return undefined
  // Offsets are whole minutes, so only the whole seconds move with them; the fraction is kept to the microsecond.
  return `${new Date(whole + shiftMs).toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(6, "0").slice(0, 6)}Z`
}
const key = (at: string) => precise(at) ?? ""
const newest = (a: string, b: string) => (key(b) >= key(a) ? b : a)

/** The `since` a look asks from. */
export function sinceOf(mark: Mark): string | undefined {
  if (!mark.at) return undefined
  if (!mark.overlap) return mark.at
  return precise(mark.at, -OVERLAP_MS) ?? mark.at
}

/** The mark after a look (or after merging two): the newest time (the item's on a tie), and the ids within
 * `OVERLAP_MS` of it. `from` is where the ids stop being complete: the oldest item of a `cut` page; the old mark when
 * ids first arrive (it reported what came before without them); and the oldest id kept when more than `MAX_IDS` are
 * in the window. */
export function advance(mark: Mark | undefined, items: Pick<Item, "id" | "at">[], options: { cut?: boolean } = {}): Mark {
  const times = [...(mark?.at ? [mark.at] : []), ...items.map((i) => i.at)].filter((at) => precise(at) !== undefined)
  const at = times.reduce<string>((a, b) => (a ? newest(a, b) : b), "") || mark?.at || ""
  const floor = (at && precise(at, -OVERLAP_MS)) || ""
  const window = new Map<string, string>()
  for (const entry of [...(mark?.ids ?? []), ...items.flatMap((i) => (i.id ? [{ id: i.id, at: i.at }] : []))])
    if (key(entry.at) > floor) window.set(entry.id, entry.at)
  const ids = [...window].map(([id, at]) => ({ id, at })).sort((a, b) => (key(a.at) < key(b.at) ? -1 : key(a.at) > key(b.at) ? 1 : 0))
  const kept = ids.slice(-MAX_IDS)
  const turningOn = !(mark?.overlap ?? false) && Boolean(mark?.at) && items.some((i) => i.id !== undefined)
  const oldest = items.at(-1)?.at
  const froms = [
    ...(options.cut && oldest ? [oldest] : []),
    ...(turningOn && mark ? [mark.at] : []),
    ...(ids.length > kept.length ? [kept[0].at] : []),
  ]
  const from = froms.reduce<string>((a, b) => (a ? newest(a, b) : b), "")
  return {
    at,
    ids: kept,
    overlap: (mark?.overlap ?? false) || items.some((i) => i.id !== undefined),
    from: from && key(from) > floor ? from : "",
  }
}

/** Whether a change on a look's page is news: not reported before, and not an unrecorded change from below where the
 * last look's ids stop being complete (`from`), which is history. A server without ids: everything after the mark. */
function isFresh(mark: Mark | undefined, reported: Set<string>, item: Item): boolean {
  if (item.id === undefined) return true
  if (reported.has(item.id)) return false
  if (!mark?.at || !mark.from) return true
  return !(key(item.at) <= key(mark.at) && key(item.at) <= key(mark.from))
}

/** Where each client's last look is kept. */
export const dir = () => path.join(Global.Path.state, "workspace-activity")
const scopeId = (scope: Scope) =>
  createHash("sha256").update(JSON.stringify([scope.apiUrl, scope.tenant, scope.account, scope.datamateId])).digest("hex")
const fileOf = (scope: Scope) => path.join(dir(), `${scopeId(scope)}.json`)

async function readSeen(scope: Scope): Promise<Seen> {
  const raw = await fs.readFile(fileOf(scope), "utf8").catch(() => undefined)
  if (raw !== undefined) {
    try {
      const state = Seen.parse(JSON.parse(raw))
      if (JSON.stringify(state.scope) === JSON.stringify(scope)) return state
    } catch {}
  }
  return { version: 1, scope, seen: {} }
}

async function writeSeen(state: Seen): Promise<void> {
  const file = fileOf(state.scope)
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

const plural = (n: number, kind: Item["kind"]) =>
  `${n} ${kind === "skill" ? (n === 1 ? "skill" : "skills") : n === 1 ? "knowledge base" : "knowledge bases"}`

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined
/** `text` cut to `max` characters, ending with "…", never inside one. */
const cap = (text: string, max: number) => {
  const chars = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text
}
const fullName = (item: Item) => printable(item.name).trim()
const nameOf = (item: Item) => cap(fullName(item), NAME_MAX)

/** The one line: "Since your last session in X: 2 skills added (a, b), 1 knowledge base removed (c)." Items are counted
 * by `subject` (by name from a server without it), so several changes to one item count once per kind of change and
 * two items with one name count twice; the newest come first. With more changes than one look reads (`hasMore`) the
 * counts would be partial, so the line says there were more and names the newest instead. Text is made printable, and
 * names and the line are capped. */
export function summaryLine(workspaceName: string, items: Item[], hasMore = false): string | undefined {
  if (items.length === 0) return undefined
  const where = `Since your last session in ${cap(printable(workspaceName), NAME_MAX)}`
  if (hasMore) {
    const newest = items.slice(0, NAMED).map((item) => `${nameOf(item) || `a ${item.kind === "skill" ? "skill" : "knowledge base"}`} ${item.action}`)
    return cap(`${where}: more than ${items.length} ${items.length === 1 ? "change" : "changes"} to its skills and knowledge; the newest: ${newest.join(", ")}.`, LINE_MAX)
  }
  const groups = new Map<string, { kind: Item["kind"]; action: Item["action"]; subjects: Set<string>; names: string[] }>()
  for (const item of items) {
    const key = `${item.kind}:${item.action}`
    const group = groups.get(key) ?? { kind: item.kind, action: item.action, subjects: new Set<string>(), names: [] }
    const name = nameOf(item)
    // Without a `subject`, the whole name tells items apart; only what is shown is cut.
    group.subjects.add(item.subject ?? `name:${fullName(item)}`)
    if (name && !group.names.includes(name)) group.names.push(name)
    groups.set(key, group)
  }
  const parts = [...groups.values()].map(({ kind, action, subjects, names }) => {
    const shown = names.slice(0, NAMED).join(", ")
    const more = names.length > NAMED ? `, and ${names.length - NAMED} more` : ""
    return `${plural(subjects.size, kind)} ${action}${names.length ? ` (${shown}${more})` : ""}`
  })
  return cap(`${where}: ${parts.join(", ")}.`, LINE_MAX)
}

/** A deferred look's mark, with the workspace and account it belongs to. */
export const SeenMark = Mark.extend({ scope: z.string() })
export type SeenMark = z.infer<typeof SeenMark>

export type Changes =
  /** `seen`: with `defer`, the mark to hand back to `acknowledge` once the line was shown. */
  | { status: "ok"; workspace: { id: number; name: string }; items: Item[]; line?: string; seen?: SeenMark }
  /** First look for this client: where to start from is recorded, nothing is said. */
  | { status: "first"; workspace: { id: number; name: string } }
  | { status: "signed_out" | "not_linked" | "account_changed" | "unconfirmed" | "unsupported" }
  | { status: "failed"; error: string }

type Located =
  | { ok: true; scope: Scope; workspace: { id: number; name: string }; actAs: ActAs }
  | { ok: false; changes: Changes }

/** The project's workspace and whose look this is. */
async function locate(directory: string): Promise<Located> {
  const { context } = await import("./review-requests")
  const ctx = await context(directory)
  if (!ctx.ready) return { ok: false, changes: { status: ctx.status } }
  const { RulesSync } = await import("../rules/sync")
  const account = await RulesSync.accountOf(ctx.actAs)
  if (!account) return { ok: false, changes: { status: "account_changed" } }
  const scope: Scope = {
    apiUrl: ctx.actAs.url.replace(/\/+$/, ""),
    tenant: ctx.actAs.instance,
    account,
    datamateId: ctx.datamateId,
  }
  return { ok: true, scope, workspace: { id: ctx.datamateId, name: ctx.name }, actAs: ctx.actAs }
}

async function locked<T>(scope: Scope, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 })
  return Flock.withLock(`workspace-activity:${path.basename(fileOf(scope))}`, run, {
    dir: dir(),
    staleMs: 60_000,
    timeoutMs: 5_000,
  })
}

async function failure(error: unknown): Promise<Changes> {
  const { ReviewApi } = await import("./review-api")
  if (ReviewApi.unavailable(error)) return { status: "unsupported" }
  return { status: "failed", error: printable(error instanceof Error ? error.message : String(error)) }
}

/** What changed on the project's workspace since `host` last looked, and mark it seen. With `defer`, a look that has
 * a line to show leaves the mark where it was and returns the next one as `seen`, for `acknowledge` once the line was
 * shown: a client that goes away first shows it next time. Never throws. */
export async function changesSince(directory: string, host: string, options: { defer?: boolean } = {}): Promise<Changes> {
  try {
    const where = await locate(directory)
    if (!where.ok) return where.changes
    const { scope, workspace, actAs } = where
    return await locked(scope, async (): Promise<Changes> => {
      const state = await readSeen(scope)
      // Undefined: never looked. "": looked when nothing had changed in the window, so everything listed since is new
      // (no local clock is involved). Otherwise the newest change it was given.
      const mark = markOf(state.seen[host])
      const since = mark && sinceOf(mark)
      // How the page's oldest change compares with the mark, to the microsecond. At or below it: the page holds every
      // change after the mark (newest first), so `has_more` is about the overlap the look read again, not about news.
      // Changes at the mark itself were reported, or are below where the last look's ids stop (`from`).
      const oldestVsMark = (items: Item[]) =>
        mark?.at && items.length > 0 ? key(items[items.length - 1].at).localeCompare(key(mark.at)) : 1
      let page = await fetchActivity(workspace.id, since, actAs, LIMIT)
      // Cut inside the overlap: read again with the most the server gives, so a change that committed late is in it.
      if (page.hasMore && mark?.overlap && oldestVsMark(page.items) <= 0)
        page = await fetchActivity(workspace.id, since, actAs, MAX_LIMIT)
      const { items } = page
      const hasMore = page.hasMore && !(oldestVsMark(items) <= 0)
      const reported = new Set(mark?.ids.map((entry) => entry.id))
      const fresh = items.filter((item) => isFresh(mark, reported, item))
      const next = advance(mark, items, { cut: page.hasMore })
      const save = () =>
        JSON.stringify(next) === JSON.stringify(mark) ? Promise.resolve() : writeSeen({ ...state, seen: { ...state.seen, [host]: next } })
      if (mark === undefined) {
        await save()
        return { status: "first", workspace }
      }
      const line = summaryLine(workspace.name, fresh, hasMore)
      if (line && options.defer) return { status: "ok", workspace, items: fresh, line, seen: { ...next, scope: scopeId(scope) } }
      await save()
      return { status: "ok", workspace, items: fresh, ...(line ? { line } : {}) }
    })
  } catch (error) {
    return failure(error)
  }
}

/** Where the ids of two looks merged stop being complete. A cut point holds where the other look does not vouch
 * for it: after the other's newest time (the other never read there), or when the other was cut too (then the older
 * point, below which neither read). A look that read its whole window up to and past a cut point vouches for it. */
export function mergedFrom(current: Mark | undefined, seen: Mark): string {
  const holds = (x: Mark | undefined, y: Mark | undefined) =>
    Boolean(x?.from) && (!y?.at || key(x!.from) > key(y.at) || Boolean(y.from))
  const points = [...(holds(seen, current) ? [seen.from] : []), ...(holds(current, seen) ? [current!.from] : [])]
  if (points.length < 2) return points[0] ?? ""
  // Both hold. After the other's newest time, each is the only one that read there: the newer point covers both.
  const past = points.filter((p, i) => key(p) > key((i === 0 ? current : seen)?.at ?? ""))
  if (past.length > 0) return past.reduce((a, b) => newest(a, b))
  return points.reduce((a, b) => (key(a) <= key(b) ? a : b))
}

/** The line from a deferred look was shown: record its mark, merged with any look since. A mark from another
 * workspace or account (relinked, or signed in as someone else, since the look) is refused: `scope_changed`. Never
 * throws. */
export async function acknowledge(
  directory: string,
  host: string,
  seen: SeenMark,
): Promise<{ status: "ok" | "scope_changed" } | Changes> {
  try {
    const where = await locate(directory)
    if (!where.ok) return where.changes
    const { scope } = where
    if (seen.scope !== scopeId(scope)) return { status: "scope_changed" as const }
    const { scope: _scope, ...look } = seen
    return await locked(scope, async () => {
      const state = await readSeen(scope)
      const current = markOf(state.seen[host])
      const merged = advance(current ? { ...current, overlap: current.overlap || look.overlap } : look, [
        ...look.ids,
        ...(look.at ? [{ at: look.at }] : []),
      ])
      const from = mergedFrom(current, look)
      merged.from = from && key(from) > ((merged.at && precise(merged.at, -OVERLAP_MS)) || "") ? from : ""
      await writeSeen({ ...state, seen: { ...state.seen, [host]: merged } })
      return { status: "ok" as const }
    })
  } catch (error) {
    return failure(error)
  }
}

export * as WorkspaceActivity from "./workspace-activity"

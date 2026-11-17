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

/** How many changes one look reads (the server allows up to 100): room for the ones the overlap reads again. */
export const LIMIT = 50
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
 * window), the ids it reported within `OVERLAP_MS` of that, and whether the server gives ids (then each look asks
 * from `OVERLAP_MS` before the mark). */
export const Mark = z.object({
  at: z.string(),
  ids: z.array(z.object({ id: z.string(), at: z.string() })).default([]),
  overlap: z.boolean().default(false),
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
  value === undefined ? undefined : typeof value === "string" ? { at: value, ids: [], overlap: false } : value

/** A server time in milliseconds; one without a zone is UTC, as the server keeps them. */
const ms = (at: string) => Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(at) ? at : `${at}Z`)

/** The `since` a look asks from. */
export function sinceOf(mark: Mark): string | undefined {
  if (!mark.at) return undefined
  if (!mark.overlap) return mark.at
  const at = ms(mark.at)
  return Number.isNaN(at) ? mark.at : new Date(at - OVERLAP_MS).toISOString()
}

/** The mark after a look (or after merging two): the newest time, and the ids within `OVERLAP_MS` of it. */
export function advance(mark: Mark | undefined, items: Pick<Item, "id" | "at">[]): Mark {
  const times = [...(mark?.at ? [mark.at] : []), ...items.map((i) => i.at)].filter((at) => !Number.isNaN(ms(at)))
  const at = times.reduce<string>((a, b) => (a && ms(a) >= ms(b) ? a : b), "") || mark?.at || ""
  const floor = at ? ms(at) - OVERLAP_MS : Number.NEGATIVE_INFINITY
  const ids = new Map<string, string>()
  for (const entry of [...(mark?.ids ?? []), ...items.flatMap((i) => (i.id ? [{ id: i.id, at: i.at }] : []))])
    if (ms(entry.at) > floor) ids.set(entry.id, entry.at)
  return {
    at,
    ids: [...ids].map(([id, at]) => ({ id, at })).slice(-200),
    overlap: (mark?.overlap ?? false) || items.some((i) => i.id !== undefined),
  }
}

/** Where each client's last look is kept. */
export const dir = () => path.join(Global.Path.state, "workspace-activity")
const fileOf = (scope: Scope) =>
  path.join(
    dir(),
    createHash("sha256").update(JSON.stringify([scope.apiUrl, scope.tenant, scope.account, scope.datamateId])).digest("hex") +
      ".json",
  )

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

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const nameOf = (item: Item) => cap(printable(item.name).trim(), NAME_MAX)

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
    group.subjects.add(item.subject ?? `name:${name}`)
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

export type Changes =
  /** `seen`: with `defer`, the mark to hand back to `acknowledge` once the line was shown. */
  | { status: "ok"; workspace: { id: number; name: string }; items: Item[]; line?: string; seen?: Mark }
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
      const { items, hasMore } = await fetchActivity(workspace.id, mark && sinceOf(mark), actAs, LIMIT)
      const reported = new Set(mark?.ids.map((entry) => entry.id))
      const fresh = items.filter((item) => item.id === undefined || !reported.has(item.id))
      const next = advance(mark, items)
      const save = () =>
        JSON.stringify(next) === JSON.stringify(mark) ? Promise.resolve() : writeSeen({ ...state, seen: { ...state.seen, [host]: next } })
      if (mark === undefined) {
        await save()
        return { status: "first", workspace }
      }
      const line = summaryLine(workspace.name, fresh, hasMore)
      if (line && options.defer) return { status: "ok", workspace, items: fresh, line, seen: next }
      await save()
      return { status: "ok", workspace, items: fresh, ...(line ? { line } : {}) }
    })
  } catch (error) {
    return failure(error)
  }
}

/** The line from a deferred look was shown: record its mark, merged with any look since. Never throws. */
export async function acknowledge(directory: string, host: string, seen: Mark): Promise<{ status: "ok" } | Changes> {
  try {
    const where = await locate(directory)
    if (!where.ok) return where.changes
    const { scope } = where
    return await locked(scope, async () => {
      const state = await readSeen(scope)
      const current = markOf(state.seen[host])
      const merged = advance(current ? { ...current, overlap: current.overlap || seen.overlap } : seen, [...seen.ids, ...(seen.at ? [{ at: seen.at }] : [])])
      await writeSeen({ ...state, seen: { ...state.seen, [host]: merged } })
      return { status: "ok" as const }
    })
  } catch (error) {
    return failure(error)
  }
}

export * as WorkspaceActivity from "./workspace-activity"

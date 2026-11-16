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
// newest change's own server time, so a clock that is off cannot hide a change or show one twice.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { classify } from "../rules/api"
import { printable } from "../rules/printable"
import { altimateRequest, type ActAs } from "./api-client"

/** How many changes one look reads. */
export const LIMIT = 20
/** How many names the line gives for one kind of change. */
const NAMED = 3

export const Item = z.object({
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

const Seen = z.object({
  version: z.literal(1),
  scope: z.object({ apiUrl: z.string(), tenant: z.string(), account: z.string(), datamateId: z.number() }),
  /** Per client: the server time of the newest change it was given; "" when it first looked at an empty window. */
  seen: z.record(z.string(), z.string()).default({}),
})
type Seen = z.infer<typeof Seen>
type Scope = Seen["scope"]

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

/** The one line: "Since your last session in X: 2 skills added (a, b), 1 knowledge base removed (c)." Several changes
 * to one item count once per kind of change; the newest come first. Text is made printable. */
export function summaryLine(workspaceName: string, items: Item[], hasMore = false): string | undefined {
  if (items.length === 0) return undefined
  const groups = new Map<string, { kind: Item["kind"]; action: Item["action"]; names: string[] }>()
  for (const item of items) {
    const key = `${item.kind}:${item.action}`
    const group = groups.get(key) ?? { kind: item.kind, action: item.action, names: [] }
    const name = printable(item.name)
    if (!group.names.includes(name)) group.names.push(name)
    groups.set(key, group)
  }
  const parts = [...groups.values()].map(({ kind, action, names }) => {
    const shown = names.slice(0, NAMED).join(", ")
    const more = names.length > NAMED ? `, and ${names.length - NAMED} more` : ""
    return `${plural(names.length, kind)} ${action} (${shown}${more})`
  })
  return `Since your last session in ${printable(workspaceName)}: ${parts.join(", ")}${hasMore ? ", and more" : ""}.`
}

export type Changes =
  | { status: "ok"; workspace: { id: number; name: string }; items: Item[]; line?: string }
  /** First look for this client: where to start from is recorded, nothing is said. */
  | { status: "first"; workspace: { id: number; name: string } }
  | { status: "signed_out" | "not_linked" | "account_changed" | "unconfirmed" | "unsupported" }
  | { status: "failed"; error: string }

/** What changed on the project's workspace since `host` last looked, and mark it seen. Never throws. */
export async function changesSince(directory: string, host: string): Promise<Changes> {
  try {
    const { context } = await import("./review-requests")
    const ctx = await context(directory)
    if (!ctx.ready) return { status: ctx.status }
    const { RulesSync } = await import("../rules/sync")
    const account = await RulesSync.accountOf(ctx.actAs)
    if (!account) return { status: "account_changed" }
    const scope: Scope = {
      apiUrl: ctx.actAs.url.replace(/\/+$/, ""),
      tenant: ctx.actAs.instance,
      account,
      datamateId: ctx.datamateId,
    }
    const workspace = { id: ctx.datamateId, name: ctx.name }
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 })
    return await Flock.withLock(
      `workspace-activity:${path.basename(fileOf(scope))}`,
      async (): Promise<Changes> => {
        const state = await readSeen(scope)
        // Undefined: never looked. "": looked when nothing had changed in the window, so everything listed since is
        // new (no local clock is involved). Otherwise the newest change it was given.
        const since = state.seen[host]
        const first = since === undefined
        const { items, hasMore } = await fetchActivity(ctx.datamateId, since || undefined, ctx.actAs, first ? 1 : LIMIT)
        const mark = items[0]?.at ?? since ?? ""
        if (mark !== since) await writeSeen({ ...state, seen: { ...state.seen, [host]: mark } })
        if (first) return { status: "first", workspace }
        const line = summaryLine(workspace.name, items, hasMore)
        return { status: "ok", workspace, items, ...(line ? { line } : {}) }
      },
      { dir: dir(), staleMs: 60_000, timeoutMs: 5_000 },
    )
  } catch (error) {
    const { ReviewApi } = await import("./review-api")
    if (ReviewApi.unavailable(error)) return { status: "unsupported" }
    return { status: "failed", error: printable(error instanceof Error ? error.message : String(error)) }
  }
}

export * as WorkspaceActivity from "./workspace-activity"

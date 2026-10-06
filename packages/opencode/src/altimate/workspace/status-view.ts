// altimate_change - new file
//
// What the last session got from its workspace, per integration — the view
// behind `/workspace` → Status, and the one-line forms the menu row and the
// sidebar show. Built from the overlay's attach snapshot: what was declared at
// attach time, what the engine served, and what it reported it could not. The
// live selection and catalog only supply current display names and tell the
// view whether the selection has changed since.
//
// TRANSPORT-AGNOSTIC, like `manage.ts`: plain data in, plain data out, no TUI
// or CLI imports, nothing printed. The dialog and the sidebar render it; a
// headless route could serve it as is.
import { AltimateApi } from "@/altimate/api/client"
import { sanitize } from "@/mcp/catalog"
import { Log } from "@/altimate/util/log"
import {
  currentAttachSnapshot,
  describeAge,
  snapshotCounts,
  statusHeadline,
  type AttachCounts,
  type AttachSnapshot,
} from "./attach-snapshot"
import { reasonPhrase, type Unfulfilled } from "./engine-types"
import { currentScope, scopeStringOf } from "./state"

export { statusHeadline } from "./attach-snapshot"

const log = Log.create({ service: "altimate-workspace-status" })

export interface Gap {
  key: string
  reason: string
  /** The reason in the user's words. */
  phrase: string
  detail?: string
}

/** One integration the workspace declared, and how much of it this session got. */
export interface IntegrationRow {
  id: string
  name: string
  /** `served`: every declared key present. `partial`: some. `missing`: none,
   * with reasons. `unknown`: none, and the engine said nothing about them (no
   * report, or a key it dropped without reporting). `idle`: an extension
   * integration with no IDE bridge — expected without a VS Code window. */
  state: "served" | "partial" | "missing" | "unknown" | "idle"
  extension: boolean
  declared: string[]
  served: string[]
  gaps: Gap[]
  /** Declared keys the engine neither served nor reported: it dropped them
   * without saying why. */
  unreported: string[]
}

export interface StatusView extends Omit<AttachCounts, "callable"> {
  workspace: { id: string; name: string }
  engineVersion: string | null
  at: number
  rows: IntegrationRow[]
  /** Keys the engine served beyond the allowlist (knowledge, memory). Empty
   * when no allowlist could be read, since then nothing can be called extra. */
  extras: string[]
  /** The workspace's selection now differs from the one this attach was
   * measured against; the rows describe the attach. */
  selectionChanged: boolean
}

interface SelectionIntegration {
  id: string
  tools?: { key: string }[]
}
interface CatalogEntry {
  id: string
  name: string
  type?: string
}

/** Join the snapshot to what the API says now. Pure. Either half of `live` can
 * be missing on its own: without the catalog, rows carry the names recorded at
 * attach time; without the selection, a change since the attach cannot be told.
 * A key the engine reported for an integration the declaration does not list
 * still gets a row, named by its id, so a report is never silently dropped. */
export function buildStatusView(
  snapshot: AttachSnapshot,
  live: { selection: SelectionIntegration[] | null; catalog: CatalogEntry[] | null } | null,
): StatusView {
  const names = new Map((live?.catalog ?? []).map((c) => [String(c.id), c.name]))
  const present = new Set(snapshot.present)
  const reportedKeys = new Set((snapshot.unfulfilled ?? []).map((u) => u.key))
  const reported = new Map<string, Unfulfilled[]>()
  for (const u of snapshot.unfulfilled ?? []) {
    const list = reported.get(u.integrationId) ?? []
    list.push(u)
    reported.set(u.integrationId, list)
  }
  const declaredIntegrations = snapshot.declared?.integrations ?? []
  const rows: IntegrationRow[] = []
  const seen = new Set<string>()
  for (const integration of declaredIntegrations) {
    seen.add(integration.id)
    // Never a key the engine reports unfulfilled: two raw keys can sanitise to one catalog name.
    // And one key per catalog entry: two raw keys that sanitise to one name are one tool.
    const entries = new Set<string>()
    const served = integration.keys.filter((k) => {
      const entry = sanitize(k)
      if (!present.has(entry) || reportedKeys.has(k) || entries.has(entry)) return false
      entries.add(entry)
      return true
    })
    const gaps = toGaps(reported.get(integration.id) ?? [])
    // An extension's absent keys are expected without its IDE bridge, not dropped.
    const unreported = integration.extension
      ? []
      : integration.keys.filter((k) => !present.has(sanitize(k)) && !reportedKeys.has(k))
    rows.push({
      id: integration.id,
      name: names.get(integration.id) ?? integration.name ?? `Integration ${integration.id}`,
      extension: integration.extension,
      declared: integration.keys,
      served,
      gaps,
      unreported,
      state: rowState({ declared: integration.keys, served, gaps, extension: integration.extension }),
    })
  }
  // Reported for an integration the declaration does not carry: keep it visible.
  for (const [id, list] of reported) {
    if (seen.has(id)) continue
    const gaps = toGaps(list)
    rows.push({
      id,
      name: names.get(id) ?? `Integration ${id}`,
      extension: false,
      declared: list.map((u) => u.key),
      served: [],
      gaps,
      unreported: [],
      state: gaps.length > 0 ? "missing" : "idle",
    })
  }
  rows.sort(byAttention)
  const declaredEntries = snapshot.declared
    ? new Set([...snapshot.declared.keys, ...snapshot.declared.extensionKeys].map(sanitize))
    : null
  const extras = declaredEntries ? snapshot.present.filter((k) => !declaredEntries.has(k)).sort() : []
  const { callable: _callable, ...counts } = snapshotCounts(snapshot)
  return {
    workspace: { id: snapshot.workspace.id, name: snapshot.workspace.name },
    engineVersion: snapshot.engineVersion,
    at: snapshot.at,
    ...counts,
    rows,
    extras,
    selectionChanged:
      !!live?.selection && !!snapshot.declared?.integrations && !sameSelection(declaredIntegrations, live.selection),
  }
}

function sameSelection(declared: { id: string; keys: string[] }[], selection: SelectionIntegration[]): boolean {
  const shape = (list: { id: string; keys: string[] }[]) =>
    JSON.stringify(list.map((i) => [i.id, [...i.keys].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  return (
    shape(declared) === shape(selection.map((i) => ({ id: String(i.id), keys: (i.tools ?? []).map((t) => t.key) })))
  )
}

function toGaps(list: Unfulfilled[]): Gap[] {
  return list
    .filter((u) => u.reason !== "no-bridge")
    .map((u) => ({
      key: u.key,
      reason: u.reason,
      phrase: reasonPhrase(u.reason),
      ...(u.detail ? { detail: u.detail } : {}),
    }))
}

function rowState(row: {
  declared: string[]
  served: string[]
  gaps: Gap[]
  extension: boolean
}): IntegrationRow["state"] {
  if (row.declared.length === 0) return "served"
  if (row.served.length === row.declared.length) return "served"
  if (row.served.length > 0) return "partial"
  if (row.gaps.length > 0) return "missing"
  // Nothing served and nothing reported wrong: an extension waiting for its
  // window, or keys the engine said nothing about.
  return row.extension ? "idle" : "unknown"
}

/** Rows that need attention first, then partial, unexplained, served, idle. */
const ORDER: Record<IntegrationRow["state"], number> = { missing: 0, partial: 1, unknown: 2, served: 3, idle: 4 }
function byAttention(a: IntegrationRow, b: IntegrationRow): number {
  return ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name)
}

/** One line for a row: counts and, when something is wrong, why. */
export function rowLine(row: IntegrationRow): string {
  const counts = row.declared.length > 0 ? `${row.served.length} of ${row.declared.length}` : `${row.served.length}`
  if (row.state === "idle") return `${counts} · needs a VS Code window open on this project`
  if (row.state === "unknown") return `${counts} · not reported by the engine`
  if (row.gaps.length === 0) return counts
  const phrases = [...new Set(row.gaps.map((g) => g.phrase))]
  const details = [...new Set(row.gaps.flatMap((g) => (g.detail ? [g.detail] : [])))]
  return `${counts} · ${phrases.join("; ")}${details.length > 0 ? ` (${details.join("; ")})` : ""}`
}

/** The `/workspace` menu's Status row: the headline, or why there is none. */
export function menuStatusLine(snapshot: AttachSnapshot | undefined): string {
  if (!snapshot) return "No session has attached yet — send a message first."
  return statusHeadline(snapshotCounts(snapshot))
}

/** The sidebar tile's line: the headline, and how old it is. */
export function sidebarAttachLine(snapshot: AttachSnapshot, now = Date.now()): string {
  return `${statusHeadline(snapshotCounts(snapshot))} · last session ${describeAge(snapshot.at, now)}`
}

/** The last attach for `binding`, matched under the account scope the binding
 * cache and the overlay use (tenant, URL and credential digest). Undefined when
 * no session has attached to it under these credentials. */
export async function boundAttachSnapshot(
  directory: string,
  binding: { datamateId: number | string } | null,
): Promise<AttachSnapshot | undefined> {
  if (!binding) return undefined
  const key = await currentScope().catch(() => null)
  return currentAttachSnapshot(directory, { scope: key ? scopeStringOf(key) : null, datamateId: binding.datamateId })
}

/** The live selection, or null when the read could not say what it is: a
 * missing list, or an integration without its tools, is not an empty selection. */
function selectionOf(integrations: { id: unknown; tools?: { key: string }[] }[] | null | undefined) {
  if (!integrations || integrations.some((i) => !Array.isArray(i.tools))) return null
  return integrations.map((i) => ({ id: String(i.id), tools: i.tools }))
}

/** Load the view for the workspace this directory is bound to. Null when no
 * session has attached to it yet, checked before any request; the snapshot
 * alone (with the names recorded at attach time) when the API cannot be
 * reached, so a network blip does not hide what the session already knows. */
export async function loadStatusView(
  directory: string,
  bound: { scope: string | null | undefined; datamateId: number | string },
): Promise<StatusView | null> {
  const snapshot = currentAttachSnapshot(directory, bound)
  if (!snapshot) return null
  // Read independently: a catalog outage must not hide a changed selection, nor
  // the other way round.
  const [workspace, catalog] = await Promise.allSettled([
    AltimateApi.getDatamate(snapshot.workspace.id),
    AltimateApi.listIntegrations(),
  ])
  for (const r of [workspace, catalog])
    if (r.status === "rejected") log.warn("status view: an API read failed", { err: String(r.reason) })
  return buildStatusView(snapshot, {
    selection: workspace.status === "fulfilled" ? selectionOf(workspace.value.integrations) : null,
    catalog:
      catalog.status === "fulfilled"
        ? catalog.value.map((c) => ({ id: String(c.id), name: c.name ?? `Integration ${c.id}`, type: c.type }))
        : null,
  })
}

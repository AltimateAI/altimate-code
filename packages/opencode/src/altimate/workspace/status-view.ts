// altimate_change - new file
//
// What the last session got from its workspace, per integration — the view
// behind `/workspace` → Status and the sidebar's counts line. Built from the
// overlay's attach snapshot (what the engine served and what it reported it
// could not) joined to the workspace's own selection and the catalog (which
// integration each key belongs to, and its display name).
//
// TRANSPORT-AGNOSTIC, like `manage.ts`: plain data in, plain data out, no TUI
// or CLI imports, nothing printed. The dialog and the sidebar render it; a
// headless route could serve it as is.
import { AltimateApi } from "@/altimate/api/client"
import { sanitize } from "@/mcp/catalog"
import { Log } from "@/altimate/util/log"
import { attachSnapshot } from "./engine-overlay"
import type { AttachSnapshot } from "./attach-snapshot"
import { reasonPhrase, type Unfulfilled } from "./engine-types"

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
   * with reasons. `idle`: an extension integration with no IDE bridge — expected
   * without a VS Code window, not a gap. */
  state: "served" | "partial" | "missing" | "idle"
  extension: boolean
  declared: string[]
  served: string[]
  gaps: Gap[]
}

export interface StatusView {
  workspace: { id: string; name: string }
  engineVersion: string | null
  /** Declared keys present, over declared keys — the same pair the toast says. */
  served: number
  declared: number | undefined
  /** Gaps the engine reported, excluding the expected no-bridge case. */
  gaps: number
  extServed: number
  at: number
  rows: IntegrationRow[]
  /** Keys the engine served beyond the allowlist (knowledge, memory). */
  extras: string[]
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

/** Join the snapshot to the selection and the catalog. Pure. A key the engine
 * reported for an integration the selection no longer lists still gets a row,
 * named by its id, so a report is never silently dropped. */
export function buildStatusView(
  snapshot: AttachSnapshot,
  selection: SelectionIntegration[],
  catalog: CatalogEntry[],
): StatusView {
  const byId = new Map(catalog.map((c) => [String(c.id), c]))
  const present = new Set(snapshot.present)
  const reported = new Map<string, Unfulfilled[]>()
  for (const u of snapshot.unfulfilled ?? []) {
    const list = reported.get(u.integrationId) ?? []
    list.push(u)
    reported.set(u.integrationId, list)
  }
  const rows: IntegrationRow[] = []
  const declaredKeys = new Set<string>()
  // Never a key the engine reports unfulfilled: two raw keys can sanitise to one catalog name.
  const reportedKeys = new Set((snapshot.unfulfilled ?? []).map((u) => u.key))
  const seen = new Set<string>()
  for (const integration of selection) {
    const id = String(integration.id)
    seen.add(id)
    const entry = byId.get(id)
    const declared = (integration.tools ?? []).map((t) => t.key)
    for (const k of declared) declaredKeys.add(k)
    const served = declared.filter((k) => present.has(sanitize(k)) && !reportedKeys.has(k))
    const gaps = toGaps(reported.get(id) ?? [])
    const extension = entry?.type === "extension"
    rows.push({
      id,
      name: entry?.name ?? `Integration ${id}`,
      extension,
      declared,
      served,
      gaps,
      state: rowState({ declared, served, gaps, extension }),
    })
  }
  // Reported for an integration the selection does not carry: keep it visible.
  for (const [id, list] of reported) {
    if (seen.has(id)) continue
    const gaps = toGaps(list)
    rows.push({
      id,
      name: byId.get(id)?.name ?? `Integration ${id}`,
      extension: byId.get(id)?.type === "extension",
      declared: list.map((u) => u.key),
      served: [],
      gaps,
      state: gaps.length > 0 ? "missing" : "idle",
    })
  }
  rows.sort(byAttention)
  const extras = snapshot.present.filter((k) => !declaredKeys.has(k)).sort()
  const declaredCount = snapshot.declared?.keys.length
  // Counted per catalog entry: declarations that sanitise to one name are one tool.
  const served = snapshot.declared
    ? new Set(snapshot.declared.keys.filter((k) => present.has(sanitize(k)) && !reportedKeys.has(k)).map(sanitize)).size
    : present.size
  const gapCount = (snapshot.unfulfilled ?? []).filter((u) => u.reason !== "no-bridge").length
  return {
    workspace: snapshot.workspace,
    engineVersion: snapshot.engineVersion,
    served,
    declared: declaredCount,
    gaps: gapCount,
    extServed: snapshot.extServed,
    at: snapshot.at,
    rows,
    extras,
  }
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
  if (row.declared.length > 0 && row.served.length === row.declared.length) return "served"
  if (row.served.length > 0) return "partial"
  if (row.gaps.length > 0) return "missing"
  // Nothing served and nothing reported wrong: an extension waiting for its
  // window, or an integration the engine had nothing to say about.
  return row.extension ? "idle" : row.declared.length === 0 ? "served" : "idle"
}

/** Rows that need attention first, then partial, then served, then idle. */
const ORDER: Record<IntegrationRow["state"], number> = { missing: 0, partial: 1, served: 2, idle: 3 }
function byAttention(a: IntegrationRow, b: IntegrationRow): number {
  return ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name)
}

/** The headline the dialog and the sidebar share: counts only. */
export function statusHeadline(view: Pick<StatusView, "served" | "declared" | "gaps" | "extServed" | "rows">): string {
  const parts = [
    view.declared === undefined
      ? `${view.served} integration tools available`
      : `${view.served} of ${view.declared} integration tools available`,
  ]
  if (view.gaps > 0) parts.push(`${view.gaps} need${view.gaps === 1 ? "s" : ""} attention`)
  if (view.extServed > 0) parts.push(`${view.extServed} more via VS Code`)
  return parts.join(" · ")
}

/** One line for a row: counts and, when something is wrong, why. */
export function rowLine(row: IntegrationRow): string {
  const counts = row.declared.length > 0 ? `${row.served.length} of ${row.declared.length}` : `${row.served.length}`
  if (row.state === "idle") return `${counts} · needs a VS Code window open on this project`
  if (row.gaps.length === 0) return counts
  const phrases = [...new Set(row.gaps.map((g) => g.phrase))]
  const detail = row.gaps.find((g) => g.detail)?.detail
  return `${counts} · ${phrases.join("; ")}${detail ? ` (${detail})` : ""}`
}

/** Load the view for a directory: the snapshot from memory, the selection and
 * the catalog from the API. Null when no session has attached there yet; the
 * snapshot alone (rows named by id) when the API cannot be reached, so a
 * network blip does not hide what the session already knows. */
export async function loadStatusView(directory: string): Promise<StatusView | null> {
  const snapshot = attachSnapshot(directory)
  if (!snapshot) return null
  try {
    const [workspace, catalog] = await Promise.all([
      AltimateApi.getDatamate(snapshot.workspace.id),
      AltimateApi.listIntegrations(),
    ])
    return buildStatusView(
      snapshot,
      (workspace.integrations ?? []).map((i) => ({ id: String(i.id), tools: i.tools })),
      catalog.map((c) => ({ id: String(c.id), name: c.name ?? `Integration ${c.id}`, type: c.type })),
    )
  } catch (err) {
    log.warn("could not load the workspace selection for the status view", { err: String(err) })
    return buildStatusView(snapshot, [], [])
  }
}

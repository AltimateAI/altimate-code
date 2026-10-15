// altimate_change - new file
//
// Which connection each of a workspace's integrations uses, and the user's
// choice of it: the picker behind `/integrations`, at parity with the IDE
// extension's integrations panel.
//
// The choice lives where the engine reads it, `~/.altimate/settings.json`:
// `{ "<workspaceId>": { "<integrationId>": "<connectionId>" } }`, beside keys
// other writers own (the extension's `_activeTeammates`, other workspaces).
// The engine re-reads the file on every call, but fetches its connections once
// when it starts and never says its tools changed, so the overlay starts it
// again when this workspace's entry changes (`choiceFingerprint`).
//
// The engine's rules are mirrored here because nothing exposes them: which
// integrations take a choice (`takesChoice`), which connections an integration
// can use (`usable`), and the one used when nothing is chosen (the usable
// connection with the lowest id). A choice that names a connection the
// integration cannot use turns the integration off: the engine does not fall
// back to the default.
//
// Connection configs arrive decrypted. They are read here only to tell whether
// a connection is usable, and never leave this module.
import path from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Global } from "@/global"

/** One connection field of the integration catalog. */
interface ConfigField {
  key: string
  required: boolean
}

/** An integration as the catalog describes it; `config` and the variants as
 * the API returns them, read leniently. */
export interface CatalogIntegration {
  id: string
  type?: string
  config?: unknown
  additionalConfigVariants?: unknown
}

/** A connection as fetched or read from disk, config included. */
export interface RawConnection {
  id: string
  name: string
  integrationId: string
  config: Record<string, unknown>
  remote: boolean
}

/** A connection as the picker shows it: no config. */
export interface ConnectionOption {
  id: string
  name: string
  remote: boolean
  /** Carries every field the integration requires. */
  usable: boolean
}

/** The connection an integration uses now. `chosen`: the explicit choice.
 * `default`: no choice, so the lowest usable id. `off`: the choice names a
 * connection that is gone or incomplete, so the integration has no tools.
 * `none`: no choice and no usable connection. */
export type InUse =
  | { kind: "chosen"; connection: ConnectionOption }
  | { kind: "default"; connection: ConnectionOption }
  | { kind: "off"; id: string; name?: string }
  | { kind: "none" }

export interface ConnectionChoice {
  integrationId: string
  /** The integration's connections, in the engine's default order. */
  options: ConnectionOption[]
  inUse: InUse
}

/** In-house integrations whose tools take a connection per call; the engine's
 * other integrations of type `tool` use the one chosen (the base default). */
const PER_CALL_TOOLS = new Set(["dbt", "altimate", "altimate_knowledge", "bigquery", "snowflake", "postgresql"])

function fields(raw: unknown): ConfigField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((f) =>
    f && typeof f === "object" && typeof (f as { key?: unknown }).key === "string"
      ? [{ key: (f as { key: string }).key, required: Boolean((f as { required?: unknown }).required) }]
      : [],
  )
}

/** Whether the engine uses one chosen connection for this integration, rather
 * than a connection named per call. Needs connection fields at all; then by
 * type: `api` and `mcp` do, `code` and `extension` do not, and an in-house
 * `tool` does unless its tools take the connection per call. */
export function takesChoice(integration: CatalogIntegration): boolean {
  if (!fields(integration.config)?.length) return false
  if (integration.type === "api" || integration.type === "mcp") return true
  if (integration.type === "tool") return !PER_CALL_TOOLS.has(integration.id)
  return false
}

/** Whether the integration can use the connection: it owns it, and every field
 * required by the connection's variant (or by the integration, for the default
 * variant) is set. A variant the integration does not declare is unusable,
 * unless the integration declares no variants at all. */
export function usable(integration: CatalogIntegration, connection: RawConnection): boolean {
  if (connection.integrationId !== integration.id) return false
  const config = connection.config
  const type = config.type
  const isDefault = type === undefined || type === null || type === "" || type === "default"
  const variants = Array.isArray(integration.additionalConfigVariants)
    ? (integration.additionalConfigVariants as { id?: unknown; config?: unknown }[])
    : []
  const variant = isDefault ? undefined : variants.find((v) => v && v.id === type)
  const variantFields = variant ? fields(variant.config) : undefined
  if (!isDefault && variantFields === undefined && variants.length > 0) return false
  const required = (isDefault ? fields(integration.config) : variantFields) ?? []
  return required.filter((f) => f.required).every((f) => Boolean(config[f.key]))
}

/** The engine's default order: numeric ids first, numerically, then the rest
 * by id. Remote connections have numeric ids, local ones UUIDs. */
function byDefaultOrder(a: { id: string }, b: { id: string }): number {
  const an = Number(a.id)
  const bn = Number(b.id)
  const aNumeric = Number.isFinite(an)
  const bNumeric = Number.isFinite(bn)
  if (aNumeric && bNumeric) return an - bn
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a.id.localeCompare(b.id)
}

/** What one integration uses, from its connections and the choice recorded for
 * it (`undefined` when there is none; anything else the engine compares as is). */
export function choiceFor(
  integration: CatalogIntegration,
  connections: RawConnection[],
  chosen: unknown,
): ConnectionChoice {
  const options = connections
    .filter((c) => c.integrationId === integration.id)
    .map((c) => ({ id: c.id, name: c.name, remote: c.remote, usable: usable(integration, c) }))
    .sort(byDefaultOrder)
  let inUse: InUse
  if (chosen === undefined) {
    const fallback = options.find((o) => o.usable)
    inUse = fallback ? { kind: "default", connection: fallback } : { kind: "none" }
  } else {
    const match = typeof chosen === "string" ? options.find((o) => o.id === chosen) : undefined
    inUse = match?.usable
      ? { kind: "chosen", connection: match }
      : { kind: "off", id: String(chosen), ...(match ? { name: match.name } : {}) }
  }
  return { integrationId: integration.id, options, inUse }
}

// ── settings.json ───────────────────────────────────────────────────────────

export function settingsPath(): string {
  return path.join(Global.Path.home, ".altimate", "settings.json")
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** The whole file: `{}` when it is missing or empty, as the engine reads it. */
function readSettings(): Record<string, unknown> {
  const p = settingsPath()
  if (!existsSync(p)) return {}
  const text = readFileSync(p, "utf8")
  if (text.trim() === "") return {}
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`${p} does not hold a JSON object`)
  return parsed
}

/** The choices recorded for a workspace, by integration id; `{}` when none.
 * Throws when the file cannot be read or parsed. */
export function readChoices(workspaceId: string): Record<string, unknown> {
  const entry = readSettings()[workspaceId]
  return isRecord(entry) ? entry : {}
}

/** This workspace's entry in a stable form, to tell whether it changed; null
 * when the file cannot be read, so an unreadable file is never a change. */
export function choiceFingerprint(workspaceId: string): string | null {
  try {
    const entry = readChoices(workspaceId)
    return JSON.stringify(Object.keys(entry).sort().map((k) => [k, entry[k]]))
  } catch {
    return null
  }
}

/** Record the choice: read, change this one integration, write back, every
 * other key kept. Written in place, as the engine writes it: the extension's
 * engine watches the file, and a rename would leave that watch on the old file.
 * A file that does not parse is not written over (the engine's own writer
 * would start it from empty); the error says why. */
export function chooseConnection(workspaceId: string, integrationId: string, connectionId: string): void {
  const settings = readSettings()
  const entry = settings[workspaceId]
  if (entry !== undefined && !isRecord(entry))
    throw new Error(`the entry for workspace ${workspaceId} in ${settingsPath()} is not an object`)
  settings[workspaceId] = { ...entry, [integrationId]: connectionId }
  mkdirSync(path.dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

// ── local connections ───────────────────────────────────────────────────────

export function localConnectionsPath(): string {
  return path.join(Global.Path.home, ".altimate", "connections.json")
}

/** Connections created in the extension and kept on this machine, which the
 * engine serves beside the account's. A missing or unreadable file is none, as
 * the engine reads it; an entry without an id or an integration is skipped. */
export function readLocalConnections(): RawConnection[] {
  try {
    const p = localConnectionsPath()
    if (!existsSync(p)) return []
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((c) =>
      isRecord(c) && typeof c.id === "string" && c.integration_id !== undefined && c.integration_id !== null
        ? [
            {
              id: c.id,
              name: typeof c.name === "string" ? c.name : c.id,
              integrationId: String(c.integration_id),
              config: isRecord(c.config) ? c.config : {},
              remote: false,
            },
          ]
        : [],
    )
  } catch {
    return []
  }
}

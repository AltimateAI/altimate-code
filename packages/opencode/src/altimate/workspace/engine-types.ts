// altimate_change - new file
//
// Vocabulary for the workspace engine overlay: the outcome union, the
// derived MCP entry, and the pure predicates over them. Nothing here performs
// I/O or reads ambient state.
import { DATAMATE_KEY } from "@/altimate/datamate-transport"

/** Oldest engine this client works against.
 *
 * 0.7.0 is the first engine that LOCKS the `--datamate` pin, so a settings
 * change in the IDE cannot swap the workspace out from under a running engine.
 * Everything below it can drift. */
export const MIN_ENGINE_VERSION = "0.7.0"
export const ENGINE_PACKAGE = "@altimateai/datamate"
export const ENGINE_BINARY = "datamate"
export const INSTALL_COMMAND = `npm i -g ${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`

/** Engine tools arrive under the MCP server key as `<key>_<tool>`. */
export const TOOL_PREFIX = `${DATAMATE_KEY}_`

/** What a session knows about its workspace engine, settled at the turn
 * boundary. `undefined` (never settled) is distinct from every kind here. */
export type Outcome =
  | { kind: "disabled" }
  | { kind: "unbound" }
  | { kind: "attached"; available: number; declared?: number; missing?: string[] }
  | { kind: "engine-missing"; declared?: number }
  /** `found` is null when the binary ran but printed nothing usable — broken
   * rather than old; the message says so. */
  | { kind: "engine-too-old"; found: string | null }
  | { kind: "connect-failed"; error: string }

/** The MCP entry this module derives. Never written to disk. */
export type LocalMcpConfig = {
  type: "local"
  command: string[]
  enabled: true
}

export type Toast = { title: string; message: string; variant: "info" | "success" | "warning" | "error" }

export type McpStatus = Record<string, { status: string; error?: string } | undefined>

/** Declared allowlist for a workspace, split by whether the CLI can serve it.
 * Extension-type integrations are RPC into a live VS Code host and have no
 * meaning on the CLI surface, so they are excluded from the reported gap. */
export type Declared = { keys: string[]; extensionKeys: string[] }

/** A configured MCP entry in either shape it can reach us: opencode's own
 * `command: string[]` argv, or the `{ command, args }` split an IDE writes. */
export type EntryLike = {
  type?: string
  url?: string
  command?: string[] | string
  args?: string[]
}

export const PIN_FLAG = "--datamate"

export function engineEntry(workspaceId: string): LocalMcpConfig {
  return { type: "local", command: [ENGINE_BINARY, "start-stdio", PIN_FLAG, workspaceId], enabled: true }
}

/** SemVer precedence compare. Returns <0, 0, >0.
 *
 * Build metadata is ignored. A NON-numeric or non-three-part core compares as
 * older than any readable one, so unreadable `--version` output can never
 * clear the floor (`parseInt` would read "7rc" as 7). Pre-releases rank below
 * their release (SemVer §11.3): the floor names behaviour that shipped in a
 * specific release, and a pre-release of it predates that. */
export function compareVersions(a: string, b: string): number {
  const parseCore = (raw: string): number[] | null => {
    const parts = raw.split(".")
    if (parts.length !== 3) return null
    if (!parts.every((part) => /^\d+$/.test(part))) return null
    return parts.map((part) => Number(part))
  }
  const split = (v: string) => {
    const bare = v.trim().replace(/^v/, "")
    const plus = bare.indexOf("+")
    const noBuild = plus >= 0 ? bare.slice(0, plus) : bare
    const dash = noBuild.indexOf("-")
    return {
      core: parseCore(dash >= 0 ? noBuild.slice(0, dash) : noBuild),
      pre: dash >= 0 ? noBuild.slice(dash + 1) : "",
    }
  }
  const pa = split(a)
  const pb = split(b)
  if (!pa.core || !pb.core) return !pa.core && !pb.core ? 0 : pa.core ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const ia = pa.pre.split(".")
  const ib = pb.pre.split(".")
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i]
    const y = ib[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Is this engine version usable? An unreadable version is below the floor:
 * an engine that cannot say what it is cannot be shown to lock its pin. */
export function clearsFloor(version: string | null): boolean {
  return !!version && compareVersions(version, MIN_ENGINE_VERSION) >= 0
}

/** Strip the server prefix from the engine tools present in the catalog. */
export function engineToolKeys(tools: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(tools)) {
    if (key.startsWith(TOOL_PREFIX)) out.add(key.slice(TOOL_PREFIX.length))
  }
  return out
}

/** The entry's full argv, flattening both config shapes. */
export function commandArgv(entry: EntryLike | null): string[] {
  if (!entry) return []
  const head = typeof entry.command === "string" ? [entry.command] : (entry.command ?? [])
  return [...head, ...(entry.args ?? [])]
}

/** Which workspace does this entry pin its engine to, if any?
 *
 * `--datamate <id>` is the whole of an engine's workspace identity. An entry
 * without it serves whichever teammate its owner has active, which changes at
 * runtime from a UI this client does not control — the extension writes
 * exactly such an entry. Scanned from the end (repeated flag → last wins);
 * both `--datamate 5` and `--datamate=5` are valid. Fails open on a miss. */
export function pinnedWorkspace(entry: EntryLike | null): string | null {
  const argv = commandArgv(entry)
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]
    if (typeof arg !== "string") continue
    if (arg === PIN_FLAG) return typeof argv[i + 1] === "string" ? argv[i + 1] : null
    if (arg.startsWith(`${PIN_FLAG}=`)) return arg.slice(PIN_FLAG.length + 1) || null
  }
  return null
}

/** Why an engine was refused, in the user's terms. "Too old" and "could not be
 * run" are one code path and very different problems; conflating them sent
 * more than one debugging session hunting a version mismatch that did not
 * exist. */
export function describeRefusal(found: string | null, workspaceName: string): string {
  if (!found) {
    return (
      `The ${ENGINE_BINARY} on PATH did not report a usable version, so it cannot serve workspace ` +
      `"${workspaceName}". It is more likely broken than out of date — try \`${ENGINE_BINARY} --version\` ` +
      `directly. Reinstall with: ${INSTALL_COMMAND}`
    )
  }
  return (
    `Found ${ENGINE_BINARY} ${found}; workspace "${workspaceName}" needs ${MIN_ENGINE_VERSION} or newer. ` +
    `Update with: ${INSTALL_COMMAND}`
  )
}

export function describeMissing(missing: string[]): string {
  if (missing.length === 0) return ""
  const shown = missing.slice(0, 5).join(", ")
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : ""
  return ` Declared but not available: ${shown}${more}.`
}

/** What each outcome MEANS, as tables over the whole union: a new variant
 * fails to compile until every table names it, and the safe answer is false. */
export const SERVING: Record<Outcome["kind"], boolean> = {
  attached: true,
  disabled: false,
  unbound: false,
  "engine-missing": false,
  "engine-too-old": false,
  "connect-failed": false,
}

/** Would installing the engine fix this outcome? Only genuine unobtainability
 * qualifies; a failed connection is not an absence. */
export const INSTALL_HELPS: Record<Outcome["kind"], boolean> = {
  "engine-missing": true,
  "engine-too-old": true,
  attached: false,
  disabled: false,
  unbound: false,
  "connect-failed": false,
}

/** Outcomes a later turn may re-probe for, because the world can have changed
 * in a way the user was told how to fix. */
export const REPAIRABLE: Record<Outcome["kind"], boolean> = {
  "engine-missing": true,
  "engine-too-old": true,
  "connect-failed": true,
  attached: false,
  disabled: false,
  unbound: false,
}

/** Is the engine serving this session attributable to its bound workspace?
 * `undefined` means not settled and must stay distinguishable from a refusal:
 * the precedence consumer fails open on it. */
export function attributableEngine(outcome: Outcome | undefined): boolean {
  return !!outcome && SERVING[outcome.kind]
}

export function installWouldHelp(outcome: Outcome | undefined): boolean {
  return !!outcome && INSTALL_HELPS[outcome.kind]
}

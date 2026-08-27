// altimate_change - new file
//
// Vocabulary for the workspace engine attach: the outcome union, the shapes it
// reads, and the pure predicates over them. Nothing here performs I/O or reads
// ambient state, so nothing here can be reordered against anything else.
import { DATAMATE_KEY } from "@/altimate/datamate-transport"

/** Oldest engine this client is known to work against.
 *
 * 0.7.0 is the first engine that LOCKS the `--datamate` pin, so a settings
 * change cannot swap the workspace out from under a running engine. Everything
 * below it can drift, which is precisely what the attribution check in rule 1
 * exists to exclude — so the floor and that check are one mechanism, not two. */
export const MIN_ENGINE_VERSION = "0.7.0"
export const INSTALL_HINT = "npm i -g @altimateai/datamate"
export const ENGINE_BINARY = "datamate"

/** Engine tools arrive under the MCP server key as `<key>_<tool>`. */
export const TOOL_PREFIX = `${DATAMATE_KEY}_`

export type Outcome =
  | { kind: "disabled" }
  | { kind: "unbound" }
  | { kind: "reused"; available: number; declared?: number; missing?: string[] }
  | { kind: "attached"; available: number; declared: number; missing: string[]; replaced?: string }
  | { kind: "engine-missing"; declared: number }
  | { kind: "engine-too-old"; found: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "entry-disabled" }
  | { kind: "superseded" }

export type LocalMcpConfig = {
  type: "local"
  command: string[]
  enabled: boolean
  environment?: Record<string, string>
  cwd?: string
  timeout?: number
}

/** A configured MCP entry, in either shape it can reach us: opencode's own
 * `command: string[]` argv, or the `{ command, args }` split an IDE writes and
 * `datamate-transport` normalises. Read defensively — this is merged config
 * written by other clients. */
export type ExistingEntry = {
  type?: string
  url?: string
  command?: string[] | string
  args?: string[]
  environment?: Record<string, string>
  cwd?: string
  timeout?: number
  enabled?: boolean
}

export type Toast = { title: string; message: string; variant: "info" | "success" | "warning" | "error" }

export type McpStatus = Record<string, { status: string; error?: string } | undefined>

/** Declared allowlist for a workspace, split by whether the CLI can serve it.
 * Extension-type integrations are RPC into a live VS Code host and have no
 * meaning on the CLI surface, so they are excluded from the reported gap. */
export type Declared = { keys: string[]; extensionKeys: string[] }

/** SemVer precedence compare. Returns <0, 0, >0.
 *
 * Build metadata is ignored, and a NON-numeric core component compares as older
 * so unreadable `--version` output can never clear a floor.
 *
 * Pre-release ordering is honoured rather than stripped: `0.7.0-beta.1` is
 * BELOW `0.7.0`. That matters here — the floor exists to require behaviour that
 * shipped in a specific release (the locked `--datamate` pin), and a pre-release
 * of that version predates it. Treating them as equal let a beta clear the floor
 * and be trusted for reuse. */
export function compareVersions(a: string, b: string): number {
  /** An exact `major.minor.patch` of digits, or null.
   *
   * `Number.parseInt` was too permissive: it reads "7rc" as 7, so "0.7rc.0"
   * compared EQUAL to a 0.7.0 floor, and a bare "1" won on major before its
   * missing components were ever examined. Unreadable output must never
   * authorise reuse of an engine whose pin-locking cannot be established, so
   * anything not exactly three numeric parts is treated as older. */
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
  // A core we cannot read ranks below one we can, and two unreadable ones tie.
  if (!pa.core || !pb.core) return !pa.core && !pb.core ? 0 : pa.core ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  // Same core: a release outranks every pre-release of it (SemVer §11.3).
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

/** Strip the server prefix from the engine tools present in the catalog. */
export function engineToolKeys(tools: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(tools)) {
    if (key.startsWith(TOOL_PREFIX)) out.add(key.slice(TOOL_PREFIX.length))
  }
  return out
}

/** URL-based entries (`type: "remote"`, or any `url`) point at a process this
 * client does not own: an IDE's in-process engine, or the hosted endpoint. */
export function isUrlEntry(entry: ExistingEntry | null): entry is ExistingEntry & { url: string } {
  return !!entry && (entry.type === "remote" || typeof entry.url === "string")
}

export const PIN_FLAG = "--datamate"

/** The entry's full argv, flattening both config shapes. */
export function commandArgv(entry: ExistingEntry | null): string[] {
  if (!entry) return []
  const head = typeof entry.command === "string" ? [entry.command] : (entry.command ?? [])
  return [...head, ...(entry.args ?? [])]
}

/** Which workspace does this entry pin its engine to, if any?
 *
 * `--datamate <id>` is the whole of an engine's workspace identity: the engine
 * locks it, so a settings change cannot swap it out underneath. An entry
 * WITHOUT it is not neutral — it serves whichever teammate its owner currently
 * has active, and that changes at runtime from a UI this client does not
 * control. The extension writes exactly such an entry (`datamate start-stdio`,
 * no pin), so "connected" alone never proves an engine serves this workspace.
 *
 * Scanned from the end because a repeated flag resolves last-wins, and both the
 * `--datamate 5` and `--datamate=5` spellings are valid on the engine's CLI. */
export function pinnedWorkspace(entry: ExistingEntry | null): string | null {
  const argv = commandArgv(entry)
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]
    if (arg === PIN_FLAG) return argv[i + 1] ?? null
    if (arg.startsWith(`${PIN_FLAG}=`)) return arg.slice(PIN_FLAG.length + 1) || null
  }
  return null
}

/** Short, printable identity of an entry, for saying what was replaced. */
export function describeEntry(entry: ExistingEntry | null): string {
  if (isUrlEntry(entry)) return entry.url
  const argv = commandArgv(entry)
  return argv.length > 0 ? argv.join(" ") : "an engine entry with no command"
}

/** Why an engine was refused, in the user's terms.
 *
 * "Too old" and "could not be run at all" are the same code path but very
 * different problems, and conflating them sent more than one debugging session
 * hunting a version mismatch that did not exist. `versionOf` reads stdout only
 * and returns null when the process fails, so a null here means the binary did
 * not produce a version — broken, not merely out of date. */
export function describeRefusal(found: string | null, workspaceName: string): string {
  if (!found) {
    return (
      `The ${ENGINE_BINARY} on PATH did not report a usable version, so it cannot be used for workspace ` +
      `"${workspaceName}". It is more likely broken than out of date — try running \`${ENGINE_BINARY} --version\` ` +
      `directly. Reinstall with: ${INSTALL_HINT}`
    )
  }
  return (
    `Found ${ENGINE_BINARY} ${found}; workspace "${workspaceName}" needs ${MIN_ENGINE_VERSION} or newer. ` +
    `Update with: ${INSTALL_HINT}`
  )
}

export function describeMissing(missing: string[]): string {
  if (missing.length === 0) return ""
  const shown = missing.slice(0, 5).join(", ")
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : ""
  return ` Declared but not available: ${shown}${more}.`
}

/** Are these two entries the same entry?
 *
 * The identity a destructive act needs: is what is here still what I put here.
 * Compared by value rather than by reference, because what comes back from disk
 * or from MCP is a different object carrying the same meaning — and across
 * everything that changes the process it describes, not argv alone. */
/** Every field of an entry that identity depends on.
 *
 * Keyed by the type so the compiler asks the question: add a field to
 * `ExistingEntry` and this fails to build until someone either lists it here or
 * adds it to the exclusion, which makes ignoring it a decision rather than a
 * default. A field the comparison silently forgets makes two different entries
 * compare equal, and a teardown or an undo then acts on something that is not
 * its own while believing it is.
 *
 * `enabled` is excluded on purpose: a disabled entry is still the same entry.
 * Intent is decided above the comparison, which keeps a disable rather than
 * rolling it back; folding it in here would make a disable read as somebody
 * else's entry and take the wrong branch for the right-sounding reason. */
const IDENTITY_FIELDS: Record<Exclude<keyof ExistingEntry, "enabled">, true> = {
  type: true,
  url: true,
  command: true,
  args: true,
  environment: true,
  cwd: true,
  timeout: true,
}

export function sameEntry(a: ExistingEntry | null | undefined, b: ExistingEntry | null | undefined): boolean {
  const shape = (e: ExistingEntry | null | undefined) => {
    const raw = (e ?? {}) as Record<string, unknown>
    const parts: Record<string, unknown> = {
      // `command` and `args` are compared as the argv they produce, since the
      // same invocation can be spelled either way.
      argv: commandArgv((e ?? null) as ExistingEntry | null),
    }
    for (const field of Object.keys(IDENTITY_FIELDS)) {
      if (field === "command" || field === "args") continue
      parts[field] = raw[field] ?? null
    }
    return JSON.stringify(parts)
  }
  return shape(a) === shape(b)
}

/** Is this engine version usable at all?
 *
 * The single definition of "unusable" for this module. An unreadable version is
 * treated as below the floor: the floor exists because engines under it do not
 * lock their `--datamate` pin, and an engine that cannot say what it is cannot
 * be shown to lock it either. */
export function clearsFloor(version: string | null): boolean {
  return !!version && compareVersions(version, MIN_ENGINE_VERSION) >= 0
}

/** What each outcome MEANS, stated once, as tables over the whole union.
 *
 * Two different consumers — tool precedence and the install offer — each need a
 * yes/no answer about an outcome, and each had derived it independently: one by
 * comparing kinds inline, the other by relying on where its call site sat in the
 * control flow. Both are the same latent bug, which is that adding a state to
 * this union silently gives it an answer nobody chose.
 *
 * A `Record` keyed by the union is the strongest available guard: a new variant
 * fails to compile until every table names it, and a removed one fails too. That
 * holds regardless of tsconfig strictness, which a `switch` with no default does
 * not. The safe answer is `false` in both tables, so the compiler asks the
 * question and the answer is chosen deliberately. */
export const SERVING: Record<Outcome["kind"], boolean> = {
  attached: true,
  reused: true,
  disabled: false,
  unbound: false,
  "engine-missing": false,
  "engine-too-old": false,
  "connect-failed": false,
  "entry-disabled": false,
  // The binding moved while this attach was in flight, so whatever is connected
  // was established for a workspace this project has already left.
  superseded: false,
}

/** Would installing the engine fix this outcome?
 *
 * NOT the same question as "did the attach refuse", and the two diverge exactly
 * where it matters: a user who deliberately disabled their engine would be
 * offered an install for an engine they already have and switched off, and a
 * failed connection is not an absence. Only genuine unobtainability qualifies. */
export const INSTALL_HELPS: Record<Outcome["kind"], boolean> = {
  "engine-missing": true,
  "engine-too-old": true,
  attached: false,
  reused: false,
  disabled: false,
  unbound: false,
  "connect-failed": false,
  "entry-disabled": false,
  superseded: false,
}

/** Is an engine attributable to THIS session serving it?
 *
 * The contract for tool precedence: the config pin is the naming signal and this
 * is the runtime one, and both must agree before queries are routed into a
 * workspace's credentials. `undefined` means not settled — in flight or never
 * attached — and must stay distinguishable from a refusal, because the caller
 * fails open on it. */
export function attributableEngine(outcome: Outcome | undefined): boolean {
  return !!outcome && SERVING[outcome.kind]
}

/** Would offering to install the engine be a remedy for this outcome? */
export function installWouldHelp(outcome: Outcome | undefined): boolean {
  return !!outcome && INSTALL_HELPS[outcome.kind]
}

// Workspace precedence: when a bound workspace's engine serves a capability for a
// warehouse type, the equivalent native tool stops executing against a local
// connection of that type and points the model at the engine tool instead.
//
// One principle governs the whole module: shadow only what is MATERIALISED and
// ATTRIBUTED; anything undetermined runs locally with an explicit notice; nothing
// is ever silent.
//
//  1. Materialised, not declared. Precedence is derived from the engine tool keys
//     actually present in the model-facing MCP map, never from what the workspace
//     declared. A declared-but-broken integration shadows nothing.
//  1a. Attributed. The engine must be provably serving the *bound* workspace. An IDE
//     writes its `datamate` entry unpinned, and such an engine serves whichever
//     teammate is active in that IDE — changing at runtime. Attach now guarantees
//     attribution (it reuses only a live, pinned, version-current entry and replaces
//     anything else); this module re-checks that guarantee and refuses to engage if it
//     is ever violated. Defence in depth, not the primary control.
//  2. Capability-scoped. The engine's warehouse integrations are NOT symmetric —
//     snowflake serves execute/explain/inspect, bigquery and postgresql serve execute
//     only, databricks serves execute only. Shadowing is keyed on the individual
//     materialised tool key, so `sql_explain` on a BigQuery connection stays local
//     instead of redirecting to a tool that does not exist.
//  3. Default targets. A native call with no `warehouse` resolves through
//     `resolveDefaultTarget`, which mirrors each handler's own resolution.
//  4. Redirect. A shadowed call returns a result naming the exact engine key. Nothing
//     executes and there is no fallback.
//
// SERVER-SIDE ONLY. The TUI plugin runtime loads plugins in a separate module realm
// in the same process: an import from there is a different instance, sharing neither
// module state nor `globalThis`. Importing this module from a plugin would typecheck,
// unit-test green, and return an empty precedence forever — `bySession` would simply
// be a different, always-empty map. Only the event bus crosses that boundary, which is
// why the inventory line is published as a TUI event rather than read directly. Anything
// on the TUI side that needs this state must cross the bus or re-derive it.
//
// Precedence is a pure function of the materialised set, so it is re-derived every
// turn from the live MCP tool map (`refresh`) rather than cached at attach. That is
// what keeps it correct when an engine's tool set changes under us — `MCP.tools()` is
// re-read each turn by `resolveTools`. A `tools/list_changed` notification invalidates
// that cache sooner, so it makes the next re-derivation see the change earlier — but the
// per-turn re-derivation is the mechanism, not the notification.
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Log } from "@/altimate/util/log"
import { Instance } from "@/project/instance"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { PermissionNext } from "@/permission/next"
import { DATAMATE_KEY } from "../datamate-transport"
import {
  attributableEngine,
  engineToolKeys,
  isEnabled,
  pinnedWorkspace,
  settledOutcome,
  type EntryLike,
  type Outcome,
} from "./engine-overlay"
import { readLocalBinding } from "./state"
import { canonicalType } from "../native/connections/registry"
import * as Registry from "../native/connections/registry"

const log = Log.create({ service: "workspace-precedence" })

/** Native tools that can be shadowed. `warehouse_list` annotates instead (it has no
 * connection argument), and `sql_optimize` is excluded — it is a pure sqlglot
 * transform with no connection to scope on. */
export type Capability = "sql_execute" | "sql_explain" | "schema_inspect"

/** The dispatcher operation each capability resolves its default target through.
 * Only `sql.execute` consults dbt; explain/inspect are registry-only. */
export const CAPABILITY_OP: Record<Capability, "sql.execute" | "sql.explain" | "schema.inspect"> = {
  sql_execute: "sql.execute",
  sql_explain: "sql.explain",
  schema_inspect: "schema.inspect",
}

/** Mechanism 2 — the engine tool name implementing each capability, per integration
 * id. Databricks names its execute tool differently from the `<id>_…` convention. */
function engineToolFor(capability: Capability, integration: string): string {
  if (capability === "sql_execute") {
    return integration === "databricks" ? "databricks_execute_sql" : `${integration}_execute_database_query`
  }
  if (capability === "sql_explain") return `${integration}_get_query_explain_plan`
  return `${integration}_get_table_stats`
}

/** Engine integration id → canonical local driver type. The id is the engine's name
 * for the integration (`postgresql`); the driver type is what local connections carry
 * (`postgres`). Only warehouse integrations appear here. */
const INTEGRATION_TYPE: Record<string, string> = {
  snowflake: "snowflake",
  bigquery: "bigquery",
  postgresql: "postgres",
  databricks: "databricks",
}

const CAPABILITIES: Capability[] = ["sql_execute", "sql_explain", "schema_inspect"]

export interface ShadowEntry {
  /** Engine tool name, without the MCP server prefix. */
  engineTool: string
  /** Model-facing key, i.e. `<server>_<engineTool>`. This is what the model calls. */
  modelKey: string
  /** Engine integration id (`postgresql`), not the driver type. */
  integration: string
}

export interface Precedence {
  workspaceName: string
  /** The bound workspace this snapshot was derived for. Re-linking mid-session is
   * supported, so a snapshot can outlive the binding that justified it. */
  workspaceId?: string
  /** false when the escape hatch is on, when nothing is bound, or when the engine
   * could not be attributed to the bound workspace. */
  enabled: boolean
  /** Why precedence is off, for the inventory line. Absent when enabled. */
  disabledReason?: "pilot-off" | "escape-hatch" | "unbound" | "unattributed" | "nothing-materialised"
  /** canonical driver type → capability → who serves it. */
  shadowed: Map<string, Map<Capability, ShadowEntry>>
  /** The caller's effective permission rules, captured when this was derived. A
   * redirect is only useful if the caller may actually call the engine tool: the
   * `analyst` agent denies everything it does not name, and it never names the
   * engine keys, so redirecting its permitted reads would take away the one thing
   * it exists to do. Absent means "unknown", which is treated as reachable. */
  ruleset?: PermissionNext.Ruleset
}

const EMPTY = (reason: Precedence["disabledReason"], workspaceName = ""): Precedence => ({
  workspaceName,
  enabled: false,
  disabledReason: reason,
  shadowed: new Map(),
})

/** Per-session precedence, refreshed once per turn by the tool resolver and read
 * (never recomputed) by tool bodies mid-turn. */
const bySession = new Map<string, Precedence>()

/** Test seam. Production leaves every field unset. */
export const precedenceInternals: {
  binding?: () => Promise<{ datamateId: number; datamateName: string } | null>
  attributedTo?: () => Promise<string | null>
  attachOutcome?: () => Promise<Outcome | undefined>
  announce?: (line: string) => Promise<void>
} = {}

/** Bound both per-session maps. A long-running `serve` process sees an unbounded
 * number of session ids, and each entry holds a merged permission ruleset, so an
 * unevicted map grows with lifetime session count. Mirrors the attach module's cap
 * and insertion-ordered eviction: dropping the oldest is safe because the next turn
 * simply re-derives. */
export const MAX_TRACKED_SESSIONS = 256

function remember(sessionID: string, value: Precedence): void {
  bySession.delete(sessionID)
  bySession.set(sessionID, value)
  while (bySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = bySession.keys().next()
    if (oldest.done) break
    bySession.delete(oldest.value)
    announced.delete(oldest.value)
    publishing.delete(oldest.value)
    publishQueue.delete(oldest.value)
  }
}

/**
 * Did an attach actually produce the engine now serving this session?
 *
 * The saved config is not enough on its own: an entry can be rewritten — by an IDE —
 * from unpinned to pinned while MCP goes on serving the process it already connected,
 * so the config would name this workspace while the running engine serves another.
 * The attach outcome is the runtime-grounded signal: `attached` means the overlay's
 * pinned engine is the one MCP connected at this turn boundary.
 *
 * Read through `settledOutcome`, which is a pure read of state already held. The
 * attach task itself must NOT be awaited here — the prompt loop caps its own wait and
 * lets a turn proceed without engine tools past the cap, so awaiting it would hang
 * every affected turn on a broken connection for the full connection timeout.
 *
 * `undefined` means "not known yet", and cannot be told apart from "never attached".
 * Both are treated as unattested: precedence stays off and the call runs locally with
 * a notice. Being wrong in that direction costs a turn's routing, which the next turn
 * repairs; being wrong the other way routes credentials into someone else's engine.
 */
async function attested(sessionID: string): Promise<boolean> {
  const outcome = precedenceInternals.attachOutcome
    ? await precedenceInternals.attachOutcome().catch(() => undefined)
    : settledOutcome(sessionID)
  if (!outcome) return false
  // The attach module owns the allowlist; a new outcome kind refuses until it is
  // named there (see SERVING in engine-types).
  return attributableEngine(outcome)
}

/** Sessions whose inventory line has already been reported. Precedence is re-derived
 * every turn, but the inventory is a once-per-session statement of what changed. */
/** The last inventory line announced per session, not merely whether one was. The
 * first turn can announce "shadowing off" — an attach that outran its bounded wait
 * looks identical to no engine — and precedence is deliberately re-derived every
 * turn, so the truth can change under a session that has already been told. Comparing
 * the line means a correction is delivered and an unchanged one stays quiet. */
/** What each session has actually been told, and whether that statement described
 * actual routing. The flag matters: "shadowing off, the engine could not be
 * attributed" is a non-empty announcement that is NOT routing, so treating any prior
 * announcement as routing would later claim routing had stopped when it never started.
 *
 * Only confirmed deliveries are written here. An optimistic record cannot live in this
 * map even briefly: two refreshes can publish different lines before either settles,
 * and rolling one back to the other's unconfirmed value would claim a delivery that
 * never happened, silencing that line for good. */
const announced = new Map<string, { line: string; routed: boolean }>()

/** The announcement currently queued or being published for a session, held separately
 * so it can never be mistaken for one that arrived. It exists only to stop a second
 * refresh from sending the same line twice; a failed attempt leaves `announced`
 * untouched, so the next turn simply tries again. */
const publishing = new Map<string, { line: string; routed: boolean }>()

/** Publications are chained per session so they arrive in the order they were decided.
 * Refreshes are serialized by the prompt loop, but publishing deliberately is not
 * awaited — a toast must never be able to stall a turn — so without a chain two lines
 * can be in flight at once and land in either order, leaving the stale one on screen
 * while the newer one is recorded as the session's state. */
const publishQueue = new Map<string, Promise<void>>()

/** Said when routing stops entirely, which `inventoryLine` renders as an empty string
 * because there is nothing left to enumerate. Silence is the wrong answer only here:
 * the session was previously told its calls were routed. */
const STOPPED_ROUTING =
  "Workspace integrations: nothing is served by the workspace any more; every connection now runs on the local drivers."

/** Publishes the line and reports whether it actually reached the session. The caller
 * needs the distinction: a line recorded as said but never delivered is never said
 * again, because every later turn sees it as unchanged. */
async function announce(line: string): Promise<boolean> {
  try {
    if (precedenceInternals.announce) await precedenceInternals.announce(line)
    else
      await AppRuntime.runPromise(
        EventV2Bridge.Service.use((events) =>
          events.publish(TuiEvent.ToastShow, {
            title: "Workspace integrations",
            message: line,
            variant: "info",
            duration: 10000,
          }),
        ),
      )
    return true
  } catch (err) {
    log.warn("could not report the workspace precedence inventory", { err: String(err) })
    return false
  }
}

/** Mechanism 6 — the escape hatch. `--integrations=local` (or the env var) turns
 * shadowing off for the whole session. */
export function escapeHatchOn(): boolean {
  return CoreFlag.ALTIMATE_INTEGRATIONS_LOCAL
}

async function currentBinding(): Promise<{ datamateId: number; datamateName: string } | null> {
  if (precedenceInternals.binding) return precedenceInternals.binding()
  try {
    const directory = Instance.directory
    if (!directory) return null
    const binding = await readLocalBinding(directory)
    return binding ? { datamateId: binding.datamateId, datamateName: binding.datamateName } : null
  } catch (err) {
    log.warn("could not read local binding", { err: String(err) })
    return null
  }
}

/**
 * Mechanism 1a — which workspace the live engine entry is actually pinned to, or null
 * when that cannot be established. A URL entry is an IDE's in-process engine: never
 * pinned, its active teammate changing at runtime, so it can never be attributed.
 */
async function attributedTo(expected: string): Promise<string | null> {
  if (precedenceInternals.attributedTo) return precedenceInternals.attributedTo()
  const read = async (): Promise<string | null> => {
    const cfg = (await Config.get()) as { mcp?: Record<string, EntryLike | undefined> }
    const entry = cfg.mcp?.[DATAMATE_KEY]
    if (!entry) return null
    // Parsed by attach's own parser, not a second copy here. It handles both entry
    // shapes (`command` as argv, or a string plus separate `args`), both flag
    // spellings, and last-wins on repeats — a private reimplementation would refuse
    // precedence on engines that are in fact correctly pinned.
    return pinnedWorkspace(entry)
  }
  try {
    const cached = await read()
    // `Config.get()` is cached per instance, and an IDE rewriting the entry writes
    // straight to disk without going through it — so a cached pin can outlive the
    // entry it describes. Staleness is only dangerous in one direction: a stale
    // "pinned to us" would help enable routing, while a stale "pinned elsewhere"
    // merely refuses, which is the safe way to be wrong. So confirm against disk only
    // when the cached answer is about to enable, and leave the refusing path cheap
    // rather than re-reading all config on every turn.
    if (cached !== expected) return cached
    await Config.invalidate().catch((err) => {
      log.warn("could not invalidate the config cache before attributing the engine", { err: String(err) })
    })
    return await read()
  } catch (err) {
    log.warn("could not read MCP config for engine attribution", { err: String(err) })
    return null
  }
}

/**
 * Re-derive precedence for a session from the live model-facing tool map. Called
 * once per turn by the tool resolver, before descriptions are assembled.
 */
export async function refresh(
  sessionID: string,
  tools: Record<string, unknown>,
  ruleset?: PermissionNext.Ruleset,
): Promise<Precedence> {
  const result = await derive(sessionID, tools)
  if (ruleset) result.ruleset = ruleset
  remember(sessionID, result)
  // Mechanism 6 — say once, per session, what is now served where. Silence is the one
  // thing this design does not allow, but repeating it every turn would be noise.
  // A session that never had routing is told nothing — there is nothing to say. But a
  // session that HAD routing and no longer does must hear about it: the empty
  // inventory is exactly the transition the user most needs, and a truthiness guard
  // alone can never announce it, so they would go on believing calls are routed while
  // they run locally.
  const current = inventoryLine(result)
  const routed = result.enabled && current !== ""
  // What this session is committed to saying: the announcement still being published if
  // there is one, otherwise the one it has actually been told. Both questions below are
  // asked of this single record. Consulting only the delivered one would suppress a
  // correction back to it while another line is in flight, and would miss that routing
  // had been announced at all when the stop arrives before that announcement lands —
  // in both cases the queue then delivers the stale line last.
  const committed = publishing.get(sessionID) ?? announced.get(sessionID)
  // Only a session that was actually routing can be told routing has stopped.
  const line = current || (committed?.routed ? STOPPED_ROUTING : "")
  if (line && committed?.line !== line) {
    // Nothing reaches `announced` until the line actually arrives, so a failure leaves
    // the session's known state untouched and the next turn retries.
    const attempt = { line, routed }
    publishing.set(sessionID, attempt)
    const queued = (publishQueue.get(sessionID) ?? Promise.resolve()).then(async () => {
      const delivered = await announce(line)
      if (publishing.get(sessionID) === attempt) publishing.delete(sessionID)
      // A session evicted while its line was in flight must not be written back:
      // eviction only ever walks `bySession`, so an entry recreated here after the
      // session left it could never be reclaimed, and the map would grow with the
      // lifetime session count rather than staying bounded.
      if (delivered && bySession.has(sessionID)) announced.set(sessionID, attempt)
    })
    publishQueue.set(sessionID, queued)
    void queued
  }
  return result
}

async function derive(sessionID: string, tools: Record<string, unknown>): Promise<Precedence> {
  // The workspace pilot is opt-in, and opting out has to mean it. A binding and a
  // pinned `datamate` entry both persist in config, and the MCP client connects that
  // entry on its own regardless of the pilot flag — so engine tools can materialise
  // for someone who has switched the pilot off. Without this gate their local
  // warehouse calls would start redirecting.
  if (!isEnabled()) return EMPTY("pilot-off")
  if (escapeHatchOn()) return EMPTY("escape-hatch")

  const binding = await currentBinding()
  if (!binding) return EMPTY("unbound")
  const workspaceName = binding.datamateName

  // Mechanism 1a — refuse to engage on an engine we cannot attribute to this binding.
  // Two signals, and both must agree. The attach outcome says the running engine is
  // one we established; the configured pin says it still names this workspace. Config
  // alone is not enough — it can be rewritten under a live connection — and the
  // outcome alone would not notice a later rewrite pointing somewhere else.
  if (!(await attested(sessionID))) {
    log.info("no attach established this session's engine; precedence off", { bound: binding.datamateId })
    return EMPTY("unattributed", workspaceName)
  }
  const pinned = await attributedTo(String(binding.datamateId))
  if (pinned === null || pinned !== String(binding.datamateId)) {
    log.info("engine not attributable to the bound workspace; precedence off", {
      bound: binding.datamateId,
      pinned: pinned ?? "(none)",
    })
    return EMPTY("unattributed", workspaceName)
  }

  // Mechanism 1 — what actually materialised, never what was declared.
  const present = engineToolKeys(tools)
  if (present.size === 0) return EMPTY("nothing-materialised", workspaceName)

  // Mechanism 2 — capability by capability, only where the key is really there.
  const shadowed = new Map<string, Map<Capability, ShadowEntry>>()
  for (const [integration, type] of Object.entries(INTEGRATION_TYPE)) {
    for (const capability of CAPABILITIES) {
      const engineTool = engineToolFor(capability, integration)
      if (!present.has(engineTool)) continue
      let forType = shadowed.get(type)
      if (!forType) {
        forType = new Map()
        shadowed.set(type, forType)
      }
      forType.set(capability, {
        engineTool,
        modelKey: `${DATAMATE_KEY}_${engineTool}`,
        integration,
      })
    }
  }
  if (shadowed.size === 0) return EMPTY("nothing-materialised", workspaceName)
  return { workspaceName, workspaceId: String(binding.datamateId), enabled: true, shadowed }
}

/** Read the session's precedence without recomputing it. */
export function forSession(sessionID: string): Precedence | undefined {
  return bySession.get(sessionID)
}

/** Test-visible size of the per-session cache. */
export function trackedSessionCount(): number {
  return bySession.size
}

/** Test-visible size of the announcement cache, which is bounded by the same eviction
 * and so must never outgrow it. */
export function announcedSessionCount(): number {
  return announced.size
}

export function resetForTests(): void {
  bySession.clear()
  announced.clear()
  publishing.clear()
  publishQueue.clear()
  delete precedenceInternals.announce
  delete precedenceInternals.binding
  delete precedenceInternals.attributedTo
}

export interface RedirectResult {
  title: string
  metadata: Record<string, unknown>
  output: string
}

/** What a tool body should do about a call. */
export interface Verdict {
  /** Present when the call is shadowed: return this instead of executing. */
  redirect?: RedirectResult
  /** Present when the call runs but the user must be told why it was not routed. */
  notice?: string
  /** Stamped onto the executed result's metadata so telemetry can count these. */
  precedence?: "undetermined" | "pending"
}

const RUN: Verdict = {}

/** Can the caller actually call this engine tool? An agent that denies what it does
 * not name (the `analyst` default) can be permitted the native tool and forbidden its
 * engine counterpart, and a redirect it cannot follow is a dead end. */
function reachable(precedence: Precedence, modelKey: string): boolean {
  if (!precedence.ruleset) return true
  return PermissionNext.evaluate(modelKey, "*", precedence.ruleset).action !== "deny"
}

/**
 * The capabilities this caller will really have routed for a given type — the ones
 * that materialised AND whose destination the caller may call. Everything user-facing
 * reports through this, so a listing can never claim a routing that will not happen:
 * an `analyst` is told its reads stay local, because they do.
 */
function servedFor(precedence: Precedence, type: string): Capability[] {
  const byCapability = precedence.shadowed.get(type)
  if (!byCapability) return []
  return CAPABILITIES.filter((c) => {
    const entry = byCapability.get(c)
    return !!entry && reachable(precedence, entry.modelKey)
  })
}

function unreachable(workspaceName: string, modelKey: string): Verdict {
  return {
    notice:
      `Not routed through workspace "${workspaceName}": this agent is not permitted to call ` +
      `\`${modelKey}\`, so the call ran on the local connection instead.`,
    precedence: "undetermined",
  }
}

function redirectFor(
  capability: Capability,
  entry: ShadowEntry,
  workspaceName: string,
  connection: string,
  /** Set when the call was routed because the *fallback* target is served, not the
   * target it would have tried first. The dbt attempt might well have succeeded, so
   * the message has to say why this was refused and how to insist. */
  viaDbtFallback = false,
): Verdict {
  return {
    redirect: {
      title: `Routed to workspace ${workspaceName}`,
      metadata: {
        // Machine-readable marker: `Tool.wrap` reports every returning body as a
        // successful call, so without this a redirect is indistinguishable from a
        // real execution in telemetry.
        redirected: true,
        redirect_to: entry.modelKey,
        precedence: "shadowed",
        workspace: workspaceName,
        capability,
        connection,
        ...(viaDbtFallback ? { via: "dbt-fallback" } : {}),
      },
      output: viaDbtFallback
        ? `Not run locally. This call names no warehouse, so it resolves through the dbt project — and if dbt ` +
          `returns nothing it falls back to the local connection \`${connection}\`, which workspace ` +
          `"${workspaceName}" serves through its integration engine. Whether it lands on dbt or on that ` +
          `connection is only known once it runs, so it is not run.\n\n` +
          `Call \`${entry.modelKey}\` instead. If you meant the dbt path specifically, either name the ` +
          `warehouse you want (\`warehouse=${connection}\` routes to the engine; any unserved connection runs ` +
          `locally), or restart with \`--integrations=local\` to keep every connection on the local drivers.`
        : `Not run locally. Workspace "${workspaceName}" serves ${entry.integration} through its integration engine, ` +
          `so this connection is served by \`${entry.modelKey}\`.\n\n` +
          `Call \`${entry.modelKey}\` instead. ` +
          `To use the local connection for this session, restart with \`--integrations=local\`.`,
    },
  }
}

/**
 * Mechanism 4 — the single decision a tool body asks for. Returns an empty verdict
 * when the call should proceed normally.
 *
 * `warehouse` undefined means "this tool's default target", which is resolved the way
 * the handler itself would resolve it (see `resolveDefaultTarget`).
 */
export async function check(sessionID: string, capability: Capability, warehouse?: string): Promise<Verdict> {
  const precedence = bySession.get(sessionID)
  if (!precedence) {
    // No snapshot for this session. The resolver derives one every turn, so this is
    // either a caller that never resolved tools or an entry evicted between tool
    // resolution and this call. Either way the decision is unknown, and unknown runs
    // locally *and says so* rather than silently — a silent run is indistinguishable
    // from a considered "not served".
    return {
      notice: "Not routed through the bound workspace: no routing decision was available for this call.",
      precedence: "undetermined",
    }
  }
  if (!precedence.enabled) return RUN

  // Re-linking mid-session is supported, so this snapshot can name a workspace the
  // project has since left — and a redirect naming it would send the call to that
  // workspace's engine, with its credentials. The binding is a local cache read, and
  // this only runs on the path that is about to redirect.
  if (precedence.workspaceId && (await currentBinding())?.datamateId !== Number(precedence.workspaceId)) {
    return {
      notice:
        `Not routed through workspace "${precedence.workspaceName}": the project was re-linked while ` +
        `this call was in flight, so the routing decision no longer applies.`,
      precedence: "undetermined",
    }
  }

  if (warehouse) {
    const type = canonicalType(Registry.getConfig(warehouse)?.type)
    if (!type) return RUN
    const entry = precedence.shadowed.get(type)?.get(capability)
    if (!entry) return RUN
    if (!reachable(precedence, entry.modelKey)) return unreachable(precedence.workspaceName, entry.modelKey)
    return redirectFor(capability, entry, precedence.workspaceName, warehouse)
  }

  // No warehouse named: resolve the default the way this operation's handler does.
  // Imported lazily — `register.ts` imports the tool layer, so a static import here
  // would close a cycle.
  const { resolveDefaultTarget } = await import("../native/connections/register")
  const target = await resolveDefaultTarget(CAPABILITY_OP[capability])
  return decideForTarget(precedence, capability, target)
}

/**
 * Decide a no-`warehouse` call from the target it would actually reach. Pure, and
 * exported for its own tests: the ORDER of these branches is the property that has
 * broken repeatedly, and it is only checkable in isolation — reaching a dbt-sourced
 * target through `check()` needs a real dbt project.
 *
 * Order matters and is deliberate:
 *   1. the target's own type is served      → redirect
 *   2. the fallback behind it is served     → redirect (see below)
 *   3. the type could not be determined     → run locally, non-silently
 *   4. otherwise                            → run
 *
 * Step 2 must precede step 3. `sql.execute` falls back to the first registry
 * connection whenever the dbt attempt yields nothing — an unrecognised result shape
 * or a throw, not only an absent project. An undetermined dbt type is *more* likely
 * to be the broken setup that yields nothing, so returning "undetermined" before
 * looking at the fallback fails open into exactly the local execution against a
 * served connection that this design exists to prevent.
 */
export function decideForTarget(
  precedence: Precedence,
  capability: Capability,
  target: {
    source: "dbt" | "registry" | "none"
    type?: string
    name?: string
    fallback?: { type: string; name: string }
  },
): Verdict {
  if (target.source === "none") return RUN

  const type = canonicalType(target.type)
  const entry = type ? precedence.shadowed.get(type)?.get(capability) : undefined
  if (entry) {
    if (!reachable(precedence, entry.modelKey)) return unreachable(precedence.workspaceName, entry.modelKey)
    const connection =
      target.source === "registry" ? (target.name ?? "the default connection") : "the dbt profile's target"
    return redirectFor(capability, entry, precedence.workspaceName, connection)
  }

  // Reached whether or not the dbt type resolved — see the ordering note above.
  if (target.source === "dbt" && target.fallback) {
    const fallbackType = canonicalType(target.fallback.type)
    const fallbackEntry = fallbackType ? precedence.shadowed.get(fallbackType)?.get(capability) : undefined
    if (fallbackEntry) {
      if (!reachable(precedence, fallbackEntry.modelKey)) {
        return unreachable(precedence.workspaceName, fallbackEntry.modelKey)
      }
      return redirectFor(capability, fallbackEntry, precedence.workspaceName, target.fallback.name, true)
    }
  }

  if (!type) {
    // Decided for v1: FAIL OPEN, non-silent. The call runs on the user's own local
    // credential — exactly today's behaviour — and says why it was not routed.
    return {
      notice:
        `Not routed through workspace "${precedence.workspaceName}": ` +
        `the default target's type could not be determined.`,
      precedence: "undetermined",
    }
  }
  return RUN
}

/**
 * Attach a fail-open notice to an executed result. No-op for the common case, so
 * every tool body can call it unconditionally on its way out.
 */
export function annotate<T extends { metadata?: Record<string, unknown>; output?: string }>(
  verdict: Verdict,
  result: T,
): T {
  if (!verdict.notice) return result
  return {
    ...result,
    metadata: { ...result.metadata, precedence: verdict.precedence ?? "undetermined" },
    output: `${verdict.notice}\n\n${result.output ?? ""}`,
  }
}

/**
 * Mechanism 5 — tool descriptions. Both tool resolvers call these so the two cannot
 * describe the same tool differently.
 */
export function describeNativeTool(toolID: string, base: string, precedence?: Precedence): string {
  if (!precedence?.enabled) return base
  const isCapability = (CAPABILITIES as string[]).includes(toolID)
  if (!isCapability && toolID !== "warehouse_list") return base
  // Claim redirection for THIS tool only if this tool's own capability is served
  // somewhere. An integration that provides execute alone — bigquery, postgresql,
  // databricks — leaves explain and inspect running locally, so telling those tools
  // they redirect would steer the model away from the local tool that does work.
  // `warehouse_list` describes the listing as a whole, so any served capability
  // justifies its note.
  const claims = isCapability
    ? [...precedence.shadowed.keys()].some((t) => servedFor(precedence, t).includes(toolID as Capability))
    : [...precedence.shadowed.keys()].some((t) => servedFor(precedence, t).length > 0)
  if (!claims) return base
  return (
    `${base} Serves local connections; types served by workspace "${precedence.workspaceName}" ` +
    `redirect to that workspace's integration tools.`
  )
}

export function describeEngineTool(modelKey: string, base: string, precedence?: Precedence): string {
  if (!precedence?.enabled) return base
  for (const byCapability of precedence.shadowed.values()) {
    for (const entry of byCapability.values()) {
      if (entry.modelKey === modelKey) return `${base} (workspace ${precedence.workspaceName})`
    }
  }
  return base
}

/** Mechanism 6 — the inventory line reported once the attach settles. */
export function inventoryLine(precedence: Precedence): string {
  if (!precedence.enabled) {
    switch (precedence.disabledReason) {
      case "pilot-off":
        return ""
      case "escape-hatch":
        return "Workspace integrations: shadowing off (--integrations=local); local connections serve every warehouse."
      case "unattributed":
        return (
          `Workspace integrations: shadowing off — the running engine could not be attributed to workspace ` +
          `"${precedence.workspaceName}". Local connections serve every warehouse.`
        )
      default:
        return ""
    }
  }
  const parts: string[] = []
  const short = (c: Capability) => c.replace(/^(sql|schema)_/, "")
  for (const type of precedence.shadowed.keys()) {
    const servedCaps = servedFor(precedence, type)
    if (servedCaps.length === 0) continue
    const local = CAPABILITIES.filter((c) => !servedCaps.includes(c)).map(short)
    parts.push(
      `${type}: ${servedCaps.map(short).join("/")} via workspace ${precedence.workspaceName}` +
        (local.length ? `, ${local.join("/")} stay local` : ""),
    )
  }
  if (parts.length === 0) return ""
  const shadowedCount = countShadowedConnections(precedence)
  return `Workspace integrations — ${parts.join("; ")}. ${shadowedCount} local connection${shadowedCount === 1 ? "" : "s"} shadowed.`
}

function countShadowedConnections(precedence: Precedence): number {
  try {
    return Registry.list().warehouses.filter((w) => {
      const type = canonicalType(w.type)
      return !!type && servedFor(precedence, type).length > 0
    }).length
  } catch {
    return 0
  }
}

/** Per-capability note for a `warehouse_list` row, or null when the row is untouched. */
export function warehouseListNote(precedence: Precedence | undefined, warehouseType: string): string | null {
  if (!precedence?.enabled) return null
  const type = canonicalType(warehouseType)
  if (!type) return null
  const servedCaps = servedFor(precedence, type)
  if (servedCaps.length === 0) return null
  const short = (c: Capability) => c.replace(/^(sql|schema)_/, "")
  const served = servedCaps.map(short)
  const local = CAPABILITIES.filter((c) => !servedCaps.includes(c)).map(short)
  return (
    `${served.join("/")} via workspace ${precedence.workspaceName}` + (local.length ? `; ${local.join("/")} local` : "")
  )
}

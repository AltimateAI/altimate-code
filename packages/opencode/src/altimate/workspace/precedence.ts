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
// cache-invalidated by the `tools/list_changed` notification, and `resolveTools` runs
// once per turn.
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Log } from "@/altimate/util/log"
import { Instance } from "@/project/instance"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { DATAMATE_KEY } from "../datamate-transport"
import { engineToolKeys, isEnabled, pinnedWorkspace, type ExistingEntry } from "./engine-sync"
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
  /** false when the escape hatch is on, when nothing is bound, or when the engine
   * could not be attributed to the bound workspace. */
  enabled: boolean
  /** Why precedence is off, for the inventory line. Absent when enabled. */
  disabledReason?: "pilot-off" | "escape-hatch" | "unbound" | "unattributed" | "nothing-materialised"
  /** canonical driver type → capability → who serves it. */
  shadowed: Map<string, Map<Capability, ShadowEntry>>
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
  announce?: (line: string) => Promise<void>
} = {}

/** Sessions whose inventory line has already been reported. Precedence is re-derived
 * every turn, but the inventory is a once-per-session statement of what changed. */
const announced = new Set<string>()

async function announce(line: string): Promise<void> {
  if (precedenceInternals.announce) return precedenceInternals.announce(line)
  try {
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
  } catch (err) {
    log.warn("could not report the workspace precedence inventory", { err: String(err) })
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
async function attributedTo(): Promise<string | null> {
  if (precedenceInternals.attributedTo) return precedenceInternals.attributedTo()
  try {
    const cfg = (await Config.get()) as { mcp?: Record<string, ExistingEntry | undefined> }
    const entry = cfg.mcp?.[DATAMATE_KEY]
    if (!entry) return null
    // Parsed by attach's own parser, not a second copy here. It handles both entry
    // shapes (`command` as argv, or a string plus separate `args`), both flag
    // spellings, and last-wins on repeats — a private reimplementation would refuse
    // precedence on engines that are in fact correctly pinned.
    return pinnedWorkspace(entry)
  } catch (err) {
    log.warn("could not read MCP config for engine attribution", { err: String(err) })
    return null
  }
}

/**
 * Re-derive precedence for a session from the live model-facing tool map. Called
 * once per turn by the tool resolver, before descriptions are assembled.
 */
export async function refresh(sessionID: string, tools: Record<string, unknown>): Promise<Precedence> {
  const result = await derive(tools)
  bySession.set(sessionID, result)
  // Mechanism 6 — say once, per session, what is now served where. Silence is the one
  // thing this design does not allow, but repeating it every turn would be noise.
  if (!announced.has(sessionID)) {
    const line = inventoryLine(result)
    if (line) {
      announced.add(sessionID)
      void announce(line).catch(() => {})
    }
  }
  return result
}

async function derive(tools: Record<string, unknown>): Promise<Precedence> {
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
  const pinned = await attributedTo()
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
  return { workspaceName, enabled: true, shadowed }
}

/** Read the session's precedence without recomputing it. */
export function forSession(sessionID: string): Precedence | undefined {
  return bySession.get(sessionID)
}

export function resetForTests(): void {
  bySession.clear()
  announced.clear()
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
  if (!precedence || !precedence.enabled) return RUN

  if (warehouse) {
    const type = canonicalType(Registry.getConfig(warehouse)?.type)
    if (!type) return RUN
    const entry = precedence.shadowed.get(type)?.get(capability)
    return entry ? redirectFor(capability, entry, precedence.workspaceName, warehouse) : RUN
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
  target: { source: "dbt" | "registry" | "none"; type?: string; name?: string; fallback?: { type: string; name: string } },
): Verdict {
  if (target.source === "none") return RUN

  const type = canonicalType(target.type)
  const entry = type ? precedence.shadowed.get(type)?.get(capability) : undefined
  if (entry) {
    const connection = target.source === "registry" ? (target.name ?? "the default connection") : "the dbt profile's target"
    return redirectFor(capability, entry, precedence.workspaceName, connection)
  }

  // Reached whether or not the dbt type resolved — see the ordering note above.
  if (target.source === "dbt" && target.fallback) {
    const fallbackType = canonicalType(target.fallback.type)
    const fallbackEntry = fallbackType ? precedence.shadowed.get(fallbackType)?.get(capability) : undefined
    if (fallbackEntry) {
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
  const shadowed = (CAPABILITIES as string[]).includes(toolID) || toolID === "warehouse_list"
  if (!shadowed) return base
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
  for (const [type, byCapability] of precedence.shadowed) {
    const served = CAPABILITIES.filter((c) => byCapability.has(c)).map((c) => c.replace(/^(sql|schema)_/, ""))
    const local = CAPABILITIES.filter((c) => !byCapability.has(c)).map((c) => c.replace(/^(sql|schema)_/, ""))
    parts.push(
      `${type}: ${served.join("/")} via workspace ${precedence.workspaceName}` +
        (local.length ? `, ${local.join("/")} stay local` : ""),
    )
  }
  const shadowedCount = countShadowedConnections(precedence)
  return `Workspace integrations — ${parts.join("; ")}. ${shadowedCount} local connection${shadowedCount === 1 ? "" : "s"} shadowed.`
}

function countShadowedConnections(precedence: Precedence): number {
  try {
    return Registry.list().warehouses.filter((w) => {
      const type = canonicalType(w.type)
      return !!type && precedence.shadowed.has(type)
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
  const byCapability = precedence.shadowed.get(type)
  if (!byCapability) return null
  const served = CAPABILITIES.filter((c) => byCapability.has(c)).map((c) => c.replace(/^(sql|schema)_/, ""))
  const local = CAPABILITIES.filter((c) => !byCapability.has(c)).map((c) => c.replace(/^(sql|schema)_/, ""))
  return (
    `${served.join("/")} via workspace ${precedence.workspaceName}` + (local.length ? `; ${local.join("/")} local` : "")
  )
}

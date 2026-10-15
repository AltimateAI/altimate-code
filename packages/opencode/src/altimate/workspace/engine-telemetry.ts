// altimate_change - new file
//
// Telemetry for the workspace engine, per the shared event contract: one name per fact, fired
// on the outcome rather than the attempt, the workspace id on the row where the code has it
// (every row of a bound session also carries it from the telemetry context). Each builder is
// pure so it can be pinned by tests; each `track*` wrapper never throws into its caller.
import { Telemetry } from "@/altimate/telemetry"
import type { Outcome } from "./engine-types"
import type { EngineOffer } from "./engine-offer"
import type { Precedence } from "./precedence"

export type AttachOutcome = "attached" | "engine_missing" | "engine_too_old" | "connect_failed" | "disabled" | "unbound"
export type InstallPromptAction = "shown" | "accepted" | "installed" | "install_failed" | "copied" | "declined"
export type InstallPromptSurface = "headless" | "dialog" | "bus" | "toast"
export type EngineStage = "attach" | "install" | "precedence"

const sessionId = () => Telemetry.getContext().sessionId

function outcomeName(kind: Outcome["kind"]): AttachOutcome {
  return kind.replace(/-/g, "_") as AttachOutcome
}

/** The class of a connect failure, from the fixed messages the overlay produces. */
export function connectErrorClass(error: string): "link_unreadable" | "probe_failed" | "not_connected" | "other" {
  const e = error.toLowerCase()
  if (e.includes("link could not be read")) return "link_unreadable"
  if (e.includes("could not be checked")) return "probe_failed"
  if (e.includes("not connected") || e.includes("did not connect") || e.includes("handshake")) return "not_connected"
  return "other"
}

/** What makes two settled outcomes the same attach for telemetry: the kind and its counts. */
export function attachSignature(outcome: Outcome): string {
  switch (outcome.kind) {
    case "attached":
      return `attached:${outcome.available}:${outcome.declared ?? ""}:${outcome.missing?.length ?? ""}:${outcome.extensions?.length ?? 0}`
    case "engine-missing":
      return `engine-missing:${outcome.declared ?? ""}`
    case "engine-too-old":
      return `engine-too-old:${outcome.found ?? ""}`
    case "connect-failed":
      return `connect-failed:${connectErrorClass(outcome.error)}`
    default:
      return outcome.kind
  }
}

export function attachEvent(
  outcome: Outcome,
  extra: { engineVersion?: string | null; workspaceId?: number } = {},
  sessionID?: string,
): Telemetry.Event {
  // The boundary's own workspace, named on the row rather than left to the process context; an
  // unbound or disabled outcome has none.
  const settledFor = outcome.kind !== "unbound" && outcome.kind !== "disabled" ? extra.workspaceId : undefined
  const base = {
    type: "workspace_engine_attach" as const,
    timestamp: Date.now(),
    session_id: sessionID ?? sessionId(),
    ...(settledFor !== undefined && Number.isInteger(settledFor) && settledFor > 0 ? { workspace_id: settledFor } : {}),
  }
  switch (outcome.kind) {
    case "attached":
      return {
        ...base,
        outcome: "attached",
        available: outcome.available,
        ...(outcome.declared !== undefined ? { declared: outcome.declared } : {}),
        ...(outcome.missing !== undefined ? { missing: outcome.missing.length } : {}),
        ...(outcome.extensions?.length ? { extensions: outcome.extensions.length } : {}),
        ...(extra.engineVersion ? { engine_version: extra.engineVersion } : {}),
      }
    case "engine-missing":
      return {
        ...base,
        outcome: "engine_missing",
        ...(outcome.declared !== undefined ? { declared: outcome.declared } : {}),
      }
    case "engine-too-old":
      return { ...base, outcome: "engine_too_old", ...(outcome.found ? { found_version: outcome.found } : {}) }
    case "connect-failed":
      return { ...base, outcome: "connect_failed", error_class: connectErrorClass(outcome.error) }
    default:
      return { ...base, outcome: outcomeName(outcome.kind) }
  }
}

/** Track the attach when the session's outcome changed (not on every turn boundary). */
/** What an attach row is deduped on: the directory's workspace identity (the credential scope plus the
 * tenant-local id, as the overlay keys it, so the same id under another account is another workspace)
 * and the outcome's signature; the same-shaped attach to another workspace after a relink is a change. */
export function attachKey(outcome: Outcome, workspaceIdentity?: string): string {
  return `${workspaceIdentity ?? ""}|${attachSignature(outcome)}`
}

/** Track a session's attach when its key differs from the last one reported for the session. */
export function trackAttach(
  outcome: Outcome,
  previousKey: string | undefined,
  extra: { engineVersion?: string | null; workspaceId?: number; workspaceIdentity?: string } = {},
  sessionID?: string,
): boolean {
  try {
    const identity =
      extra.workspaceIdentity ?? (extra.workspaceId !== undefined ? String(extra.workspaceId) : undefined)
    if (previousKey !== undefined && previousKey === attachKey(outcome, identity)) return false
    Telemetry.track(attachEvent(outcome, extra, sessionID))
    return true
  } catch {
    return false
  }
}

export function installPromptEvent(
  action: InstallPromptAction,
  offer: Pick<EngineOffer, "reason" | "workspaceId" | "declared" | "found">,
  opts: { surface?: InstallPromptSurface; nodeMajor?: number | null } = {},
  sessionID?: string,
): Telemetry.Event {
  const id = Number(offer.workspaceId)
  return {
    type: "workspace_engine_install_prompt",
    timestamp: Date.now(),
    session_id: sessionID ?? sessionId(),
    action,
    reason: offer.reason,
    ...(Number.isInteger(id) && id > 0 ? { workspace_id: id } : {}),
    ...(offer.declared !== undefined ? { declared: offer.declared } : {}),
    ...(offer.found ? { found_version: offer.found } : {}),
    ...(opts.surface ? { surface: opts.surface } : {}),
    ...(opts.nodeMajor !== undefined ? { node_detected: opts.nodeMajor !== null } : {}),
    ...(typeof opts.nodeMajor === "number" ? { node_major: opts.nodeMajor } : {}),
  }
}

export function trackInstallPrompt(
  action: InstallPromptAction,
  offer: Pick<EngineOffer, "reason" | "workspaceId" | "declared" | "found">,
  opts: { surface?: InstallPromptSurface; nodeMajor?: number | null } = {},
  sessionID?: string,
): void {
  try {
    Telemetry.track(installPromptEvent(action, offer, opts, sessionID))
  } catch {
    // never block the offer
  }
}

export function precedenceSignature(
  p: Pick<Precedence, "enabled" | "disabledReason" | "shadowed" | "extensions" | "workspaceId">,
): string {
  const shadowed = [...p.shadowed.entries()]
    .map(([type, caps]) => `${type}=${caps.size}`)
    .sort()
    .join(",")
  return `${p.workspaceId ?? ""}|${p.enabled}|${p.disabledReason ?? ""}|${shadowed}|${p.extensions?.length ?? 0}`
}

export function precedenceEvent(
  p: Pick<Precedence, "enabled" | "disabledReason" | "shadowed" | "extensions" | "workspaceId">,
  opts: { escapeHatch: boolean; connections: number; types: number; sessionID?: string; workspaceId?: number },
): Telemetry.Event {
  // The snapshot's own workspace, else the directory's linked one passed by refresh(): a disabled
  // snapshot (escape hatch, unattributed) names no workspace itself, and the row must not be left
  // to the process context.
  const own = Number(p.workspaceId)
  const id = Number.isInteger(own) && own > 0 ? own : opts.workspaceId
  return {
    type: "workspace_engine_precedence",
    timestamp: Date.now(),
    session_id: opts.sessionID ?? sessionId(),
    enabled: p.enabled,
    ...(p.disabledReason ? { reason: p.disabledReason } : {}),
    // Types the session can route through the engine (the inventory line's count), not every
    // materialised type: a session whose rules deny the engine keys shadows nothing.
    shadowed_types: opts.types,
    shadowed_connections: opts.connections,
    extensions: p.extensions?.length ?? 0,
    escape_hatch: opts.escapeHatch,
    ...(id !== undefined && Number.isInteger(id) && id > 0 ? { workspace_id: id } : {}),
  }
}

const precedenceSeen = new Map<string, string>()
/** Sessions remembered for the dedupe; the oldest is forgotten past this, and reports again on its next refresh. */
const MAX_SEEN_SESSIONS = 256

/** Track a session's precedence snapshot when it changed since the last refresh. */
export function trackPrecedence(
  sessionID: string,
  p: Pick<Precedence, "enabled" | "disabledReason" | "shadowed" | "extensions" | "workspaceId">,
  opts: { escapeHatch: boolean; connections: number; types: number; identity?: string; workspaceId?: number },
): boolean {
  try {
    // The local connections shadowed and the escape hatch are part of what is reported, so a change
    // in either re-reports the same snapshot; the account-scoped identity (credential scope plus
    // id) tells the same id under another account apart.
    const signature = `${precedenceSignature(p)}|c=${opts.connections}|t=${opts.types}|e=${opts.escapeHatch}|w=${opts.identity ?? ""}`
    if (precedenceSeen.get(sessionID) === signature) return false
    precedenceSeen.set(sessionID, signature)
    if (precedenceSeen.size > MAX_SEEN_SESSIONS) precedenceSeen.delete(precedenceSeen.keys().next().value!)
    Telemetry.track(precedenceEvent(p, { ...opts, sessionID }))
    return true
  } catch {
    return false
  }
}

export function resetEngineTelemetryForTests(): void {
  precedenceSeen.clear()
}

export function trackEngineError(stage: EngineStage, message: string, sessionID?: string): void {
  try {
    Telemetry.track({
      type: "workspace_engine_error",
      timestamp: Date.now(),
      session_id: sessionID ?? sessionId(),
      stage,
      message: Telemetry.maskString(message).slice(0, 200),
    })
  } catch {
    // never surface
  }
}

/** A datamate tool call refused because the engine is off for that workspace. */
export function trackRedirect(tool: string, operation: string, workspaceId: number, sessionID?: string): void {
  try {
    Telemetry.track({
      type: "workspace_engine_redirect",
      timestamp: Date.now(),
      session_id: sessionID ?? sessionId(),
      tool,
      operation,
      outcome: "refused",
      ...(Number.isInteger(workspaceId) && workspaceId > 0 ? { workspace_id: workspaceId } : {}),
    })
  } catch {
    // never surface
  }
}

// altimate_change - new file
//
// The install offer for a workspace whose engine is missing or too old.
//
// State-free on purpose: the TUI plugin runs in its own module realm and
// receives the offer as a bare command over the event bus, so it re-derives
// the detail here from disk and PATH rather than from the overlay's memory.
// Offer, never install on the flow's own account — `installEngine` only ever
// runs from an explicit "Install now".
import { execFile } from "node:child_process"
import { Process } from "@/util/process"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { readLocalBinding } from "./state"
import { isHeadless, log, syncInternals } from "./engine-seams"
import { declaredBounded, notify, printLine, versionOf, which } from "./engine-probes"
import { ENGINE_BINARY, ENGINE_PACKAGE, MIN_ENGINE_VERSION, clearsFloor, type Toast } from "./engine-types"

/** Node major the npm install path needs. The CLI itself is a self-contained
 * binary and does not need Node — only this install route does. */
export const MIN_NODE_MAJOR = 20
/** How long "Install now" waits for npm before giving up. */
export const INSTALL_TIMEOUT_MS = 300_000
/** Command the TUI plugin registers to raise the install offer. The offer
 * crosses to the TUI over the same event bus toasts use; it cannot cross
 * in-process, because the plugin runtime loads plugins in a separate realm.
 * `CommandExecute` carries no payload, so the plugin re-derives the offer
 * with `describeOffer()`. */
export const OFFER_COMMAND = "altimate.workspace.engineInstallOffer"
/** How long "Not now" silences the offer for a workspace. The TUI latch and
 * the per-session announce dedupe both key on this, so a session that
 * outlives the latch sees the offer again instead of waiting for a new one. */
export const OFFER_SKIP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A "no usable engine" state, described well enough for an interactive
 * surface to act on it without re-deriving anything. */
export type EngineOffer = {
  reason: "engine-missing" | "engine-too-old"
  /** Stable id — the 7-day "Not now" latch keys on this, not the name. */
  workspaceId: string
  workspaceName: string
  /** Declared, CLI-servable integration tools that are unavailable without it. */
  declared: number
  /** Version found — only set for "engine-too-old". */
  found?: string
  /** The exact install/update command. */
  command: string
}

/** Interactive surface for the offer, in the same realm. Returns true when it
 * took ownership. Deliberately synchronous: it claims the offer and renders
 * out-of-band rather than making the turn boundary wait for a person. */
export type OfferHandler = (offer: EngineOffer) => boolean

export type InstallResult = { ok: true } | { ok: false; error: string }

/** npm spec to install. ALTIMATE_ENGINE_INSTALL_SPEC overrides it so E2E can
 * point the real install path at a local tarball instead of the registry. */
export function installSpec(): string {
  return process.env["ALTIMATE_ENGINE_INSTALL_SPEC"] || `${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`
}

/** The command shown, copied, printed, and run — always the same string, so
 * "Copy command" hands over exactly what "Install now" would have executed. */
export function installCommand(): string {
  return `npm i -g ${installSpec()}`
}

/** Re-derive the current "no usable engine" state for a directory, from the
 * binding on disk and the engine on PATH. Null when there is nothing to offer:
 * unbound, or an engine that clears the floor. */
export async function describeOffer(directory: string): Promise<EngineOffer | null> {
  const binding = syncInternals.resolveBinding
    ? await syncInternals.resolveBinding(directory)
    : await readLocalBinding(directory).catch(() => null)
  if (!binding) return null
  const workspaceId = String(binding.datamateId)
  const bin = which(ENGINE_BINARY)
  const found = bin ? await versionOf(bin) : null
  if (bin && clearsFloor(found)) return null
  const declared = (await declaredBounded(workspaceId))?.keys.length ?? 0
  return {
    reason: bin ? "engine-too-old" : "engine-missing",
    workspaceId,
    workspaceName: binding.datamateName,
    declared,
    ...(bin ? { found: found ?? "unknown" } : {}),
    command: installCommand(),
  }
}

/** Node major on PATH, or null when Node is absent. Gates "Install now": with
 * no Node there is nothing to run npm with, so the offer shows the command. */
export function nodeMajor(): Promise<number | null> {
  if (syncInternals.nodeMajor) return syncInternals.nodeMajor()
  const bin = which("node")
  if (!bin) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const major = Number.parseInt(stdout.trim().replace(/^v/, "").split(".")[0] ?? "", 10)
      resolve(Number.isFinite(major) ? major : null)
    })
  })
}

/** Whether npm can be invoked at all. Node and npm are separate packages on
 * several Linux distributions, so Node 20+ does not imply `npm i -g` runs. */
export function npmAvailable(): boolean {
  if (syncInternals.npmAvailable) return syncInternals.npmAvailable()
  return which(process.platform === "win32" ? "npm.cmd" : "npm") !== null
}

/** Run the global install. Only ever reached from an explicit user choice.
 *
 * `npm.cmd` on Windows: a normal Node install exposes npm as a command shim,
 * and nothing here spawns a shell. The deadline comes from an abort signal:
 * `Process.spawn` consults `timeout` only inside its abort handler. A zero
 * exit is not a usable engine — npm's global bin directory need not be on
 * PATH — so the same discovery the turn boundary does runs before success. */
export async function installEngine(): Promise<InstallResult> {
  const spec = installSpec()
  if (syncInternals.install) return syncInternals.install(spec)
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const deadline = AbortSignal.timeout(INSTALL_TIMEOUT_MS)
  try {
    const result = await Process.run([npm, "i", "-g", spec], { abort: deadline, nothrow: true })
    if (result.code === 0) {
      const installedBin = which(ENGINE_BINARY)
      if (!installedBin) {
        return {
          ok: false,
          error: `npm installed it, but ${ENGINE_BINARY} is not on PATH — add your npm global bin directory to PATH`,
        }
      }
      const installedVersion = await versionOf(installedBin)
      if (!clearsFloor(installedVersion)) {
        return {
          ok: false,
          error: `npm installed it, but ${ENGINE_BINARY} on PATH reports ${installedVersion ?? "no version"}`,
        }
      }
      return { ok: true }
    }
    if (deadline.aborted) {
      return { ok: false, error: `npm did not finish within ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes` }
    }
    const detail = result.stderr.toString().trim().split(/\r?\n/).slice(-3).join(" ")
    return { ok: false, error: detail || `npm exited with code ${result.code}` }
  } catch (err) {
    if (deadline.aborted) {
      return { ok: false, error: `npm did not finish within ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes` }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Ask the TUI to raise the offer. False when the bus is unavailable. */
async function publishOffer(): Promise<boolean> {
  if (syncInternals.publishOffer) return syncInternals.publishOffer()
  try {
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) => events.publish(TuiEvent.CommandExecute, { command: OFFER_COMMAND })),
    )
    return true
  } catch (err) {
    log.warn("could not publish the engine install offer", { err: String(err) })
    return false
  }
}

/** Hand the offer to a same-realm surface. False when none is registered. */
function offerInstall(offer: EngineOffer): boolean {
  const handler = syncInternals.offer
  if (!handler) return false
  try {
    return handler(offer)
  } catch (err) {
    log.warn("install offer surface failed; falling back to toast", { err: String(err) })
    return false
  }
}

/** One printed line for headless `run`. */
export function describeOfferLine(offer: EngineOffer): string {
  const tools = `${offer.declared} integration tool${offer.declared === 1 ? "" : "s"}`
  return offer.reason === "engine-too-old"
    ? `Workspace "${offer.workspaceName}": ${tools} need ${ENGINE_BINARY} ${MIN_ENGINE_VERSION}+ (found ${offer.found ?? "unknown"}). Update with: ${offer.command}`
    : `Workspace "${offer.workspaceName}": ${tools} need the local engine, which is not installed. Install it with: ${offer.command}`
}

/** Offer via the dialog surface when there is one; otherwise print (headless)
 * or toast (bus unavailable). Exactly one of these happens. */
export async function offerOrNotify(offer: EngineOffer, toast: Toast): Promise<void> {
  if (isHeadless()) {
    printLine(describeOfferLine(offer))
    return
  }
  if (offerInstall(offer)) return
  if (await publishOffer()) return
  await notify(toast)
}

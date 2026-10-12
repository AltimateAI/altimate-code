// altimate_change - new file
/**
 * Writes a driver's reconnects to `opencode.log`. When Snowflake closes a session (idle
 * timeout, VPN drop, laptop sleep) the driver opens a new one and the statement goes on,
 * so the user sees nothing; without these lines the log did not show it either, and a
 * session that kept dropping looked the same as one that never did.
 */
import { onReconnect, type ReconnectEvent } from "@altimateai/drivers"
import { fileLog } from "@/altimate/util/file-log"
import { Telemetry } from "@/altimate/telemetry"

type Write = typeof fileLog

/** Connection names by warehouse account: the driver knows the account, the log lines name the connection. */
const names = new Map<string, Set<string>>()

/** Called before each connect, so a later reconnect on that account can name its connection. */
export function remember(account: string, name: string): void {
  if (!account) return
  const set = names.get(account) ?? new Set<string>()
  set.add(name)
  names.set(account, set)
}

/** Called when a connection is removed, so a later reconnect on its account is not put down to it. */
export function forget(name: string): void {
  for (const [account, set] of names) {
    set.delete(name)
    if (set.size === 0) names.delete(account)
  }
}

/** One name only when the account maps to exactly one connection; two connections on one account are both possible. */
function nameFor(account: string | undefined): string | undefined {
  const set = account ? names.get(account) : undefined
  return set && set.size === 1 ? [...set][0] : undefined
}

export function handle(e: ReconnectEvent, write: Write = fileLog): void {
  const base = {
    ...(nameFor(e.account) ? { name: nameFor(e.account) } : {}),
    type: e.warehouse,
    ...(e.account ? { account: e.account } : {}),
    reason: e.reason,
  }
  if (e.phase === "started") {
    write("INFO", "warehouse-connect", "reconnecting", base)
  } else if (e.phase === "reconnected") {
    write("INFO", "warehouse-connect", "reconnected", {
      ...base,
      duration_ms: e.durationMs,
      settings_restored: e.settingsRestored,
      session_state_lost: e.sessionStateLost,
    })
  } else {
    write("WARN", "warehouse-connect", "reconnect failed", {
      ...base,
      duration_ms: e.durationMs,
      error: Telemetry.maskString(String(e.error ?? "")).slice(0, 500),
    })
  }
}

let unsubscribe: (() => void) | undefined

/** Idempotent; called before every warehouse connect. */
export function install(write: Write = fileLog): void {
  if (unsubscribe) return
  unsubscribe = onReconnect((e) => handle(e, write))
}

export function resetForTests(): void {
  unsubscribe?.()
  unsubscribe = undefined
  names.clear()
}

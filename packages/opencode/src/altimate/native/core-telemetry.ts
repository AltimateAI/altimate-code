/**
 * altimate-core sends its own usage event (operation, duration, machine id) unless its opt-out
 * variables or `initSdk` say otherwise. It does not read assessment mode, and a variable set from
 * this process does not reach it, so assessment mode switches it off through `initSdk`, which only
 * stores the setting. A core that cannot load has nothing to send.
 */
export type CoreTelemetrySwitch = {
  initSdk?: (apiKey: string, tenant: string, backendUrl: string, reportFailures: boolean, telemetry: boolean) => void
}

/** Switches the usage event off on a core already loaded. */
export function silenceWith(core: CoreTelemetrySwitch): void {
  core.initSdk?.("", "", "", false, false)
}

export async function silence(): Promise<void> {
  try {
    silenceWith((await import("@altimateai/altimate-core")) as unknown as CoreTelemetrySwitch)
  } catch {
    // No core binary on this platform: no core call can run, so none can send.
  }
}

export * as CoreTelemetry from "./core-telemetry"

// altimate_change start — seam for onboarding funnel telemetry.
//
// `packages/tui` cannot import `packages/opencode`, where the Telemetry module lives, so the
// host injects a callback through `TuiInput` and this context carries it to the components that
// need it. Same shape as `./exit.tsx`, which threads the host's exit function the same way.
//
// PLACEMENT MATTERS: the provider must be mounted ABOVE `DialogProvider`. `ui/dialog.tsx`
// renders dialog contents as a sibling of its children, so a provider placed around `<App>` —
// which is inside DialogProvider — is invisible to every dialog. `dialog-scan-gate.tsx`
// documents the same trap for the prompt ref.
//
// The event union is declared here rather than imported because of that package boundary. Field
// names must match the corresponding `Telemetry.Event` variants in
// `packages/opencode/src/altimate/telemetry/index.ts`; the host maps `name` → `type` and spreads
// the rest. A test pins the two together.
import { createContext, useContext, type ParentProps } from "solid-js"

export type OnboardingTelemetryEvent =
  | { name: "onboarding_started" }
  | {
      name: "model_picker_shown"
      /** The picker also opens from /connect, from declining Altimate Base, and from the prompt
       *  gate — without this the event reads as a first-run impression every time. */
      trigger: "first_run" | "connect_command" | "altimate_base_back" | "prompt_gate"
    }
  | {
      name: "provider_selected"
      /** Raw ids, classified by the host — a provider a user named after their own company must
       *  never reach telemetry, and that policy belongs where the allowlist lives, not here. */
      providerID?: string
      modelID?: string
      /** The "Search all providers…" row itself, which has no provider of its own. */
      searchAll?: boolean
      /** Set when the pick came from the full catalogue, i.e. after `searchAll`. */
      via_search?: boolean
    }
  | { name: "altimate_base_confirm_shown"; origin: "welcome" | "model" }
  | { name: "altimate_base_choice"; choice: "accept" | "cancel" }
  | {
      name: "altimate_base_register_result"
      result: "success" | "rate_limited" | "unavailable" | "network" | "error"
    }
  | { name: "scan_gate_shown" }
  | { name: "scan_gate_choice"; choice: "scan" | "skip" | "dismissed" }
  | { name: "onboarding_completed" }

export type TrackOnboarding = (event: OnboardingTelemetryEvent) => void | Promise<void>

const OnboardingTelemetryContext = createContext<TrackOnboarding>()

export function OnboardingTelemetryProvider(props: ParentProps<{ track: TrackOnboarding }>) {
  return (
    <OnboardingTelemetryContext.Provider value={props.track}>{props.children}</OnboardingTelemetryContext.Provider>
  )
}

/**
 * Deliberately NOT built on `createSimpleContext`, which throws when a consumer sits outside its
 * provider. Telemetry is the one context that must never do that: these dialogs are rendered
 * directly by tests and can be reused by other hosts, and analytics is not a reason to crash a
 * UI. Missing provider means no tracking.
 *
 * The host callback is also isolated — a throwing tracker would otherwise propagate out of a
 * mount handler or a keypress and take the dialog transition with it.
 */
export function useOnboardingTelemetry(): TrackOnboarding {
  const track = useContext(OnboardingTelemetryContext)
  return (event) => {
    try {
      // The host callback may be async (the opencode host's is), and a try/catch does not catch
      // a rejection — it would surface as an unhandled rejection instead.
      void Promise.resolve(track?.(event)).catch(() => {})
    } catch {
      // Telemetry must never break the UI.
    }
  }
}
// altimate_change end

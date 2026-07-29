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
import { createSimpleContext } from "./helper"

export type OnboardingTelemetryEvent =
  | { name: "onboarding_started" }
  | {
      name: "model_picker_shown"
      /** The picker also opens from /connect, from declining Big Pickle, and from the prompt
       *  gate — without this the event reads as a first-run impression every time. */
      trigger: "first_run" | "connect_command" | "big_pickle_back" | "prompt_gate"
    }
  | {
      name: "provider_selected"
      provider: "altimate_gateway" | "anthropic" | "openai" | "google" | "big_pickle" | "search_all"
    }
  | { name: "big_pickle_confirm_shown"; origin: "welcome" | "model" }
  | { name: "big_pickle_choice"; choice: "accept" | "cancel" }
  | { name: "scan_gate_shown" }
  | { name: "scan_gate_choice"; choice: "scan" | "skip" }
  | { name: "onboarding_completed" }

export type TrackOnboarding = (event: OnboardingTelemetryEvent) => void

export const { use: useOnboardingTelemetry, provider: OnboardingTelemetryProvider } = createSimpleContext({
  name: "OnboardingTelemetry",
  init: (input: { track: TrackOnboarding }) => input.track,
})
// altimate_change end

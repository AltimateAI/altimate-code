// altimate_change start — first-run onboarding funnel emitter.
//
// Thin, typed wrapper over Telemetry.track for the onboarding taxonomy. It exists for two
// reasons that a bare track() call cannot cover:
//
//  1. INIT ORDERING. Telemetry.init() runs in the CLI middleware on the main thread
//     (src/index.ts) but, in the TUI worker, only via session/prompt.ts when a prompt runs.
//     Onboarding events fire before any prompt exists — a user who quits during gateway auth
//     never reaches one — so those events would sit in the pre-init buffer and never ship.
//     emit() awaits the idempotent init() first.
//
//  2. ABANDONMENT. `onboarding_abandoned` is defined by what did NOT happen, so something has
//     to remember how far the user got. See the thread note below for where that state lives.
//
// THREAD NOTE — this matters and is easy to get wrong. `altimate-code tui` runs the TUI on the
// process main thread and the HTTP server in a Worker (src/cli/cmd/tui.ts), and each thread
// loads its own instance of the Telemetry module with its own buffer. TUI-side events
// (model picker, provider rows, scan gate) are tracked on the MAIN thread; server-side events
// (gateway auth, project scan, sample setup) on the WORKER. Neither can see the other's stage.
//
// Abandonment is therefore owned by the main thread: it is where the process exits, and where
// the user-visible funnel position is known. `last_stage` means "the furthest point the user
// reached in the TUI", which is the question the funnel is actually asking. Server-side stages
// are marked from their TUI-visible trigger (choosing the gateway provider marks `gateway_auth`)
// rather than from the worker, which cannot reach this state.
import { Telemetry } from "./index"

/** Funnel positions, ordered. `last_stage` on abandonment reports the furthest one reached. */
export const ONBOARDING_STAGES = [
  "started",
  "model_picker",
  "big_pickle_confirm",
  "gateway_auth",
  "connected",
  "scan_gate",
  "activation",
] as const

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number]

/** Every onboarding variant of Telemetry.Event, minus the envelope fields emit() fills in. */
type OnboardingEventInput = Extract<
  Telemetry.Event,
  {
    type:
      | "onboarding_started"
      | "model_picker_shown"
      | "provider_selected"
      | "big_pickle_confirm_shown"
      | "big_pickle_choice"
      | "gateway_device_code_issued"
      | "gateway_auth_completed"
      | "gateway_auth_failed"
      | "instance_connected"
      | "onboarding_completed"
      | "scan_gate_shown"
      | "scan_gate_choice"
      | "environment_scan_completed"
      | "activation_menu_shown"
      | "activation_job_selected"
      | "first_job_completed"
      | "sample_setup_completed"
      | "first_prompt_sent"
      | "onboarding_abandoned"
  }
>

// Distributive: a bare Omit<A | B, K> collapses the union to its shared keys, which would drop
// every per-event property (reason, choice, job, …) from the emit() signature.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

type EmitInput = DistributiveOmit<OnboardingEventInput, "timestamp" | "session_id">

// Module-global, per thread. Resets on every process launch, which is correct: a fresh launch
// is a fresh onboarding attempt.
let furthestStage: OnboardingStage | undefined
let completed = false
let abandonedEmitted = false

/** Stage implied by an event, where one is implied. Events not listed leave the stage alone. */
const STAGE_FOR_EVENT: Partial<Record<OnboardingEventInput["type"], OnboardingStage>> = {
  onboarding_started: "started",
  model_picker_shown: "model_picker",
  big_pickle_confirm_shown: "big_pickle_confirm",
  gateway_device_code_issued: "gateway_auth",
  instance_connected: "connected",
  onboarding_completed: "connected",
  scan_gate_shown: "scan_gate",
  activation_menu_shown: "activation",
}

function advance(stage: OnboardingStage) {
  const next = ONBOARDING_STAGES.indexOf(stage)
  const current = furthestStage ? ONBOARDING_STAGES.indexOf(furthestStage) : -1
  // Monotonic: re-opening the picker after reaching the scan gate must not walk the funnel back.
  if (next > current) furthestStage = stage
}

/**
 * Emit an onboarding event. Fire-and-forget by design — onboarding must never wait on, or fail
 * because of, telemetry. Awaiting the returned promise is only useful on an exit path.
 */
export async function emit(event: EmitInput): Promise<void> {
  try {
    const stage = STAGE_FOR_EVENT[event.type]
    if (stage) advance(stage)
    if (event.type === "onboarding_completed") completed = true

    await Telemetry.init()
    Telemetry.track({
      ...event,
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
    } as Telemetry.Event)
  } catch {
    // Telemetry must never break onboarding.
  }
}

/** Mark the gateway provider path as entered. The browser flow itself runs in the worker, whose
 *  telemetry state this thread cannot see — see the thread note at the top of this file. */
export function markStage(stage: OnboardingStage) {
  advance(stage)
}

/** True once `onboarding_completed` has been emitted on this thread. */
export function isCompleted() {
  return completed
}

/**
 * Emit `onboarding_abandoned` if the user got somewhere in the funnel and never completed.
 * Call on the exit path, before the final flush. No-ops when the user never started (a
 * returning user with credentials), already completed, or when it has already fired.
 */
export async function emitAbandonedIfIncomplete(): Promise<void> {
  if (completed || abandonedEmitted || !furthestStage) return
  abandonedEmitted = true
  await emit({ type: "onboarding_abandoned", last_stage: furthestStage })
}

/** Test seam — module state is per-process by design, so tests need an explicit reset. */
export function resetForTest() {
  furthestStage = undefined
  completed = false
  abandonedEmitted = false
}
// altimate_change end

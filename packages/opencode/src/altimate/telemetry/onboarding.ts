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
  "provider_setup",
  "big_pickle_confirm",
  "gateway_auth",
  // NOTE: reaching this stage means the run completed, and emitAbandonedIfIncomplete() returns
  // early on `completed`. So "connected" is a valid funnel position but never a `last_stage` on
  // an abandonment — see the enum note in docs/docs/reference/telemetry.md.
  "connected",
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
      | "local_model_info_shown"
      | "local_model_choice"
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

/** Exported so the cross-package parity assertion in the tests can pin the TUI union to this. */
export type OnboardingEmitInput = EmitInput

// Module-global, per thread. Resets on every process launch, which is correct: a fresh launch
// is a fresh onboarding attempt.
let furthestStage: OnboardingStage | undefined
let completed = false
let abandonedEmitted = false
/** Set only when the first-run gate actually opened. Gates the whole funnel — see advance(). */
let funnelStarted = false

/** Stage implied by an event, where one is implied. Events not listed leave the stage alone. */
const STAGE_FOR_EVENT: Partial<Record<OnboardingEventInput["type"], OnboardingStage>> = {
  onboarding_started: "started",
  model_picker_shown: "model_picker",
  // Any provider choice enters setup. Without this, a user who picks Anthropic and quits during
  // key entry is reported as abandoning at `model_picker` — as if they never chose anything.
  provider_selected: "provider_setup",
  big_pickle_confirm_shown: "big_pickle_confirm",
  gateway_device_code_issued: "gateway_auth",
  instance_connected: "connected",
  onboarding_completed: "connected",
  // Deliberately no entry for scan_gate_shown / activation_menu_shown. Abandonment is defined as
  // quitting BEFORE connecting, and both of those only happen after `onboarding_completed` has
  // set `completed`, which suppresses abandonment entirely. Stages for them would be values that
  // can never be reported.
}

function advance(stage: OnboardingStage) {
  // Only a real first run is in the funnel. Most of the UI that emits funnel events is also
  // reachable outside onboarding — `/connect` opens the same picker, `/model` opens the same Big
  // Pickle interstitial — and a returning user doing either would otherwise enter the funnel at
  // `model_picker`, never emit `onboarding_completed`, and be reported as ABANDONED on exit.
  // That would have made abandonment mostly a count of returning users opening `/connect`.
  //
  // `onboarding_started` is emitted only from the branch that actually opens the first-run gate,
  // so it is the gate for everything downstream.
  if (stage !== "started" && !funnelStarted) return
  if (stage === "started") funnelStarted = true

  const next = ONBOARDING_STAGES.indexOf(stage)
  const current = furthestStage ? ONBOARDING_STAGES.indexOf(furthestStage) : -1
  // Monotonic: re-opening the picker after reaching the scan gate must not walk the funnel back.
  if (next > current) furthestStage = stage
}

/**
 * Emit an onboarding event. Fire-and-forget by design — onboarding must never wait on, or fail
 * because of, telemetry. Awaiting the returned promise is only useful on an exit path.
 */
export async function emit(event: EmitInput, sessionID?: string): Promise<void> {
  try {
    const stage = STAGE_FOR_EVENT[event.type]
    if (stage) advance(stage)
    // upstream_fix: the local-model interstitial has no gateway/auth follow-up —
    // the picker cannot run the multi-minute `altimate local` setup itself, so
    // "acknowledge" hands the user a command and the dialog closes. Without this,
    // a user who acknowledges and quits to run it separately is reported as
    // ABANDONED at `model_picker`, as if they never made a choice — the same
    // false-abandonment `provider_selected` guards against above, applied to the
    // one curated row that never reaches the gateway/auth stages.
    if (event.type === "local_model_choice" && event.choice === "acknowledge") advance("provider_setup")
    if (event.type === "onboarding_completed") completed = true

    // Resolve the ambient session BEFORE the await: a setContext() landing during init() would
    // otherwise reassign it, which is exactly what the note below says this prevents.
    const resolvedSession = sessionID ?? Telemetry.getContext().sessionId
    await Telemetry.init()
    Telemetry.track({
      ...event,
      timestamp: Date.now(),
      // Prefer the caller's session over the ambient telemetry context. setContext() is
      // process-global and set by the session loop, so a plugin hook firing for session A while
      // the context still points at session B would otherwise misattribute the event — or stamp
      // "" when no session has run yet, which is the normal case for the gateway events.
      session_id: resolvedSession,
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

/**
 * Emit `onboarding_abandoned` if the user got somewhere in the funnel and never completed.
 * Call on the exit path, before the final flush. No-ops when the user never started (a
 * returning user with credentials), already completed, or when it has already fired.
 */
export async function emitAbandonedIfIncomplete(opts?: { connected?: boolean }): Promise<void> {
  if (completed || abandonedEmitted || !furthestStage) return
  // A gateway sign-in that succeeded is not an abandonment, even if the TUI never observed it.
  // `gateway_auth_completed` and `instance_connected` are emitted on the WORKER thread, and this
  // state lives on the main thread — so a user who finishes in the browser and quits before the
  // TUI notices the new provider would otherwise be reported as abandoning at `gateway_auth`, in
  // the same launch that already reported a successful connection. Two contradictory terminal
  // states for one run, and gateway auth is the slowest step so it is the likeliest to hit this.
  //
  // The caller passes whether credentials now exist, which is the main thread's own view of the
  // same fact and needs no cross-thread channel.
  if (opts?.connected) return
  abandonedEmitted = true
  await emit({ type: "onboarding_abandoned", last_stage: furthestStage })
}

// ---------------------------------------------------------------------------
// Session-scoped state (worker thread)
//
// The activation events are inferred, not observed: the menu is text the model writes from
// src/command/template/onboard-connect.txt, and the user answers in free text. What IS
// deterministic is which command started the session and which tool ran next, so that is what
// these track. Lives here rather than in the plugin so there is one home for onboarding state.
//
// Bounded: a `serve` process is long-lived and sees unboundedly many sessions, so these must not
// grow forever. Sets are capped and evict in insertion order.
// ---------------------------------------------------------------------------

const MAX_TRACKED_SESSIONS = 256

/**
 * One record per tracked session, rather than a set per flag. Separate sets can evict a session
 * from some and not others, which produces the worst possible state: a session still considered
 * "onboarding" but with its once-per-session claims forgotten, so it re-emits `first` events. A
 * single map evicts a session's whole state atomically — it then simply stops being tracked.
 */
type SessionRecord = {
  /** Next user message was submitted by a slash command, not typed. */
  commandSubmission: boolean
  /** Session was started by `/onboard-connect`. */
  onboarding: boolean
  menuShown: boolean
  jobSelected: boolean
  /** Which job was selected, so completion cannot name a different one. */
  selectedJob?: string
  jobCompleted: boolean
  firstPromptSent: boolean
  environmentScanned: boolean
}

const sessions = new Map<string, SessionRecord>()

function record(sessionID: string): SessionRecord {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  if (sessions.size >= MAX_TRACKED_SESSIONS) {
    // Prefer evicting a non-onboarding record. Plain insertion order could drop a live onboarding
    // session, after which isOnboardingSession() returns false and the rest of that user's
    // activation events vanish with no trace.
    let victim: string | undefined
    for (const [id, rec] of sessions) {
      if (!rec.onboarding) {
        victim = id
        break
      }
    }
    if (victim === undefined) {
      const oldest = sessions.keys().next()
      if (!oldest.done) victim = oldest.value
    }
    if (victim !== undefined) sessions.delete(victim)
  }
  const created: SessionRecord = {
    commandSubmission: false,
    onboarding: false,
    menuShown: false,
    jobSelected: false,
    selectedJob: undefined,
    jobCompleted: false,
    firstPromptSent: false,
    environmentScanned: false,
  }
  sessions.set(sessionID, created)
  return created
}

/** Claim a once-per-session flag. Returns false if it was already claimed. */
function claim(
  sessionID: string,
  key: "menuShown" | "jobSelected" | "jobCompleted" | "firstPromptSent" | "environmentScanned",
): boolean {
  const entry = record(sessionID)
  if (entry[key]) return false
  entry[key] = true
  return true
}

/**
 * Record that the next user message in this session comes from a slash command.
 *
 * Only touches sessions already tracked. `command.execute.before` fires for EVERY slash command
 * in every session, so creating a record here made ordinary `/discover`, `/model` and so on churn
 * the capped map and evict genuine onboarding sessions — after which `isOnboardingSession()`
 * returns false and the rest of that user's activation events are silently dropped.
 *
 * An untracked session has no onboarding state to protect, so skipping it loses nothing:
 * `first_prompt_sent` is gated on `isOnboardingSession` anyway.
 */
export function noteCommandSubmission(sessionID: string) {
  const entry = sessions.get(sessionID)
  if (entry) entry.commandSubmission = true
}

/** True (once) if this session's pending user message was command-submitted. */
export function consumeCommandSubmission(sessionID: string): boolean {
  const entry = sessions.get(sessionID)
  if (!entry?.commandSubmission) return false
  entry.commandSubmission = false
  return true
}

/**
 * Mark this THREAD as being inside a first run.
 *
 * The gateway auth flow (plugin/altimate.ts) emits funnel events from the worker, where
 * `funnelStarted` is always false — `onboarding_started` is emitted on the main thread and the
 * two threads are separate module instances. Gating those emits on `funnelStarted` would have
 * silenced them entirely, so they were left ungated and fired for routine `/auth`, `/connect`
 * and reauthentication too: onboarding-taxonomy events from returning users, which is the exact
 * contamination the funnel gates exist to prevent.
 *
 * The TUI calls the worker's `onboardingStarted` RPC when the first-run gate opens, which lands
 * here. In non-TUI hosts (`serve`, `run`, `github`) there is no first-run funnel, so this stays
 * false and the gateway events correctly do not fire.
 */
export function markFunnelActive() {
  funnelStarted = true
}

/** Whether this thread has been told a first run is in progress. */
export function isFunnelActive() {
  return funnelStarted
}

export function markOnboardingSession(sessionID: string) {
  record(sessionID).onboarding = true
}

export function isOnboardingSession(sessionID: string): boolean {
  return sessions.get(sessionID)?.onboarding === true
}

export const claimActivationMenu = (sessionID: string) => claim(sessionID, "menuShown")
export function claimActivationJobSelected(sessionID: string, job: string): boolean {
  if (!claim(sessionID, "jobSelected")) return false
  record(sessionID).selectedJob = job
  return true
}

/** True only when `job` is the one this session actually selected. Without this the funnel could
 *  report sql_review selected and sample_duck_db completed — not a coherent conversion pair. */
export function isSelectedJob(sessionID: string, job: string): boolean {
  return sessions.get(sessionID)?.selectedJob === job
}
export const claimFirstJobCompleted = (sessionID: string) => claim(sessionID, "jobCompleted")
export const claimFirstPrompt = (sessionID: string) => claim(sessionID, "firstPromptSent")
export const claimEnvironmentScan = (sessionID: string) => claim(sessionID, "environmentScanned")

/** Test seam — module state is per-process by design, so tests need an explicit reset. */
export function resetForTest() {
  furthestStage = undefined
  completed = false
  abandonedEmitted = false
  funnelStarted = false
  sessions.clear()
}
// altimate_change end

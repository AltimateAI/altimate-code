// altimate_change start — makeRuntime for the restored Promise wrapper (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = {
  Status: SessionStatusEvent.Status,
  // deprecated
  Idle: SessionStatusEvent.Idle,
  // altimate_change start (AI-7519) — session.phase carries the currently-active bootstrap or per-turn
  // sub-step name so the TUI can render an honest "Loading config..." / "Discovering tools..." label
  // during the invisible pre-first-visible-response window (target <10s to first visible response).
  Phase: EventV2.define({
    type: "session.phase",
    schema: {
      sessionID: SessionID,
      // Sub-span name from the traceSpan wrapper — e.g. "bootstrap.resolve-tools". The TUI maps
      // this to a human label; unknown phases fall back to "Thinking...".
      phase: Schema.String,
      // true when the phase opens, false when it closes. TUI clears the label on close if it
      // matches the currently-rendered phase.
      active: Schema.Boolean,
    },
  }),
  // altimate_change end
}

// altimate_change start - mirror status events onto the legacy Bus SSE stream
// consumed by `altimate-code run`.
const LegacyEvent = {
  Status: BusEvent.define(
    "session.status",
    z.object({
      sessionID: SessionID.zod,
      status: z.any(),
    }),
  ),
  Idle: BusEvent.define(
    "session.idle",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
  // altimate_change start (AI-7519) — legacy SSE mirror for the phase event
  Phase: BusEvent.define(
    "session.phase",
    z.object({
      sessionID: SessionID.zod,
      phase: z.string(),
      active: z.boolean(),
    }),
  ),
  // altimate_change end
}
// altimate_change end

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  // altimate_change start (AI-7519) — publish a session.phase event through
  // the EventV2 bus so V2 subscribers see phase transitions alongside the
  // legacy bus mirror.
  readonly publishPhase: (sessionID: SessionID, phase: string, active: boolean) => Effect.Effect<void>
  // altimate_change end
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, status)
    })

    // altimate_change start (AI-7519) — V2 publish for the session.phase event.
    // Complements the LegacyEvent.Phase publish that happens in the imperative
    // wrapper below so both V1 (SSE mirror) and V2 subscribers see phases.
    const publishPhase = Effect.fn("SessionStatus.publishPhase")(function* (
      sessionID: SessionID,
      phase: string,
      active: boolean,
    ) {
      yield* events.publish(Event.Phase, { sessionID, phase, active })
    })
    // altimate_change end

    return Service.of({ get, list, set, publishPhase })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))
// altimate_change end

// UNSURE: upstream v1.18.10 dropped LayerNode's lazy-deps thunk support (see
// packages/core/src/effect/layer-node.ts, not owned by this file). Using upstream's object-style
// API with a plain array; needs verification once layer-node.ts's conflict is resolved that this
// doesn't reintroduce the cyclic-import undefined-node bug the thunk was guarding against.
export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

// altimate_change start — restore the imperative Promise wrapper upstream removed in the
// Effect-only migration; the session prompt loop sets status synchronously.
const { runPromise: runStatus } = makeRuntime(Service, defaultLayer as Layer.Layer<Service>)
export async function set(sessionID: SessionID, status: Info) {
  const result = await runStatus((s) => s.set(sessionID, status))
  // altimate_change start - keep legacy /event subscribers in sync with EventV2 status.
  await Bus.publish(LegacyEvent.Status, { sessionID, status })
  if (status.type === "idle") await Bus.publish(LegacyEvent.Idle, { sessionID })
  // altimate_change end
  return result
}
export async function get(sessionID: SessionID) {
  return runStatus((s) => s.get(sessionID))
}
export async function list() {
  return runStatus((s) => s.list())
}
// altimate_change end

// altimate_change start (AI-7519) — publish a session.phase event. Fired by SessionPrompt.traceSpan
// on entry (active=true) and exit (active=false); the TUI subscribes to render an honest label like
// "Discovering warehouse tools..." during the pre-first-visible-response window. Publishes on both
// the EventV2 bus (for V2 subscribers) and the LegacyEvent.Phase bus (for the SSE mirror the TUI
// consumes). Best-effort: any failure here must not affect the traced operation itself. The two
// publishes are intentionally sequential (V2 first, legacy second) — an earlier attempt to
// parallelise them via `Promise.allSettled` produced intermittent e2e failures where the label
// wouldn't render, likely because the first ManagedRuntime warm-up races with the immediate
// legacy Bus.publish. Sequential is reliable + the cost is negligible on the hot path.
export async function publishPhase(sessionID: SessionID, phase: string, active: boolean) {
  try {
    await runStatus((s) => s.publishPhase(sessionID, phase, active))
  } catch {
    // never surface phase-publish failures back to the caller
  }
  try {
    await Bus.publish(LegacyEvent.Phase, { sessionID, phase, active })
  } catch {
    // never surface phase-publish failures back to the caller
  }
}
// altimate_change end

export * as SessionStatus from "./status"

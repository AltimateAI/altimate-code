export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

// altimate_change start (AI-7519) — session.phase carries the active bootstrap/per-turn
// sub-step (e.g. "bootstrap.resolve-tools") so the TUI can render "Discovering tools..."
// during the pre-first-visible-response window. Must be in the manifest: the v2 SSE
// handler encodes every event against the OpenCodeEvent union and drops unknown types.
export const Phase = Event.define({
  type: "session.phase",
  schema: {
    sessionID: SessionID,
    phase: Schema.String,
    active: Schema.Boolean,
  },
})
// altimate_change end

// altimate_change — include Phase (AI-7519) in the manifest inventory
export const Definitions = Event.inventory(Status, Idle, Phase)

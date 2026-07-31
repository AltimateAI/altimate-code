import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

// altimate_change start — /api/event declares Location.Info; resolve EventV2 refs before streaming.
// EventV2.Service is a global node shared by every location this server process hosts, so the
// subscribe handler must still filter to the connecting client's own project/workspace and
// resolve the richer Location.Info onto each event (and the initial server.connected event) —
// upstream's stream no longer needs this since it assumed a single-location server.
type EventLocation = Location.Ref & { readonly project?: Location.Info["project"] }

function eventLocation(current: Location.Interface, ref: Location.Ref) {
  const location = ref as EventLocation
  return new Location.Info({
    directory: location.directory,
    workspaceID: location.workspaceID,
    project: location.project ?? current.project,
  })
}

function eventWithResolvedLocation(current: Location.Interface, event: EventV2.Payload) {
  if (!event.location) return event
  return {
    ...event,
    location: eventLocation(current, event.location),
  }
}
// altimate_change end

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        // altimate_change start — scope the stream to this connection's own project/workspace
        const location = yield* Location.Service
        // altimate_change end
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          // altimate_change start — tell the client its resolved project context up front
          location: new Location.Info({
            directory: location.directory,
            workspaceID: location.workspaceID,
            project: location.project,
          }),
          // altimate_change end
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return Stream.make(connected).pipe(
              Stream.concat(
                // altimate_change start — filter the global event bus down to this location
                live.pipe(
                  Stream.filter(
                    (event) =>
                      event.location?.directory === location.directory &&
                      event.location.workspaceID === location.workspaceID,
                  ),
                  Stream.map((event) => eventWithResolvedLocation(location, event)),
                ),
                // altimate_change end
              ),
            )
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)

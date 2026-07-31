import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
// altimate_change start — makeRuntime for the restored Promise wrappers (see bottom of file)
import { makeRuntime, attachWith } from "@/effect/run-service"
// altimate_change end
// altimate_change start — Bus.subscribe restores MessageV2 event forwarding (see watch() comment below)
import { Bus } from "@/bus"
// altimate_change end
import { Effect, Exit, Layer, Option, Schema, Scope, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderID, ModelID } from "@/provider/schema"
import { EventV2 } from "@opencode-ai/core/event"
// altimate_change start — SessionSummary.diff computes the full-session diff on read; the
// Session.Service.diff facade is a stub that always returns [] (true in both fork and upstream —
// not something this merge introduced), so full-session share syncs would silently ship an empty
// session_diff without this.
import { SessionSummary } from "@/session/summary"
// altimate_change end

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
}

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service
    // altimate_change start — see SessionSummary import comment above
    const summary = yield* SessionSummary.Service
    // altimate_change end

    function sync(sessionID: SessionID, data: Data[]) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (!share) return

        const s = yield* InstanceState.get(state)
        const existing = s.queue.get(sessionID)
        if (existing) {
          for (const item of data) {
            existing.set(key(item), item)
          }
          return
        }

        const next = new Map(data.map((item) => [key(item), item]))
        s.queue.set(sessionID, next)
        // altimate_change — Effect.catchCause + Effect.forkIn(scope) here supersedes the fork's
        // former imperative `try/catch` around the flush timeout (upstream_fix, dropped: upstream
        // ships an equivalent — actually stronger, scope-managed — fix for the same background
        // share-sync-failure-must-not-crash bug).
        yield* flush(sessionID).pipe(
          Effect.delay(1000),
          Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID: sessionID, cause: cause })),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = { queue: new Map(), scope: yield* Scope.make(), shared: new Map() }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
              }),
            ),
          ),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          events.listen((event) => {
            if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
            return fn(event.data as EventV2.Data<D>).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
              ),
            )
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id, [{ type: "session", data: structuredClone(info) as SDK.Session }])
          }),
        )
        // altimate_change start — upstream_fix: MessageV2 is a fork-only message model that was
        // never migrated to the core EventV2 bus `watch()` reads above — session/index.ts and
        // session/session.ts's PartDelta case still publish these via the legacy zod `Bus`
        // (pre-merge share.ts subscribed the same way). Restore Bus.subscribe here instead of
        // watch(), or share stops receiving message/part updates entirely.
        const runInInstance = (effect: Effect.Effect<void, unknown>) =>
          Effect.runPromise(attachWith(effect, { instance: _ctx })).catch((cause) =>
            Effect.runPromise(Effect.logError("share subscriber failed", { cause })),
          )

        const unsubMessageUpdated = Bus.subscribe(MessageV2.Event.Updated, (evt) => {
          const info = evt.properties.info
          return runInInstance(
            Effect.gen(function* () {
              yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])
              if (info.role !== "user") return
              const model = yield* provider.getModel(info.model.providerID, info.model.modelID)
              yield* sync(info.sessionID, [{ type: "model", data: [model] }])
            }),
          )
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubMessageUpdated))

        const unsubPartUpdated = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
          const part = evt.properties.part
          return runInInstance(sync(part.sessionID, [{ type: "part", data: structuredClone(part) as SDK.Part }]))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubPartUpdated))
        // altimate_change end
        yield* watch(Session.Event.Diff, (data) =>
          sync(data.sessionID, [{ type: "session_diff", data: structuredClone(data.diff) as SDK.SnapshotFileDiff[] }]),
        )
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        // altimate_change — keep fork's altimate.ai fallback URL over upstream's altimate.ai
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://altimate.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      const queued = s.queue.get(sessionID)
      if (!queued) return

      s.queue.delete(sessionID)

      const share = yield* getCached(sessionID)
      if (!share) return

      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret, data: Array.from(queued.values()) }),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        yield* Effect.logWarning("failed to sync share", {
          sessionID: sessionID,
          shareID: share.id,
          status: res.status,
        })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      // altimate_change — SessionSummary.diff (computes full-session diff on read) replaces
      // upstream's session.diff(sessionID), which is a stub always returning []; see import comment.
      const diffs = yield* summary.diff({ sessionID })
      const messages = yield* session.messages({ sessionID })
      const models = yield* Effect.forEach(
        Array.from(
          new Map(
            messages
              .filter((msg) => msg.info.role === "user")
              .map((msg) => (msg.info as SDK.UserMessage).model)
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).values(),
        ),
        // altimate_change start — upstream_fix: provider.getModel takes the fork's ProviderID/
        // ModelID brand, not core's ProviderV2.ID/ModelV2.ID (SDK.UserMessage.model carries plain
        // strings here)
        (item) => provider.getModel(ProviderID.make(item.providerID), ModelID.make(item.modelID)),
        // altimate_change end
        { concurrency: 8 },
      )

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...messages.map((item) => ({ type: "message" as const, data: item.info })),
        ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      // altimate_change — Effect.catchCause + Effect.forkIn(scope) here supersedes the fork's
      // former imperative `void promise.catch()` (upstream_fix, dropped: upstream ships an
      // equivalent — actually stronger, scope-managed — fix for the same background
      // full-share-sync-failure-must-not-crash bug).
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  // altimate_change start — upstream_fix: lazy deps — SessionSummary/Session/Provider are
  // cyclic fork facades; defer reading their .node exports until the graph is compiled.
  deps: LayerNode.lazy(() => [
    Account.node,
    EventV2Bridge.node,
    Config.node,
    Database.node,
    httpClient,
    Provider.node,
    Session.node,
    // fork dependency — see SessionSummary import comment above
    SessionSummary.node,
  ]),
  // altimate_change end
})

// altimate_change start — Layer.suspend defers facade refs past circular module-init. The
// `as Layer.Layer<Service>` cast mirrors config.ts/event-v2-bridge.ts: LayerNode's own
// Missing-dependency check (CheckDependencies) confirms this composition leaves no service
// unresolved, but tsgo's structural inference for this many chained `Layer.provide` calls
// doesn't collapse RIn to `never` on its own.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Account.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
) as Layer.Layer<Service>
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration. session/index.ts's legacy `share`/`unshare` facades call these from
// plain async code; the makeRuntime bridge keeps reads/mutations bound to the active instance.
const { runPromise: runShareNext } = makeRuntime(Service, defaultLayer)
export async function create(sessionID: SessionID) {
  return runShareNext((svc) => svc.create(sessionID))
}
export async function remove(sessionID: SessionID) {
  return runShareNext((svc) => svc.remove(sessionID))
}
// altimate_change end

export * as ShareNext from "./share-next"

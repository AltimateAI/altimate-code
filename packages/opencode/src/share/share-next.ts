import { Bus } from "@/bus"
import { Account } from "@/account"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session"
// altimate_change — SessionSummary.diff computes the full-session diff on read; the facade
// Session.diff reads the persisted `session_diff` key, which the merge left unwritten after turns.
import { SessionSummary } from "@/session/summary"
import type { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Database, eq } from "@/storage/db"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Log } from "@/util/log"
import type * as SDK from "@opencode-ai/sdk/v2"
// altimate_change start — Effect Context.Service facade for new upstream consumers
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Instance } from "@/project/instance"
import { InstanceRef } from "@/effect/instance-ref"
// altimate_change end

export namespace ShareNext {
  const log = Log.create({ service: "share-next" })

  export type ApiEndpoints = {
    create: string
    sync: (shareId: string) => string
    remove: (shareId: string) => string
    data: (shareId: string) => string
  }

  function apiEndpoints(resource: string): ApiEndpoints {
    return {
      create: `/api/${resource}`,
      sync: (shareId) => `/api/${resource}/${shareId}/sync`,
      remove: (shareId) => `/api/${resource}/${shareId}`,
      data: (shareId) => `/api/${resource}/${shareId}/data`,
    }
  }

  const legacyApi = apiEndpoints("share")
  const consoleApi = apiEndpoints("shares")

  export async function url() {
    const req = await request()
    return req.baseUrl
  }

  export async function request(): Promise<{
    headers: Record<string, string>
    api: ApiEndpoints
    baseUrl: string
  }> {
    const headers: Record<string, string> = {}

    // altimate_change start — bridge merge: Account.active() became async in v1.4.0
    const active = await Account.active()
    // altimate_change end
    if (!active?.active_org_id) {
      const baseUrl = await Config.get().then((x) => x.enterprise?.url ?? "https://altimate.ai")
      return { headers, api: legacyApi, baseUrl }
    }

    const token = await Account.token(active.id)
    if (!token) {
      throw new Error("No active account token available for sharing")
    }

    headers["authorization"] = `Bearer ${token}`
    headers["x-org-id"] = active.active_org_id
    return { headers, api: consoleApi, baseUrl: active.url }
  }

  const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

  export async function init() {
    if (disabled) return
    Bus.subscribe(Session.Event.Updated, async (evt) => {
      await sync(evt.properties.info.id, [
        {
          type: "session",
          data: evt.properties.info,
        },
      ])
    })
    Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
      await sync(evt.properties.info.sessionID, [
        {
          type: "message",
          data: evt.properties.info,
        },
      ])
      if (evt.properties.info.role === "user") {
        await sync(evt.properties.info.sessionID, [
          {
            type: "model",
            data: [
              await Provider.getModel(evt.properties.info.model.providerID, evt.properties.info.model.modelID).then(
                (m) => m,
              ),
            ],
          },
        ])
      }
    })
    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      await sync(evt.properties.part.sessionID, [
        {
          type: "part",
          data: evt.properties.part,
        },
      ])
    })
    Bus.subscribe(Session.Event.Diff, async (evt) => {
      await sync(evt.properties.sessionID, [
        {
          type: "session_diff",
          data: evt.properties.diff,
        },
      ])
    })
  }

  export async function create(sessionID: SessionID) {
    if (disabled) return { id: "", url: "", secret: "" }
    log.info("creating share", { sessionID })
    const req = await request()
    const response = await fetch(`${req.baseUrl}${req.api.create}`, {
      method: "POST",
      headers: { ...req.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: sessionID }),
    })

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText)
      throw new Error(`Failed to create share (${response.status}): ${message || response.statusText}`)
    }

    const result = (await response.json()) as { id: string; url: string; secret: string }

    Database.use((db) =>
      db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run(),
    )
    // altimate_change start — upstream_fix: catch background full share sync failures
    void fullSync(sessionID).catch((error) => {
      log.error("share full sync failed", { sessionID, error })
    })
    // altimate_change end
    return result
  }

  function get(sessionID: SessionID) {
    const row = Database.use((db) =>
      db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).get(),
    )
    if (!row) return
    return { id: row.id, secret: row.secret, url: row.url }
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

  const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()
  async function sync(sessionID: SessionID, data: Data[]) {
    if (disabled) return
    const existing = queue.get(sessionID)
    if (existing) {
      for (const item of data) {
        existing.data.set(key(item), item)
      }
      return
    }

    const dataMap = new Map<string, Data>()
    for (const item of data) {
      dataMap.set(key(item), item)
    }

    const timeout = setTimeout(async () => {
      // altimate_change start — upstream_fix: catch background share flush failures
      try {
        const queued = queue.get(sessionID)
        if (!queued) return
        queue.delete(sessionID)
        const share = get(sessionID)
        if (!share) return

        const req = await request()
        const response = await fetch(`${req.baseUrl}${req.api.sync(share.id)}`, {
          method: "POST",
          headers: { ...req.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: share.secret,
            data: Array.from(queued.data.values()),
          }),
        })

        if (!response.ok) {
          log.warn("failed to sync share", { sessionID, shareID: share.id, status: response.status })
        }
      } catch (error) {
        log.error("share flush failed", { sessionID, error })
      }
      // altimate_change end
    }, 1000)
    queue.set(sessionID, { timeout, data: dataMap })
  }

  export async function remove(sessionID: SessionID) {
    if (disabled) return
    log.info("removing share", { sessionID })
    const share = get(sessionID)
    if (!share) return

    const req = await request()
    const response = await fetch(`${req.baseUrl}${req.api.remove(share.id)}`, {
      method: "DELETE",
      headers: { ...req.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: share.secret,
      }),
    })

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText)
      throw new Error(`Failed to remove share (${response.status}): ${message || response.statusText}`)
    }

    Database.use((db) => db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run())
  }

  async function fullSync(sessionID: SessionID) {
    log.info("full sync", { sessionID })
    const session = await Session.get(sessionID)
    const diffs = await SessionSummary.diff({ sessionID })
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const models = await Promise.all(
      Array.from(
        new Map(
          messages
            .filter((m) => m.info.role === "user")
            .map((m) => (m.info as SDK.UserMessage).model)
            .map((m) => [`${m.providerID}/${m.modelID}`, m] as const),
        ).values(),
      ).map((m) => Provider.getModel(ProviderID.make(m.providerID), ModelID.make(m.modelID)).then((item) => item)),
    )
    await sync(sessionID, [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: models,
      },
    ])
  }

  // altimate_change start — Effect Context.Service facade (delegates to namespace fns above)
  export type ShareResult = { id: string; url: string; secret: string }
  export type ShareRequest = {
    headers: Record<string, string>
    api: ApiEndpoints
    baseUrl: string
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly url: () => Effect.Effect<string>
    readonly request: () => Effect.Effect<ShareRequest>
    readonly create: (sessionID: SessionID) => Effect.Effect<ShareResult>
    readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

  // altimate_change start — bridge Effect InstanceRef back into the legacy ALS
  // Instance namespace. The imperative ShareNext functions read Config/Account/
  // Database via the makeRuntime facades, which resolve the active instance from
  // the legacy Instance ALS. Without restoring the InstanceRef captured by the
  // Effect runtime, those reads fail ("InstanceRef not provided"). Mirrors the
  // Plugin facade bridge in src/plugin/index.ts.
  const withInstance = <A>(fn: () => Promise<A>) =>
    Effect.gen(function* () {
      const ctx = yield* InstanceRef
      return yield* Effect.promise(() => (ctx ? Instance.restore(ctx, fn) : fn()))
    })

  export const layer = Layer.succeed(
    Service,
    Service.of({
      init: () => withInstance(() => init()),
      url: () => withInstance(() => url()),
      request: () => withInstance(() => request()),
      create: (sessionID) => withInstance(() => create(sessionID)),
      remove: (sessionID) => withInstance(() => remove(sessionID)),
    }),
  )
  // altimate_change end

  export const defaultLayer = layer

  export const node = LayerNode.make(layer, [])
  // altimate_change end
}

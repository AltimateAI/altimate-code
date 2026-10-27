import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
// altimate_change start — resolve symlinked external_directory rule paths
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"

const log = Log.create({ service: "permission" })
// altimate_change end
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
// altimate_change start — upstream_fix: evaluate normalized aliases without changing rule order
import { PermissionEvaluate } from "./evaluate"
// altimate_change end
// altimate_change start — upstream_fix: load persisted permission approvals
import { Database, eq } from "@/storage/db"
import { PermissionTable } from "./permission.sql"
// altimate_change end

export const Event = {
  Asked: EventV2.define({ type: "permission.asked", schema: PermissionV1.Request.fields }),
  Replied: EventV2.define({
    type: "permission.replied",
    schema: {
      sessionID: PermissionV1.Request.fields.sessionID,
      requestID: PermissionV1.ID,
      reply: PermissionV1.Reply,
    },
  }),
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

// altimate_change start — upstream_fix: share path-alias evaluation with legacy permissions
export { evaluate } from "./evaluate"
// altimate_change end

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        // altimate_change start — upstream_fix: load persisted permission approvals
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        // altimate_change end
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          // altimate_change start — upstream_fix: load persisted permission approvals
          approved: [...(row?.data ?? [])],
          // altimate_change end
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        // altimate_change start — upstream_fix: include normalized aliases in permission matching
        const rule = PermissionEvaluate.evaluateRequest(request, pattern, ruleset, approved)
        // altimate_change end
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          // altimate_change start — upstream_fix: apply approvals to equivalent path spellings
          (pattern) => PermissionEvaluate.evaluateRequest(item.info, pattern, approved).action === "allow",
          // altimate_change end
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    // altimate_change start — external_directory also asks for a path's symlink-resolved directory,
    // so a directory rule covers its resolved spelling too (e.g. macOS /tmp -> /private/tmp).
    // A generated twin may only tighten: deny/ask twins follow their rule, but allow twins go
    // before this map's authored rules, so a deny or ask the user wrote for the real path still
    // wins (last match wins) while an unmatched real path still gets the allow.
    const allowTwins: PermissionV1.Rule[] = []
    const rules: PermissionV1.Rule[] = []
    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ permission: key, pattern: expand(pattern), action })
      const resolved = key === "external_directory" ? resolvedDirectoryPattern(expand(pattern)) : undefined
      if (!resolved) continue
      const twin = { permission: key, pattern: resolved, action }
      if (action === "allow") allowTwins.push(twin)
      else rules.push(twin)
    }
    ruleset.push(...allowTwins, ...rules)
    // altimate_change end
  }
  return ruleset
}

// altimate_change start — resolved twin of an external_directory pattern: its literal leading
// directory (up to the first segment with a wildcard) resolved through symlinks, rest unchanged
function resolvedDirectoryPattern(pattern: string) {
  const segments = pattern.split(process.platform === "win32" ? /[\\/]/ : "/")
  const wildcard = segments.findIndex((segment) => /[*?]/.test(segment))
  if (wildcard <= 0) return
  const dir = segments.slice(0, wildcard).join(path.sep) || path.sep
  // A link loop in a configured directory just leaves the rule without a twin.
  const resolved = (() => {
    try {
      return Filesystem.realLocation(dir)
    } catch (error) {
      log.debug("no resolved twin for external_directory rule", { pattern, error: String(error) })
      return undefined
    }
  })()
  if (!resolved || resolved === dir) return
  const twin = path.join(resolved, ...segments.slice(wildcard))
  return process.platform === "win32" ? FSUtil.normalizePathPattern(twin) : twin
}
// altimate_change end

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [EventV2Bridge.node])
// altimate_change end

export * as Permission from "."

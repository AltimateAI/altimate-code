import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"
// altimate_change start — upstream_fix: persist real session diff totals (Storage + Bus)
import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"
// altimate_change end

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    // altimate_change start — upstream_fix: storage for session diff persistence
    const storage = yield* Storage.Service
    // altimate_change end

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const msgDiffs = yield* computeDiff({ messages })
      // altimate_change start — upstream_fix: persist real session diff totals after snapshot summarize
      const sessionDiffs = yield* computeDiff({ messages: all })
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: sessionDiffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: sessionDiffs.reduce((sum, x) => sum + x.deletions, 0),
          files: sessionDiffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], sessionDiffs).pipe(Effect.orDie)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: sessionDiffs })
      // altimate_change end
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let diffs: Snapshot.FileDiff[]
      if (input.messageID) {
        const message = all.find((item) => item.info.id === input.messageID)
        if (!message || message.info.role !== "user") return []
        diffs = message.info.summary?.diffs ?? []
      } else {
        // altimate_change — session-level diff on read (restores modified-files sidebar; see exported diff)
        diffs = yield* computeDiff({ messages: all })
      }
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    // altimate_change start — upstream_fix: provide Storage for session diff persistence
    Layer.provide(Storage.defaultLayer),
    // altimate_change end
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [
  Session.node,
  Snapshot.node,
  EventV2Bridge.node,
  Config.node,
  // altimate_change start — upstream_fix: Storage node for session diff persistence
  Storage.node,
  // altimate_change end
])
// altimate_change end

// altimate_change start — the imperative facade is called from the legacy session
// processor, whose sessions live in src/storage/db.ts. Do not build the Effect
// Session layer here; it reads the core database and misses those rows.
async function legacySession() {
  return (await import("./index")).Session
}

async function computeLegacyDiff(messages: Array<{ parts: Array<any> }>): Promise<Snapshot.FileDiff[]> {
  let from: string | undefined
  let to: string | undefined
  for (const item of messages) {
    if (!from) {
      for (const part of item.parts) {
        if (part.type === "step-start" && part.snapshot) {
          from = part.snapshot
          break
        }
      }
    }
    for (const part of item.parts) {
      if (part.type === "step-finish" && part.snapshot) to = part.snapshot
    }
  }
  if (!from || !to) return []
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(Snapshot.Service.use((snapshot) => snapshot.diffFull(from, to)))
}

export async function summarize(input: { sessionID: SessionID; messageID: MessageID }) {
  const sessions = await legacySession()
  await sessions.setSummary({
    sessionID: input.sessionID,
    summary: {
      additions: 0,
      deletions: 0,
      files: 0,
    },
  })
  if ((await Config.get()).snapshot === false) return
  const all = await sessions.messages({ sessionID: input.sessionID })
  if (!all.length) return
  const messages = all.filter(
    (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
  )
  const target = messages.find((m) => m.info.id === input.messageID)
  if (!target || target.info.role !== "user") return
  const msgDiffs = await computeLegacyDiff(messages)
  // altimate_change start — upstream_fix: persist real session diff totals after snapshot summarize
  const sessionDiffs = await computeLegacyDiff(all)
  await sessions.setSummary({
    sessionID: input.sessionID,
    summary: {
      additions: sessionDiffs.reduce((sum, x) => sum + x.additions, 0),
      deletions: sessionDiffs.reduce((sum, x) => sum + x.deletions, 0),
      files: sessionDiffs.length,
    },
  })
  const { AppRuntime } = await import("@/effect/app-runtime")
  await AppRuntime.runPromise(
    Storage.Service.use((storage) => storage.write(["session_diff", input.sessionID], sessionDiffs)),
  )
  await Bus.publish(sessions.Event.Diff, {
    sessionID: input.sessionID,
    diff: sessionDiffs,
  })
  // altimate_change end
  target.info.summary = { ...target.info.summary, diffs: msgDiffs }
  await sessions.updateMessage(target.info)
}
export async function diff(input: { sessionID: SessionID; messageID?: MessageID }) {
  const sessions = await legacySession()
  const all = await sessions.messages({ sessionID: input.sessionID })
  let diffs: Snapshot.FileDiff[]
  if (input.messageID) {
    const message = all.find((item) => item.info.id === input.messageID)
    if (!message || message.info.role !== "user") return []
    diffs = message.info.summary?.diffs ?? []
  } else {
    // altimate_change start — restore the session-level diff. The merge left this returning [] for
    // the no-messageID case, so the TUI modified-files sidebar (which hydrates via
    // session.diff({sessionID})) and the session summary counts went empty. Compute the full-session
    // file diff on demand from snapshots (matches main's summarizeSession content) — no new
    // storage/event wiring, and per-message diffs are unaffected.
    diffs = await computeLegacyDiff(all)
    // altimate_change end
  }
  return diffs.map((item) => {
    if (item.file === undefined) return item
    const file = unquoteGitPath(item.file)
    if (file === item.file) return item
    return { ...item, file }
  })
}
// altimate_change end

export * as SessionSummary from "./summary"

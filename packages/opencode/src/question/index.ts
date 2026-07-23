import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
// altimate_change start — makeRuntime for the restored Promise wrappers (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
import { registerDisposer } from "@/effect/instance-registry"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { zod } from "@/util/effect-zod"
import z from "zod"
// altimate_change end

// Schemas — these are pure data; nothing checks class identity (see PR
// description) so they're plain `Schema.Struct` + type alias. That lets
// `Question.ask` and other internal sites trust the type contract without a
// re-decode to coerce nested class instances.

export const Option = Schema.Struct({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}).annotate({ identifier: "QuestionOption" })
export type Option = Schema.Schema.Type<typeof Option>

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export type Prompt = Schema.Schema.Type<typeof Prompt>

export const Tool = Schema.Struct({
  messageID: MessageID,
  callID: Schema.String,
}).annotate({ identifier: "QuestionTool" })
export type Tool = Schema.Schema.Type<typeof Tool>

export const Request = Schema.Struct({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export type Reply = Schema.Schema.Type<typeof Reply>

export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "QuestionReplied" })

export const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
}).annotate({ identifier: "QuestionRejected" })

export const Event = {
  Asked: EventV2.define({ type: "question.asked", schema: Request.fields }),
  Replied: EventV2.define({ type: "question.replied", schema: Replied.fields }),
  Rejected: EventV2.define({ type: "question.rejected", schema: Rejected.fields }),
}

// altimate_change start — BusEvent mirrors of the question events.
//
// The EventV2 `Event` defs above publish to GlobalBus/EventV2 consumers only.
// The IDE webview subscribes to the `/event` SSE route, which is fed by the Bus
// *wildcard PubSub* (`Bus.publish`), a different channel. So `question.asked`
// never reached the webview → `pendingQuestions` stayed empty → the mcp-add
// question card had no request id to reply with → "submit does nothing".
// Publish these via `Bus.publish` too so they reach /event like every other
// webview-visible event.
//
// Reuse the structured Effect schemas (via the `zod` adapter) so the generated
// `/event` OpenAPI payloads match the SDK's typed shapes rather than `any`.
//
// Note: `EventV2Bridge.listen` already forwards these EventV2 events to GlobalBus
// and `Bus.publish` re-emits to GlobalBus too, so `/global/event` consumers see
// each question event twice (different top-level ids). This is intentional and
// verified harmless in-repo — TUI `sync.tsx` reconciles by request id,
// `notifications.ts` dedupes by id, and the trace consumer ignores question
// events. External subscribers that don't dedupe are the only residual concern.
const BusAsked = BusEvent.define("question.asked", zod(Request))
const BusReplied = BusEvent.define("question.replied", zod(Replied))
const BusRejected = BusEvent.define("question.rejected", zod(Rejected))

// Best-effort Bus mirror. A fire-and-forget /event notification must NEVER be
// able to abort core question settlement: `Effect.promise` turns a promise
// rejection into an unrecoverable fiber defect, and on the Deferred critical
// path that would skip `Deferred.succeed`/`Deferred.fail` and re-hang the tool
// on "Thinking…" — the exact failure this PR fixes. Recover any cause to a
// logged warning so publication can never block settlement.
const mirror = <D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) =>
  Effect.promise(() => Bus.publish(def, properties)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("question bus mirror failed", { type: def.type, cause })),
  )
// altimate_change end

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

// altimate_change start — process-global pending registry.
//
// The imperative `Question.ask()`/`reply()`/`list()` wrappers (bottom of file)
// get bundled into MORE THAN ONE module instance (proven: a module-scoped id
// differs between the tool's ask() and the HTTP route's reply()). Consistent
// `@/question` imports did NOT dedupe them. Each copy ran its own module-scoped
// `makeRuntime(...)` runtime with its own `InstanceState` cache, so the question
// TOOL registered the pending Deferred in one copy's map while the HTTP reply
// route looked it up in the OTHER copy's empty map — the Deferred never resolved
// and the `/discover-and-add-mcps` question hung on "Thinking…" after answering.
//
// Anchor the registry on `globalThis` so every module copy shares one Map. Keyed
// by instance directory so `list()` stays per-instance.
type PendingByDir = Map<string, Map<QuestionID, PendingEntry>>
const pendingByDir: PendingByDir = ((globalThis as Record<string, unknown>)["__altimateQuestionPending"] ??=
  new Map<string, Map<QuestionID, PendingEntry>>()) as PendingByDir
function pendingFor(directory: string): Map<QuestionID, PendingEntry> {
  let map = pendingByDir.get(directory)
  if (!map) {
    map = new Map<QuestionID, PendingEntry>()
    pendingByDir.set(directory, map)
  }
  return map
}
// altimate_change end

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    // altimate_change start — clear a directory's pending questions when its
    // instance is disposed/reloaded (mirrors the removed InstanceState finalizer)
    // so entries in the process-global registry don't leak across instances.
    const off = registerDisposer(async (directory) => {
      const map = pendingByDir.get(directory)
      if (!map) return
      pendingByDir.delete(directory)
      for (const { deferred } of map.values()) {
        await Effect.runPromise(
          Deferred.fail(deferred, new RejectedError()).pipe(
            Effect.catchCause((cause) => Effect.logWarning("question cleanup failed on dispose", { cause })),
          ),
        )
      }
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))
    // altimate_change end

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      // altimate_change start — pending map lives in the globalThis registry (see top of file)
      const directory = yield* InstanceState.directory
      const pending = pendingFor(directory)
      // altimate_change end
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      // altimate_change start — also mirror on the Bus wildcard so the IDE webview
      // (subscribed to /event) receives question.asked and can answer the card.
      // Best-effort: a publish failure must not abort ask() before it registers
      // the cleanup finalizer below (see `mirror`).
      yield* mirror(BusAsked, {
        id,
        sessionID: input.sessionID,
        questions: [...input.questions],
        tool: input.tool,
      })
      // altimate_change end

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      // altimate_change start — pending map lives in the globalThis registry (see top of file)
      const pending = pendingFor(yield* InstanceState.directory)
      // altimate_change end
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
      // altimate_change start — mirror on the Bus wildcard for /event (webview) clients,
      // AFTER settling the Deferred and best-effort so a publish failure can't re-hang ask().
      yield* mirror(BusReplied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      // altimate_change end
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      // altimate_change start — pending map lives in the globalThis registry (see top of file)
      const pending = pendingFor(yield* InstanceState.directory)
      // altimate_change end
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
      // altimate_change start — mirror on the Bus wildcard for /event (webview) clients,
      // AFTER settling the Deferred and best-effort so a publish failure can't strand it.
      yield* mirror(BusRejected, { sessionID: existing.info.sessionID, requestID: existing.info.id })
      // altimate_change end
    })

    const list = Effect.fn("Question.list")(function* () {
      // altimate_change start — pending map lives in the globalThis registry (see top of file)
      const pending = pendingFor(yield* InstanceState.directory)
      // altimate_change end
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [EventV2Bridge.node])
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers the server routes
// (server/routes/question.ts) call from plain async code. The makeRuntime bridge keeps the
// question reads/mutations bound to the active workspace/instance.
const { runPromise: runQuestion } = makeRuntime(Service, defaultLayer)
export function ask(input: { sessionID: SessionID; questions: ReadonlyArray<Info>; tool?: Tool }) {
  return runQuestion((svc) => svc.ask(input))
}
export function list() {
  return runQuestion((svc) => svc.list())
}
export function reply(input: { requestID: QuestionID; answers: ReadonlyArray<Answer> }) {
  return runQuestion((svc) => svc.reply(input))
}
export function reject(requestID: QuestionID) {
  return runQuestion((svc) => svc.reject(requestID))
}
// altimate_change end

export * as Question from "."

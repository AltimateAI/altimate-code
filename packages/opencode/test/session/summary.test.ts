import { expect } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Stream } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_summary_test")
const previousUserID = MessageID.make("msg_summary_previous_user")
const previousAssistantID = MessageID.make("msg_summary_previous_assistant")
const targetUserID = MessageID.make("msg_summary_target_user")
const targetAssistantID = MessageID.make("msg_summary_target_assistant")
const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

const fullSessionDiff: Snapshot.FileDiff[] = [
  { file: "previous.ts", additions: 2, deletions: 0, status: "added" },
  { file: "target.ts", additions: 3, deletions: 1, status: "modified" },
]
const targetTurnDiff: Snapshot.FileDiff[] = [{ file: "target.ts", additions: 3, deletions: 1, status: "modified" }]

const userInfo = (id: MessageID): SessionV1.User =>
  ({
    id,
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID, modelID },
    time: { created: Date.now() },
  }) as SessionV1.User

const assistantInfo = (id: MessageID, parentID: MessageID): SessionV1.Assistant =>
  ({
    id,
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID,
    providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }) as SessionV1.Assistant

const snapshotParts = (messageID: MessageID, from: string, to: string): SessionV1.Part[] =>
  [
    {
      id: PartID.ascending(),
      type: "step-start",
      messageID,
      sessionID,
      snapshot: from,
    },
    {
      id: PartID.ascending(),
      type: "step-finish",
      messageID,
      sessionID,
      snapshot: to,
      reason: "stop",
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  ] as SessionV1.Part[]

const messages = [
  { info: userInfo(previousUserID), parts: [] },
  {
    info: assistantInfo(previousAssistantID, previousUserID),
    parts: snapshotParts(previousAssistantID, "snapshot-0", "snapshot-1"),
  },
  { info: userInfo(targetUserID), parts: [] },
  {
    info: assistantInfo(targetAssistantID, targetUserID),
    parts: snapshotParts(targetAssistantID, "snapshot-1", "snapshot-2"),
  },
] as SessionV1.WithParts[]

const summaries: Array<{ sessionID: SessionID; summary: Session.Info["summary"] }> = []
const writes: Array<{ key: string[]; content: Snapshot.FileDiff[] }> = []
const published: Array<{ type: string; data: unknown }> = []
const diffCalls: Array<[string, string]> = []
let updatedMessage: SessionV1.Info | undefined

const session = Session.Service.of({
  messages: () => Effect.succeed(messages),
  setSummary: (input: { sessionID: SessionID; summary: Session.Info["summary"] }) =>
    Effect.sync(() => {
      summaries.push(input)
    }),
  updateMessage: <T extends SessionV1.Info>(msg: T) =>
    Effect.sync(() => {
      updatedMessage = msg
      return msg
    }),
} as unknown as Session.Interface)

const snapshot = Snapshot.Service.of({
  diffFull: (from: string, to: string) =>
    Effect.sync(() => {
      diffCalls.push([from, to])
      if (from === "snapshot-0" && to === "snapshot-2") return fullSessionDiff
      if (from === "snapshot-1" && to === "snapshot-2") return targetTurnDiff
      return []
    }),
} as Snapshot.Interface)

const storage = Storage.Service.of({
  write: <T>(key: string[], content: T) =>
    Effect.sync(() => {
      writes.push({ key, content: content as Snapshot.FileDiff[] })
    }),
} as unknown as Storage.Interface)

const events = EventV2Bridge.Service.of({
  publish: (definition, data) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data })
      return { id: EventV2.ID.create(), type: definition.type, data }
    }),
  subscribe: () => Stream.empty,
  all: () => Stream.empty,
  aggregateEvents: () => Stream.empty,
  sync: () => Effect.succeed(Effect.void),
  listen: () => Effect.succeed(Effect.void),
  beforeCommit: () => Effect.void,
  project: () => Effect.void,
  replay: () => Effect.void,
  replayAll: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  claim: () => Effect.void,
} as EventV2.Interface)

const it = testEffect(
  SessionSummary.layer.pipe(
    Layer.provide(Layer.succeed(Session.Service, session)),
    Layer.provide(Layer.succeed(Snapshot.Service, snapshot)),
    Layer.provide(Layer.succeed(Storage.Service, storage)),
    Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
    Layer.provide(TestConfig.layer({ get: () => Effect.succeed({ snapshot: true }) })),
  ),
)

it.effect("summarize persists the computed session diff after the initial empty diff", () =>
  Effect.gen(function* () {
    const summary = yield* SessionSummary.Service

    yield* summary.summarize({ sessionID, messageID: targetUserID })

    expect(diffCalls).toEqual([
      ["snapshot-1", "snapshot-2"],
      ["snapshot-0", "snapshot-2"],
    ])
    expect(summaries).toEqual([
      { sessionID, summary: { additions: 0, deletions: 0, files: 0 } },
      { sessionID, summary: { additions: 5, deletions: 1, files: 2 } },
    ])
    expect(writes).toEqual([{ key: ["session_diff", sessionID], content: fullSessionDiff }])
    expect(published.map((event) => event.type)).toEqual([Session.Event.Diff.type, Session.Event.Diff.type])
    expect(published.map((event) => (event.data as typeof Session.Event.Diff.data.Type).diff)).toEqual([
      [],
      fullSessionDiff,
    ])
    expect((updatedMessage as SessionV1.User | undefined)?.summary?.diffs).toEqual(targetTurnDiff)
  }),
)

// altimate_change start — PR #1171 review (codex P1 / cubic P1, raised on two
// separate threads): the post-compaction state ledger was built from
// `input.messages`, which the prompt loop supplies as the compaction-FILTERED
// view. From the SECOND compaction onward, every tool event hidden by an
// earlier compaction had already been filtered out, so the "session state
// ledger" silently forgot the files it had recorded — exactly the
// cross-compaction fidelity this feature exists to provide.
//
// `SessionCompaction.ledgerHistory` now reads the unfiltered session stream.
// These tests pin that behaviour against the real message store.
import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
  } as unknown as SessionV1.Info)
  return id
})

/** Attach one completed `write` tool part to an assistant message. */
const addWritePart = Effect.fn("Test.addWritePart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  filePath: string,
  end: number,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${filePath}`,
    tool: "write",
    state: {
      status: "completed",
      input: { filePath },
      output: "ok",
      title: filePath,
      metadata: {},
      time: { start: end - 1, end },
    },
  } as any)
})

const addCompactionPart = Effect.fn("Test.addCompactionPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
  } as any)
})

/** One write turn: user → assistant carrying a completed write tool part. */
const writeTurn = Effect.fn("Test.writeTurn")(function* (sessionID: SessionID, filePath: string, end: number) {
  const user = yield* addUser(sessionID)
  const assistant = yield* addAssistant(sessionID, user, { finish: "stop" })
  yield* addWritePart(sessionID, assistant, filePath, end)
})

/** A completed compaction: a user message holding the compaction part + its summary assistant reply. */
const compactionBoundary = Effect.fn("Test.compactionBoundary")(function* (sessionID: SessionID) {
  const user = yield* addUser(sessionID)
  yield* addCompactionPart(sessionID, user)
  yield* addAssistant(sessionID, user, { summary: true, finish: "stop" })
})

const writePaths = (ledger: ReturnType<typeof SessionCompaction.buildLedger>) =>
  ledger.writes.map((w) => w.path).sort()

describe("SessionCompaction.ledgerHistory", () => {
  it.instance("returns the full session history in chronological order", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* writeTurn(sessionID, "/a.sql", 1_000)
        yield* writeTurn(sessionID, "/b.sql", 2_000)

        const history = SessionCompaction.ledgerHistory(sessionID, [])
        const ends = history.flatMap((m) =>
          m.parts.filter((p: any) => p.type === "tool").map((p: any) => p.state?.time?.end),
        )
        expect(ends).toEqual([1_000, 2_000])
      }),
    ),
  )

  it.instance("keeps pre-compaction tool events that the filtered view drops", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* writeTurn(sessionID, "/early.sql", 1_000)
        yield* compactionBoundary(sessionID)
        yield* writeTurn(sessionID, "/late.sql", 3_000)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(sessionID))
        const full = SessionCompaction.ledgerHistory(sessionID, filtered)

        // The regression this fix closes: the filtered view has already lost the
        // pre-compaction write, so a ledger built from it forgets /early.sql.
        expect(writePaths(SessionCompaction.buildLedger(filtered))).not.toContain("/early.sql")
        // The unfiltered history the ledger now uses keeps both.
        expect(writePaths(SessionCompaction.buildLedger(full))).toEqual(["/early.sql", "/late.sql"])
      }),
    ),
  )

  it.instance("falls back to the supplied view when the session cannot be read", () =>
    withSession(() =>
      Effect.gen(function* () {
        const fallback: MessageV2.WithParts[] = []
        // A session id that does not exist makes the stream throw; the ledger
        // must degrade to the caller's view rather than propagate.
        const history = SessionCompaction.ledgerHistory("ses_does_not_exist" as SessionID, fallback)
        expect(history).toBe(fallback)
      }),
    ),
  )
})
// altimate_change end

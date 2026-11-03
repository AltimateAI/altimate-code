import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"

// After a compaction that keeps a tail, filterCompacted renders
// [compaction, summary, ...tail, continue]. The prompt loop's overflow check
// must read the summary, not the last tail assistant, whose recorded usage is
// the pre-compaction context; otherwise it compacts again before any request.

const TAIL_USER = MessageID.make("msg_001")
const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
const COMPACTION_USER = MessageID.make("msg_003")
const SUMMARY_ASSISTANT = MessageID.make("msg_004")
const CONTINUE_USER = MessageID.make("msg_005")

const tokens = (input: number) => ({ input, output: 100, reasoning: 0, cache: { read: 0, write: 0 }, total: input + 100 })
const user = (id: string, parts: any[]) => ({ info: { id, role: "user", sessionID: "s" }, parts })
const assistant = (id: string, parentID: string, extra: Record<string, any>) => ({
  info: { id, role: "assistant", sessionID: "s", parentID, ...extra },
  parts: [],
})

const newestFirst = [
  user(CONTINUE_USER, [{ type: "text", text: "Continue", synthetic: true }]),
  assistant(SUMMARY_ASSISTANT, COMPACTION_USER, { summary: true, finish: "stop", tokens: tokens(150_000) }),
  user(COMPACTION_USER, [{ type: "compaction", auto: true, tail_start_id: TAIL_USER }]),
  assistant(OVERFLOW_ASSISTANT, TAIL_USER, { finish: "tool-calls", tokens: tokens(180_000) }),
  user(TAIL_USER, [{ type: "text", text: "continue the task" }]),
] as unknown as MessageV2.WithParts[]

describe("post-compaction overflow check", () => {
  test("the array-last finished assistant is the retained pre-compaction turn", () => {
    const msgs = MessageV2.filterCompacted(newestFirst)
    const arrayLast = msgs.findLast((m) => m.info.role === "assistant" && (m.info as MessageV2.Assistant).finish)
    expect(arrayLast?.info.id).toBe(OVERFLOW_ASSISTANT)
  })

  test("selection by id lands on the summary, which the overflow check skips", () => {
    const finished = MessageV2.latest(MessageV2.filterCompacted(newestFirst)).finished
    expect(finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(finished?.summary).toBe(true)
  })

  test("the prompt loop selects lastFinished by id before the overflow check", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../src/session/prompt.ts"), "utf8")
    const select = source.indexOf("lastFinished = MessageV2.latest(msgs).finished")
    const check = source.indexOf("estimateUncountedTail(msgs, lastFinished?.id)")
    expect(select).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(select)
  })
})

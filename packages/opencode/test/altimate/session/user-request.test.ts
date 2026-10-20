// altimate_change - new file
//
// Which user messages are requests. The rule is lesson retrieval's (the prompt loop picks a request's
// lessons by it); the workspace engine's turn boundary reuses it. Each row is the shape one writer
// produces: the user, or the loop writing a message itself.
import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../../src/session/message-v2"
import { requestID } from "../../../src/altimate/session/user-request"

let counter = 0
const next = (prefix: string) => `${prefix}_${String(++counter).padStart(4, "0")}`

function message(role: "user" | "assistant", parts: Record<string, unknown>[], id = next("msg")): MessageV2.WithParts {
  return {
    info: { id, sessionID: "ses_test", role, time: { created: 0 } },
    parts: parts.map((part) => ({ id: next("prt"), sessionID: "ses_test", messageID: id, ...part })),
  } as unknown as MessageV2.WithParts
}

const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra })
const file = (mime: string) => ({ type: "file", mime, url: "file:///tmp/notes.txt", filename: "notes.txt" })
const ORIGINAL = "msg_original"

describe("requestID", () => {
  const rows: [string, MessageV2.WithParts, "own" | typeof ORIGINAL | undefined][] = [
    ["a user's text", message("user", [text("connect jira")]), "own"],
    [
      "a user's text beside synthetic file expansions",
      message("user", [text("read this"), text("<file contents>", { synthetic: true }), file("text/plain")]),
      "own",
    ],
    ["a user's file alone", message("user", [file("text/plain")]), "own"],
    [
      "the subtask summary the loop writes",
      message("user", [text("Summarize the task tool output above and continue with your task.", { synthetic: true })]),
      undefined,
    ],
    ["the validator retry the loop writes", message("user", [text("validator failures: ...", { synthetic: true })]), undefined],
    ["the compaction marker", message("user", [{ type: "compaction", auto: true }]), undefined],
    ["the continue message after compaction", message("user", [text("Continue if you have next steps", { synthetic: true })]), undefined],
    ["a message whose only text is ignored", message("user", [text("reminder", { ignored: true })]), undefined],
    [
      "a replay stamped with the request it replays",
      message("user", [text("connect jira", { metadata: { learnOriginalMessage: ORIGINAL } })]),
      ORIGINAL,
    ],
    [
      "an attachment-only replay: its file, and the stamp on an ignored carrier",
      message("user", [
        file("text/plain"),
        text("", { synthetic: true, ignored: true, metadata: { learnOriginalMessage: ORIGINAL } }),
      ]),
      ORIGINAL,
    ],
    ["an unstamped replay (lessons not delivered)", message("user", [text("connect jira")]), "own"],
    ["an assistant message", message("assistant", [text("done")]), undefined],
  ]
  for (const [name, msg, expected] of rows) {
    test(name, () => {
      expect(requestID(msg)).toBe(expected === "own" ? msg.info.id : expected)
    })
  }
})

// A child task that ends on an error (for example the request at its step cap) or with
// no text used to reach the parent as an empty <task_result>, which reads as "done, nothing found".
import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { initTool } from "../altimate/tool-fixture"

const cases = [
  {
    name: "an errored child with earlier text returns the error and that text",
    error: { name: "UnknownError", data: { message: "Could not get a response from the agent." } },
    text: "",
    earlier: "Found 3 candidates so far.",
    contains: [
      "Task stopped with an error before giving a final answer (UnknownError: Could not get a response from the agent.).",
      "Its last written text, which may be incomplete:",
      "Found 3 candidates so far.",
    ],
  },
  {
    name: "a child with no text at all says so",
    error: undefined,
    text: "",
    earlier: undefined,
    contains: [
      "Task ended without a final text answer.",
      "It wrote no text. Resume it with task_id or treat its work as unfinished.",
    ],
  },
  {
    name: "a child with a final answer is passed through unchanged",
    error: undefined,
    text: "Child answer",
    earlier: undefined,
    contains: ["<task_result>\nChild answer\n</task_result>"],
  },
  {
    name: "an errored child with final text keeps the error status",
    error: { name: "UnknownError", data: { message: "Could not get a response from the agent." } },
    text: "Checked 2 of 5 tables.",
    earlier: undefined,
    contains: [
      "Task stopped with an error before giving a final answer (UnknownError: Could not get a response from the agent.).",
      "Its last written text, which may be incomplete:",
      "Checked 2 of 5 tables.",
    ],
  },
  {
    name: "a provider error message is redacted before it reaches the parent",
    error: {
      name: "APIError",
      data: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
    },
    text: "",
    earlier: undefined,
    contains: ["Task stopped with an error before giving a final answer (APIError: Incorrect API key provided: [REDACTED])."],
    excludes: ["abcdefghijklmnopqrstuvwxyz123456"],
  },
  {
    name: "text written before a compaction and its continuation turn is recovered",
    error: { name: "UnknownError", data: { message: "Could not get a response from the agent." } },
    text: "",
    earlier: "Found 3 candidates so far.",
    compacted: true,
    contains: ["Its last written text, which may be incomplete:", "Found 3 candidates so far."],
    excludes: ["Summary of the work so far.", "Continue if you have next steps"],
  },
  {
    name: "text from an earlier prompt of the child session is never used",
    error: undefined,
    text: "",
    earlier: "Findings of an earlier prompt.",
    earlierPrompt: true,
    contains: ["It wrote no text. Resume it with task_id or treat its work as unfinished."],
    excludes: ["Findings of an earlier prompt."],
  },
] as const satisfies readonly {
  name: string
  error?: { name: string; data: { message: string } }
  text: string
  earlier?: string
  compacted?: boolean
  earlierPrompt?: boolean
  contains: readonly string[]
  excludes?: readonly string[]
}[]

for (const item of cases) {
  test(item.name, async () => {
    const parentID = SessionID.make("ses_empty_parent")
    const childID = SessionID.make("ses_empty_child")
    const messageID = MessageID.make("msg_empty_parent")
    const agent = { name: "general", mode: "subagent", permission: [], options: {} } as unknown as Agent.Info
    let childPromptID: MessageID | undefined
    const mocks = [
      spyOn(Agent, "list").mockResolvedValue([agent]),
      spyOn(Agent, "get").mockResolvedValue(agent),
      spyOn(Config, "get").mockResolvedValue({}),
      spyOn(Session, "get").mockImplementation(
        Object.assign(
          async (id: SessionID) =>
            ({
              id,
              permission: [],
              ...(id === childID ? { parentID, metadata: { taskAgent: "general" } } : {}),
            }) as never,
          Session.get,
        ),
      ),
      spyOn(MessageV2, "get").mockResolvedValue({
        info: { role: "assistant", parentID: messageID, modelID: "test", providerID: "test" },
        parts: [],
      } as never),
      // Newest first, like the real stream: the failed final message, then earlier ones.
      spyOn(MessageV2, "stream").mockImplementation(async function* () {
        if ("compacted" in item) {
          // After an automatic compaction the prompt continues under a synthetic continue turn.
          yield { info: { id: "msg_continue", role: "assistant", parentID: "msg_continue" }, parts: [] } as never
          yield {
            info: { id: "msg_continue", role: "user" },
            parts: [{ type: "text", synthetic: true, text: "Continue if you have next steps" }],
          } as never
          yield {
            info: { id: "msg_summary", role: "assistant", parentID: "msg_compaction", summary: true },
            parts: [{ type: "text", text: "Summary of the work so far." }],
          } as never
          yield { info: { id: "msg_compaction", role: "user" }, parts: [{ type: "compaction", auto: true }] } as never
        } else {
          yield { info: { id: "msg_final", role: "assistant", parentID: childPromptID }, parts: [] } as never
        }
        if ("earlierPrompt" in item) {
          // The current prompt's user message was never written; older messages belong to an earlier prompt.
          yield { info: { id: "msg_old_user", role: "user" }, parts: [] } as never
          yield {
            info: { id: "msg_old", role: "assistant", parentID: "msg_older" },
            parts: [{ type: "text", text: item.earlier }],
          } as never
          yield { info: { id: "msg_older", role: "user" }, parts: [] } as never
          return
        }
        if (item.earlier)
          yield {
            info: { id: "msg_earlier", role: "assistant", parentID: childPromptID },
            parts: [{ type: "text", text: item.earlier }],
          } as never
        yield { info: { id: childPromptID, role: "user" }, parts: [] } as never
      } as never),
    ]
    const promptOps: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
      prompt: (input) =>
        Effect.sync(() => {
          childPromptID = input.messageID
          return {
            info: { role: "assistant", ...(item.error ? { error: item.error } : {}) },
            parts: item.text ? [{ type: "text", text: item.text }] : [],
          } as unknown as MessageV2.WithParts
        }),
    }
    try {
      const tool = await initTool(TaskTool)
      const result = await tool.execute(
        { description: "Inspect records", prompt: "Summarize the records", subagent_type: "general", task_id: childID },
        {
          sessionID: parentID,
          messageID,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          extra: { promptOps, bypassAgentCheck: true },
        },
      )
      for (const text of item.contains) expect(result.output).toContain(text)
      for (const text of "excludes" in item ? item.excludes : []) expect(result.output).not.toContain(text)
      if (item.text && !item.error) expect(result.output).not.toContain("Task ended without")
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })
}

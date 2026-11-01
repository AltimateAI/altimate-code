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
] as const

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
      // Newest first, like the real stream: the failed final message, then an earlier one with text.
      spyOn(MessageV2, "stream").mockImplementation(async function* () {
        yield { info: { role: "assistant", parentID: childPromptID }, parts: [] } as never
        if (item.earlier)
          yield {
            info: { role: "assistant", parentID: childPromptID },
            parts: [{ type: "text", text: item.earlier }],
          } as never
        yield { info: { role: "user" }, parts: [] } as never
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
      if (item.text) expect(result.output).not.toContain("Task ended without")
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })
}

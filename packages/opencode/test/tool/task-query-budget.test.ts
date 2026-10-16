import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { RunBudget } from "../../src/altimate/run-budget"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { initTool } from "../altimate/tool-fixture"

for (const fails of [false, true]) {
  test(`task inherits the parent query cutoff and releases it after ${fails ? "failure" : "completion"}`, async () => {
    const parentID = SessionID.make("ses_query_parent")
    const childID = SessionID.make("ses_query_child")
    const messageID = MessageID.make("msg_query_parent")
    const agent = { name: "general", mode: "subagent", permission: [], options: {} } as unknown as Agent.Info
    const list = spyOn(Agent, "list").mockResolvedValue([agent])
    const getAgent = spyOn(Agent, "get").mockResolvedValue(agent)
    const config = spyOn(Config, "get").mockResolvedValue({})
    const getSession = spyOn(Session, "get").mockImplementation(Object.assign(async (id: SessionID) => ({
      id,
      permission: [],
      ...(id === childID ? { parentID, metadata: { taskAgent: "general" } } : {}),
    }) as never, Session.get))
    const getMessage = spyOn(MessageV2, "get").mockResolvedValue({
      info: { role: "assistant", parentID: messageID, modelID: "test", providerID: "test" },
      parts: [],
    } as never)
    const release = RunBudget.registerQueryDeadline(parentID, 10_000)
    const promptOps: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
      prompt: (input) => Effect.sync(() => {
        expect(input.sessionID).toBe(childID)
        expect(RunBudget.queryDeadline(childID)).toBe(10_000)
        if (fails) throw new Error("Child stopped")
        return { info: {}, parts: [{ type: "text", text: "Child answer" }] } as MessageV2.WithParts
      }),
    }
    try {
      const tool = await initTool(TaskTool)
      const result = tool.execute({
        description: "Inspect records", prompt: "Summarize the records", subagent_type: "general", task_id: childID,
      }, {
        sessionID: parentID, messageID, agent: "build", abort: new AbortController().signal,
        messages: [], extra: { promptOps, bypassAgentCheck: true },
      })
      if (fails) await expect(result).rejects.toThrow("Child stopped")
      else expect((await result).output).toContain("Child answer")
      expect(RunBudget.queryDeadline(childID)).toBeUndefined()
      expect(RunBudget.queryDeadline(parentID)).toBe(10_000)
    } finally {
      release()
      getMessage.mockRestore()
      getSession.mockRestore()
      config.mockRestore()
      getAgent.mockRestore()
      list.mockRestore()
    }
  })
}

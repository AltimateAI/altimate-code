import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { SkillTool } from "../../src/tool/skill"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as Provider.Model

// ── Observation mask: toModelMessages ──────────────────────────────────────

describe("observation mask in toModelMessages", () => {
  const sessionID = "session"

  function userInfo(id: string): MessageV2.User {
    return {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.User
  }

  function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
    return {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID,
      modelID: model.api.id,
      providerID: model.providerID,
      mode: "",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as MessageV2.Assistant
  }

  function basePart(messageID: string, id: string) {
    return { id, sessionID, messageID }
  }

  test("uses observation_mask when tool output is compacted and mask is present", () => {
    const mask = '[Tool output cleared — bash(cmd: "ls /tmp") returned 5 lines, 42 B — "file1.txt"]'
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user"),
        parts: [
          { ...basePart("m-user", "u1"), type: "text", text: "run tool" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", "m-user"),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls /tmp" },
              output: "original output that was pruned",
              title: "Bash",
              metadata: { observation_mask: mask },
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool") as any
    expect(toolMsg).toBeDefined()
    const toolResult = toolMsg.content[0]
    expect(toolResult.output).toEqual({ type: "text", value: mask })
  })

  test("falls back to generic placeholder when compacted but no observation_mask", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user"),
        parts: [
          { ...basePart("m-user", "u1"), type: "text", text: "run tool" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", "m-user"),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool") as any
    const toolResult = toolMsg.content[0]
    expect(toolResult.output).toEqual({ type: "text", value: "[Old tool result content cleared]" })
  })
})

// ── Observation mask: prune e2e ────────────────────────────────────────────

describe("prune sets observation_mask and toModelMessages surfaces it", () => {
  test("end-to-end: prune → observation_mask stored → toModelMessages uses it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        // ── Turn 1 (old): user message ──
        const userMsg1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg1.id,
          sessionID,
          type: "text",
          text: "Read a big file",
        })

        // ── Turn 1 (old): assistant with large tool output ──
        const assistantMsg1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          parentID: userMsg1.id,
          time: { created: Date.now() },
          finish: "end_turn",
        } as MessageV2.Assistant)

        // Large tool output — must exceed PRUNE_PROTECT (40k tokens ~ 150k chars)
        const largeOutput = "SELECT col FROM table;\n".repeat(10_000)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg1.id,
          sessionID,
          type: "tool",
          callID: "call-big",
          tool: "read",
          state: {
            status: "completed",
            input: { file_path: "/models/stg_orders.sql" },
            output: largeOutput,
            title: "Read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        } as any)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg1.id,
          sessionID,
          type: "text",
          text: "I read the file.",
        })

        // ── Turn 2 (middle): user + assistant ──
        const userMsg2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg2.id,
          sessionID,
          type: "text",
          text: "Now do something else",
        })

        const assistantMsg2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          parentID: userMsg2.id,
          time: { created: Date.now() },
          finish: "end_turn",
        } as MessageV2.Assistant)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg2.id,
          sessionID,
          type: "text",
          text: "OK, let me continue.",
        })

        // ── Turn 3 (recent): user + assistant with small tool ──
        // Prune skips the 2 most recent turns, so we need 3 turns total
        const userMsg3 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg3.id,
          sessionID,
          type: "text",
          text: "One more thing",
        })

        const assistantMsg3 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          parentID: userMsg3.id,
          time: { created: Date.now() },
          finish: "end_turn",
        } as MessageV2.Assistant)

        // Small recent tool output — should be protected from pruning
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg3.id,
          sessionID,
          type: "tool",
          callID: "call-small",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            output: "hi",
            title: "Bash",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        } as any)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg3.id,
          sessionID,
          type: "text",
          text: "Done.",
        })

        // ── Run prune ──
        await SessionCompaction.prune({ sessionID })

        // ── Verify the old tool part was pruned with observation_mask ──
        const msgs = await Session.messages({ sessionID })
        const allParts = msgs.flatMap((m) => m.parts)
        const prunedPart = allParts.find(
          (p) => p.type === "tool" && (p as any).callID === "call-big",
        ) as MessageV2.ToolPart

        expect(prunedPart).toBeDefined()
        expect(prunedPart.state.status).toBe("completed")
        if (prunedPart.state.status !== "completed") throw new Error("unreachable")

        expect(prunedPart.state.time.compacted).toBeDefined()
        expect(prunedPart.state.time.compacted).toBeGreaterThan(0)

        const mask = prunedPart.state.metadata?.observation_mask as string
        expect(mask).toBeDefined()
        expect(mask).toContain("[Tool output cleared")
        expect(mask).toContain("read")
        expect(mask).toContain("lines")

        // ── Verify toModelMessages surfaces the mask, not the fallback ──
        const modelMsgs = MessageV2.toModelMessages(msgs, model)
        const toolResults = modelMsgs
          .filter((m) => m.role === "tool")
          .flatMap((m) => (m as any).content)
          .filter((c: any) => c.type === "tool-result")

        const bigToolResult = toolResults.find((c: any) => c.toolCallId === "call-big")
        expect(bigToolResult).toBeDefined()

        const outputValue =
          typeof bigToolResult.output === "string"
            ? bigToolResult.output
            : bigToolResult.output?.value ?? bigToolResult.output
        expect(outputValue).toContain("[Tool output cleared")
        expect(outputValue).not.toBe("[Old tool result content cleared]")

        // Recent tool should NOT be pruned
        const smallToolResult = toolResults.find((c: any) => c.toolCallId === "call-small")
        expect(smallToolResult).toBeDefined()
        const smallOutput =
          typeof smallToolResult.output === "string"
            ? smallToolResult.output
            : smallToolResult.output?.value ?? smallToolResult.output
        expect(smallOutput).toBe("hi")
      },
    })
  })
})

// ── System prompt: no <directories> block ──────────────────────────────────

describe("system prompt does not contain directories block", () => {
  test("environment() output has no <directories> tag", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parts = await SystemPrompt.environment(model)
        const joined = parts.join("\n")
        expect(joined).not.toContain("<directories>")
        expect(joined).not.toContain("</directories>")
        expect(joined).toContain("<env>")
        expect(joined).toContain("Working directory:")
        expect(joined).toContain("Today's date:")
      },
    })
  })
})

// ── Skill tool: compact XML format ─────────────────────────────────────────

describe("skill tool uses compact XML format", () => {
  test("description uses single-line <skill name=...> format without <location>", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: A test skill for validation.
---

# Test Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()

          // Compact format: single-line with name attribute
          expect(tool.description).toContain(
            '<skill name="test-skill">A test skill for validation.</skill>',
          )

          // Old verbose format should NOT be present
          expect(tool.description).not.toContain("<name>test-skill</name>")
          expect(tool.description).not.toContain("<location>")
          expect(tool.description).not.toContain("</location>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("multiple skills use compact format with no location URLs", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, desc] of [
          ["skill-alpha", "First skill"],
          ["skill-beta", "Second skill"],
          ["skill-gamma", "Third skill"],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()

          expect(tool.description).toContain('<skill name="skill-alpha">First skill</skill>')
          expect(tool.description).toContain('<skill name="skill-beta">Second skill</skill>')
          expect(tool.description).toContain('<skill name="skill-gamma">Third skill</skill>')

          // No multi-line skill blocks
          expect(tool.description).not.toMatch(/<skill>\s*\n/)
          // No location tags
          expect(tool.description).not.toContain("<location>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// ── createObservationMask ──────────────────────────────────────────────────

describe("createObservationMask", () => {
  test("produces mask with tool name, args, line count, byte size, and preview", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool" as const,
      tool: "read",
      callID: "call-1",
      state: {
        status: "completed" as const,
        input: { file_path: "/models/stg_orders.sql" },
        output: "SELECT order_id, customer_id\nFROM raw.orders\nWHERE status = 'completed'",
        title: "Read",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as unknown as MessageV2.ToolPart

    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("[Tool output cleared")
    expect(mask).toContain("read")
    expect(mask).toContain("file_path")
    expect(mask).toContain("3 lines")
    expect(mask).toContain("SELECT order_id")
  })

  test("handles empty output gracefully", () => {
    const part = {
      id: "part-2",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "tool" as const,
      tool: "bash",
      callID: "call-2",
      state: {
        status: "completed" as const,
        input: { command: "true" },
        output: "",
        title: "Bash",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as unknown as MessageV2.ToolPart

    const mask = SessionCompaction.createObservationMask(part)
    expect(mask).toContain("[Tool output cleared")
    expect(mask).toContain("bash")
    expect(mask).toContain("1 lines")
    expect(mask).toContain("0 B")
  })
})

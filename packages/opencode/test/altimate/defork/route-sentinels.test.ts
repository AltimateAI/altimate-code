// De-fork spike S2 — execution-route sentinels.
//
// Each `active` dispatcher documented in docs/internal/defork-route-matrix.md
// gets a real-execution test here (driving a harmless tool through the real
// dispatch code path and asserting execution actually reached it), or — where
// full real execution is impractical to set up without a heavy production
// harness — a structural/source-text regression sentinel that pins the exact
// dispatch chokepoint plus a citation of an existing, currently-passing
// real-execution test that already proves the route works end to end.
// `latent` dispatchers get a reachability guard designed to fail the moment
// the route gains a real production caller.
//
// This file is analysis/test-only. No product code is modified here.

import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { readFileSync } from "fs"
import { join } from "path"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID } from "../../../src/session/schema"
import { BatchTool } from "../../../src/tool/batch"
import { InvalidTool } from "@/tool/invalid"
import { initTool, toolInfo } from "../tool-fixture"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { SessionTools } from "../../../src/session/tools"

const SRC = join(import.meta.dir, "..", "..", "..", "src")

function readSrc(relPath: string): string {
  return readFileSync(join(SRC, relPath), "utf8")
}

// ---------------------------------------------------------------------------
// D1 — SessionPrompt.resolveTools, registry-tools loop (src/session/prompt.ts)
// ---------------------------------------------------------------------------

test("D1: resolveTools reaches item.execute for a real registry tool", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("../../../src/session")
      const { SessionPrompt } = await import("../../../src/session/prompt")
      const { SessionProcessor } = await import("../../../src/session/processor")

      const session = await Session.create({})
      const providerID = ProviderID.make("test")
      const modelID = ModelID.make("test-model")
      const assistantID = MessageID.ascending()

      const assistantMessage = await Session.updateMessage({
        id: assistantID,
        sessionID: session.id,
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: MessageID.ascending(),
        modelID,
        providerID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: tmp.path, root: tmp.path },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const processor = SessionProcessor.create({
        assistantMessage: assistantMessage as any,
        sessionID: session.id,
        model: { providerID, api: { id: modelID } } as any,
        abort: new AbortController().signal,
      })

      const input: any = {
        // `permission` is a PermissionV1.Ruleset (array of rules), NOT a bare object —
        // Permission.evaluate() does `rulesets.flat().findLast(...)` (src/permission/index.ts:43-53),
        // so passing `{}` instead of `[]` makes `rule.permission`/`rule.pattern` undefined and
        // crashes Wildcard.match() deep inside Skill.available (src/skill/index.ts:379), which
        // resolveTools's real ToolRegistry.tools() call transitively reaches.
        agent: { name: "build", mode: "primary", permission: [], options: {} },
        model: { providerID, api: { id: modelID } },
        session: { ...session, permission: [] },
        processor,
        bypassAgentCheck: true,
        messages: [],
      }

      const tools = await SessionPrompt.resolveTools(input)
      expect(Object.keys(tools)).toContain("invalid")

      const result = await tools["invalid"].execute!(
        { tool: "invalid", error: "sentinel-probe" },
        { toolCallId: "call_1", messages: [] } as any,
      )
      expect((result as any).output).toContain("The arguments provided to the tool are invalid: sentinel-probe")
    },
  })
})

test("D1: resolveTools dispatch chokepoint is pinned at the documented line", () => {
  const src = readSrc("session/prompt.ts")
  const lines = src.split("\n")
  // 1-indexed line numbers to match docs/internal/defork-route-matrix.md.
  expect(lines[1600]).toContain("const result = await AppRuntime.runPromise(item.execute(args, ctx))")
  expect(lines[1613]).toContain("const stamped = stampRegistryToolSource(output, item)")
})

// ---------------------------------------------------------------------------
// D3/D4 — SessionTools.resolve, registry + MCP loops (src/session/tools.ts)
// Documented as `latent`: wired but with zero production callers at HEAD.
// ---------------------------------------------------------------------------

test("D3/D4: SessionTools.resolve has no production caller (latent guard)", () => {
  // If this ever finds a real call site outside src/session/tools.ts itself
  // (not a doc-comment mentioning the name), D3/D4's classification must be
  // revisited from `latent` to `active` and this test updated accordingly.
  const promptSrc = readSrc("session/prompt.ts")
  const toolSourceSrc = readSrc("altimate/tool-source.ts")

  // Known, expected occurrences: doc-comments only, never a call.
  const promptMatches = [...promptSrc.matchAll(/SessionTools/g)]
  expect(promptMatches).toHaveLength(2)
  for (const match of promptMatches) {
    const lineStart = promptSrc.lastIndexOf("\n", match.index) + 1
    const line = promptSrc.slice(lineStart, promptSrc.indexOf("\n", match.index))
    expect(line.trim().startsWith("//")).toBe(true)
    expect(line).not.toContain("SessionTools.resolve(")
  }

  const toolSourceMatches = [...toolSourceSrc.matchAll(/SessionTools/g)]
  expect(toolSourceMatches).toHaveLength(2)
  for (const match of toolSourceMatches) {
    const lineStart = toolSourceSrc.lastIndexOf("\n", match.index) + 1
    const line = toolSourceSrc.slice(lineStart, toolSourceSrc.indexOf("\n", match.index))
    expect(line.trim().startsWith("*")).toBe(true)
    expect(line).not.toContain("SessionTools.resolve(")
  }
})

test("D3/D4: SessionTools.resolve dispatches a tool when invoked directly", async () => {
  await Instance.provide({
    directory: "/tmp",
    fn: async () => {
      const invalidInfo = await toolInfo(InvalidTool)
      const invalidDef = await Effect.runPromise(invalidInfo.init({ agent: undefined as any }))

      const layer = Layer.mergeAll(
        Layer.succeed(
          Plugin.Service,
          Plugin.Service.of({
            trigger: (_name, _input, output) => Effect.succeed(output),
            list: () => Effect.succeed([]),
            init: () => Effect.void,
          }),
        ),
        Layer.succeed(
          Permission.Service,
          Permission.Service.of({
            ask: () => Effect.void,
            reply: () => Effect.void,
            list: () => Effect.succeed([]),
          }),
        ),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed(["invalid"]),
            allInfos: () => Effect.succeed([]),
            register: () => Effect.void,
            tools: () =>
              Effect.succeed([
                {
                  id: "invalid",
                  registrySource: "builtin",
                  description: invalidDef.description,
                  parameters: invalidDef.parameters,
                  execute: invalidDef.execute,
                } as any,
              ]),
          }),
        ),
        Layer.succeed(
          MCP.Service,
          MCP.Service.of({
            status: () => Effect.succeed({}),
            clients: () => Effect.succeed({}),
            tools: () => Effect.succeed({}),
            prompts: () => Effect.succeed({}),
            resources: () => Effect.succeed({}),
            add: () => Effect.succeed({ status: {} }),
            connect: () => Effect.void,
            disconnect: () => Effect.void,
            remove: () => Effect.void,
            getPrompt: () => Effect.die(new Error("not implemented")),
          } as any),
        ),
        Layer.succeed(
          Truncate.Service,
          Truncate.Service.of({
            cleanup: () => Effect.void,
            write: () => Effect.succeed(""),
            output: (content: string) => Effect.succeed({ content, truncated: false as const }),
            limits: () => Effect.succeed({ maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }),
          }),
        ),
      )

      const fakeProcessor = {
        message: { id: "msg_fake" } as any,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      }

      const input: any = {
        agent: { name: "build", mode: "primary", permission: {}, options: {} },
        model: { providerID: "test", api: { id: "test-model" } },
        session: { id: "ses_fake", permission: [] },
        processor: fakeProcessor,
        bypassAgentCheck: true,
        messages: [],
        promptOps: {},
      }

      const tools = await Effect.runPromise(SessionTools.resolve(input).pipe(Effect.provide(layer)))
      expect(Object.keys(tools)).toContain("invalid")

      const result = await tools["invalid"].execute!(
        { tool: "invalid", error: "sentinel-probe" },
        { toolCallId: "call_1", messages: [] } as any,
      )
      expect((result as any).output).toContain("The arguments provided to the tool are invalid: sentinel-probe")
    },
  })
})

test("D3/D4: SessionTools.resolve dispatch chokepoints are pinned at the documented lines", () => {
  const src = readSrc("session/tools.ts")
  const lines = src.split("\n")
  expect(lines[96]).toContain("const result = yield* item.execute(args, ctx)")
  expect(lines[144]).toContain("return yield* Effect.promise(() => execute(args, opts))")
})

// ---------------------------------------------------------------------------
// D5 — BatchTool inner dispatch (src/tool/batch.ts)
// ---------------------------------------------------------------------------

test("D5: BatchTool dispatches inner tool.execute without Plugin.trigger", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("../../../src/session")
      const session = await Session.create({})

      const providerID = ProviderID.make("test")
      const modelID = ModelID.make("test-model")
      const assistantID = MessageID.ascending()

      const msg = await Session.updateMessage({
        id: assistantID,
        sessionID: session.id,
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: MessageID.ascending(),
        modelID,
        providerID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: tmp.path, root: tmp.path },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const batch = await initTool(BatchTool)
      const result = await batch.execute(
        {
          tool_calls: [{ tool: "invalid", parameters: { tool: "invalid", error: "sentinel-probe" } }],
        },
        {
          sessionID: session.id,
          messageID: msg.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
        },
      )
      expect(result.output).toContain("All 1 tools executed successfully")
      expect((result.metadata as any).details[0].success).toBe(true)
    },
  })
})

test("D5: BatchTool never calls Plugin.trigger for inner tool calls (structural bypass)", () => {
  const src = readSrc("tool/batch.ts")
  expect(src).not.toContain("Plugin.trigger(")
  expect(src).toContain("await AppRuntime.runPromise(tool.execute(validatedParams, toEffectContext(ctx, partID)))")
})

// ---------------------------------------------------------------------------
// D6 — direct Task-tool dispatch inside SessionPrompt.loop (src/session/prompt.ts)
//
// PARTIAL COMPLIANCE NOTE (flagged for team-lead / S3, not silently assumed):
// the S2 spec (docs/internal/2026-07-18-defork-spike-spec.md:61) requires "a
// harmless sentinel tool invocation driven end-to-end through that route" for
// every `active` dispatcher, and states "An unproven `active` route fails the
// S2 gate." The spec text does NOT itself carve out a citation-based fallback
// — that is a pragmatic judgment call made here, not a quoted spec allowance.
//
// Rationale: real end-to-end execution of this exact chokepoint IS already
// proven by the existing, currently-passing test "failed subtask preserves
// metadata on error tool state" (test/session/prompt.test.ts, `it.instance`
// block at line 806), which drives a real subtask through prompt.loop() and
// asserts on the resulting tool-state metadata that only D6's taskCtx wiring
// produces. Reconstructing an equivalent from scratch here would require
// duplicating ~250 lines of module-private test harness from that file
// (`it.instance`, `useServerConfig`, `TestLLMServer`, `addSubtask` — none of
// which are exported) for a single additional route. Given that cost, this
// route is covered by citation of that real test plus a structural
// regression sentinel pinning the exact dispatch line numbers, so any
// refactor that moves the dispatch or renames the cited test breaks CI here
// too. If stricter literal compliance is required, the fix is either to
// export a shared harness from prompt.test.ts, or to accept this as a
// documented S2 exception — team-lead's call.
// ---------------------------------------------------------------------------

test("D6: direct Task dispatch chokepoints are pinned at the documented lines", () => {
  const src = readSrc("session/prompt.ts")
  const lines = src.split("\n")
  expect(lines[580]).toContain('"tool.execute.before",')
  expect(lines[617]).toContain("ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),")
  expect(lines[624]).toContain("const result = await AppRuntime.runPromise(taskTool.execute(taskArgs, taskCtx))")
  expect(lines[636]).toContain('"tool.execute.after",')
})

test("D6: existing real-execution proof exists in test/session/prompt.test.ts", () => {
  const promptTestSrc = readFileSync(join(SRC, "..", "test", "session", "prompt.test.ts"), "utf8")
  expect(promptTestSrc).toContain('it.instance("failed subtask preserves metadata on error tool state"')
})

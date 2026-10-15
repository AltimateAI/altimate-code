// altimate: ALT-F02
import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Effect, Exit, Logger } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const definition = (id: string, value: string, protectedPlugin = false): Plugin.Generation => ({
  ...PluginPromise.fromPromise({
    id,
    async setup(host) {
      await host.tool.transform((editor) => {
        for (const name of ["sql_execute", "warehouse_add"])
          editor.add({
            name,
            description: name,
            input: { type: "object", properties: {}, additionalProperties: false },
            output: { type: "string" },
            options: { codemode: false },
            execute: async () => ({ output: value }),
          })
      })
    },
  }),
  revision: value,
  protected: protectedPlugin,
})

const execute = (tools: Tool.Interface, name: string) =>
  tools.snapshot().pipe(
    Effect.flatMap((snapshot) =>
      snapshot.execute({
        sessionID: Session.ID.make("ses_host_protection"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_host_protection"),
        call: { type: "tool-call", id: `call_${name}`, name, input: {} },
      }),
    ),
  )

it.live("rejects colliding tools with an error and executes the protected implementation after replay/reload", () => {
  const output: unknown[] = []
  const logger = Logger.map(Logger.formatStructured, (entry) => output.push(entry.message))
  return Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const host = definition("host.required", "host", true)
    const user = definition("user.tools", "user")
    yield* plugins.activate([host, user])
    for (const name of ["sql_execute", "warehouse_add"]) {
      expect((yield* execute(tools, name)).output).toBe("host")
      expect(JSON.stringify(output)).toContain(`Tool ${name} is protected by host plugin host.required`)
    }
    expect(JSON.stringify(output)).toContain("Skipping invalid tool registration")
    yield* tools.reload()
    yield* plugins.activate([host, { ...user, revision: "reload" }])
    expect((yield* execute(tools, "sql_execute")).output).toBe("host")
    expect((yield* execute(tools, "warehouse_add")).output).toBe("host")
    expect((yield* plugins.list()).map((plugin) => plugin.state.status)).toEqual(["active", "active"])
  }).pipe(Effect.provide(Logger.layer([logger])))
})

it.live("preserves stock last-registration behavior when no protected plugin owns the tool", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* plugins.activate([definition("stock", "stock"), definition("user", "user")])
    expect((yield* execute(tools, "sql_execute")).output).toBe("user")
  }),
)

it.live("rebuilds protected tool ownership from surviving registrations", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* plugins.activate([definition("host.required", "host", true), definition("user", "user")])
    expect((yield* execute(tools, "sql_execute")).output).toBe("host")
    yield* plugins.activate([definition("user", "user")])
    expect((yield* execute(tools, "sql_execute")).output).toBe("user")
  }),
)

it.live("propagates a protected setup failure through activation and every readiness wait", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const failing = {
      ...PluginPromise.fromPromise({
        id: "host.required",
        async setup() {
          throw new Error("deliberate setup failure")
        },
      }),
      revision: "broken",
      protected: true,
    }
    const activation = yield* plugins.activate([failing]).pipe(Effect.exit)
    const readiness = yield* plugins.awaitActivation.pipe(Effect.exit)
    for (const exit of [activation, readiness]) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Protected host plugin host.required failed")
        expect(Cause.pretty(exit.cause)).toContain("deliberate setup failure")
      }
    }
    expect((yield* plugins.list())[0]?.state.status).toBe("failed")
    yield* plugins.activate([definition("host.required", "fixed", true)])
    yield* plugins.awaitActivation
    expect((yield* plugins.list())[0]?.state.status).toBe("active")
  }),
)

it.live("keeps ordinary user setup failures nonfatal", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* plugins.activate([{ id: "user", revision: "1", effect: () => Effect.die(new Error("user setup failure")) }])
    yield* plugins.awaitActivation
    expect((yield* plugins.list())[0]?.state.status).toBe("failed")
  }),
)

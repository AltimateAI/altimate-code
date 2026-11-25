// altimate_change — synthetic coverage for thrown tool errors.
import { expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { Telemetry } from "@/altimate/telemetry"
import { MessageID, SessionID } from "@/session/schema"
import { initTool, toolInfo } from "../altimate/tool-fixture"

for (const kind of ["failure", "defect"] as const) {
  test(`Tool.define redacts newly learned credentials in ${kind} and telemetry`, async () => {
    const key = "ALTIMATE_FIXTURE_THROWN_TOKEN"
    const prior = process.env[key]
    const secret = "synthetic-learned-error-credential"
    const events: Parameters<typeof Telemetry.track>[0][] = []
    const track = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      delete process.env[key]
      const tool = await initTool(
        Tool.define(
          "credential_error_fixture",
          Effect.succeed({
            description: "Synthetic error fixture",
            parameters: Schema.Struct({}),
            execute: () =>
              Effect.gen(function* () {
                process.env[key] = secret
                const error = new Error(`Fixture failed: ${secret}`, { cause: new Error(secret) })
                return yield* kind === "failure" ? (Effect.fail(error) as Effect.Effect<never>) : Effect.die(error)
              }),
          }),
        ),
      )
      const error = await tool
        .execute(
          {},
          {
            sessionID: SessionID.make("ses_fixture"),
            messageID: MessageID.make("msg_fixture"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
          },
        )
        .catch((error) => error)
      expect(String(error)).toContain("Fixture failed: [REDACTED]")
      expect(String(error)).not.toContain(secret)
      expect((error as Error).cause).toMatchObject({ message: "[REDACTED]" })
      expect(JSON.stringify(events)).not.toContain(secret)
      expect(events.some((event) => event.type === "tool_call" && event.error?.includes("[REDACTED]"))).toBe(true)
    } finally {
      track.mockRestore()
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  })
}

// External cancellation must run the completion observer even when recovery cannot run.
for (const mode of ["fiber", "signal"] as const) {
  test(`Tool.define completes trace and telemetry on external ${mode} interruption`, async () => {
    const Debug = await import("@/altimate/debug/mode")
    const completed: unknown[] = []
    const events: Parameters<typeof Telemetry.track>[0][] = []
    const trace = spyOn(Debug, "traceToolCall").mockImplementation(() => (...args) => {
      completed.push(args)
    })
    const track = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    const ready = Promise.withResolvers<void>()
    try {
      const info = await toolInfo(
        Tool.define(
          "interrupt_fixture",
          Effect.succeed({
            description: "Synthetic interruption fixture",
            parameters: Schema.Struct({}),
            execute: () =>
              Effect.gen(function* () {
                ready.resolve()
                return yield* Effect.never
              }),
          }),
        ),
      )
      const tool = await Effect.runPromise(info.init())
      const controller = new AbortController()
      const execute = tool.execute(
        {},
        {
          sessionID: SessionID.make("ses_fixture"),
          messageID: MessageID.make("msg_fixture"),
          agent: "build",
          abort: controller.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      if (mode === "fiber") {
        const fiber = Effect.runFork(execute)
        await ready.promise
        await Effect.runPromise(Fiber.interrupt(fiber))
        const exit = await Effect.runPromise(Fiber.await(fiber))
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      } else {
        const result = Effect.runPromiseExit(execute, { signal: controller.signal })
        await ready.promise
        controller.abort()
        const exit = await result
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      expect(completed).toEqual([["error", expect.any(String)]])
      expect(events.filter((event) => event.type === "tool_call" && event.status === "error")).toHaveLength(1)
    } finally {
      trace.mockRestore()
      track.mockRestore()
    }
  })
}

for (const nested of [false, true]) {
  test(`Tool.define preserves safe DOMException behavior (nested cause: ${nested})`, async () => {
    const key = "ALTIMATE_FIXTURE_DOM_TOKEN"
    const prior = process.env[key]
    const secret = "synthetic-host-error-credential"
    try {
      process.env[key] = secret
      const tool = await initTool(
        Tool.define(
          "host_error_fixture",
          Effect.succeed({
            description: "Synthetic host error fixture",
            parameters: Schema.Struct({}),
            execute: () =>
              Effect.sync(() => {
                const error = new DOMException(`Fixture failed: ${secret}`, "AbortError")
                if (nested) Object.defineProperty(error, "cause", { value: new Error(secret), configurable: true })
                throw error
              }),
          }),
        ),
      )
      const error = await tool
        .execute(
          {},
          {
            sessionID: SessionID.make("ses_fixture"),
            messageID: MessageID.make("msg_fixture"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
          },
        )
        .catch((error) => error)
      expect(error).toBeInstanceOf(DOMException)
      expect(error.name).toBe("AbortError")
      expect(error.code).toBe(DOMException.ABORT_ERR)
      expect(String(error)).toBe("AbortError: Fixture failed: [REDACTED]")
      if (nested) expect(error.cause.message).toBe("[REDACTED]")
    } finally {
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  })
}

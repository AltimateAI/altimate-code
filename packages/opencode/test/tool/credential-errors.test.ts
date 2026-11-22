// altimate_change — synthetic coverage for thrown tool errors.
import { expect, spyOn, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { Telemetry } from "@/altimate/telemetry"
import { MessageID, SessionID } from "@/session/schema"
import { initTool } from "../altimate/tool-fixture"

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

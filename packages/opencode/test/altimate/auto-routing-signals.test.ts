import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { RoutingSignals } from "../../src/altimate/auto/routing-signals"

const toolMsg = (toolName: string, type: string, value: string): ModelMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c", toolName, output: { type, value } }],
  }) as unknown as ModelMessage

const base = { providerID: "altimate-backend", modelID: "altimate-auto", agentName: "build" }

describe("RoutingSignals", () => {
  test("is a no-op for other providers", () => {
    const opts = { openai: { a: 1 } }
    expect(RoutingSignals.compute({ ...base, providerID: "openai", messages: [] })).toBeUndefined()
    expect(RoutingSignals.attach(opts, { ...base, providerID: "openai", messages: [] })).toBe(opts)
  })

  test("omits tool signals when no tool result exists", () => {
    const r = RoutingSignals.compute({ ...base, messages: [{ role: "user", content: "hi" }] })!
    expect(r).toEqual({ tier: "auto", agent_role: "build", has_error_ctx: false, has_code_ctx: false })
  })

  test("counts consecutive trailing tool failures", () => {
    const r = RoutingSignals.compute({
      ...base,
      messages: [toolMsg("bash", "text", "ok"), toolMsg("bash", "error-text", "boom"), toolMsg("bash", "error-text", "boom")],
    })!
    expect(r.last_tool_ok).toBe(false)
    expect(r.retry_count).toBe(2)
    expect(r.has_error_ctx).toBe(true)
  })

  test("success resets streak; code context from edit tool", () => {
    const r = RoutingSignals.compute({
      ...base,
      modelID: "altimate-max",
      agentName: "plan",
      messages: [toolMsg("bash", "error-text", "x"), toolMsg("edit", "text", "done")],
    })!
    expect(r).toMatchObject({ tier: "max", agent_role: "plan", last_tool_ok: true, retry_count: 0, has_code_ctx: true })
  })

  test("ignores unknown tiers and roles", () => {
    const r = RoutingSignals.compute({ ...base, modelID: "altimate-default", agentName: "explore", messages: [] })!
    expect(r).toEqual({})
  })

  test("attach nests routing under extra_body and preserves existing options", () => {
    const out = RoutingSignals.attach(
      { "altimate-backend": { extra_body: { foo: 1 }, keep: true } },
      { ...base, messages: [{ role: "user", content: "hi" }] },
    )
    expect(out["altimate-backend"].keep).toBe(true)
    expect(out["altimate-backend"].extra_body.foo).toBe(1)
    expect(out["altimate-backend"].extra_body.routing.tier).toBe("auto")
  })
})

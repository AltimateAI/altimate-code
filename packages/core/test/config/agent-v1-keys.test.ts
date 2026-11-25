import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigAgentV1 } from "../../src/v1/config/agent"

const decode = Schema.decodeUnknownSync(ConfigAgentV1.Info)

describe("ConfigAgentV1 top-level keys", () => {
  test("a known key is accepted as itself", () => {
    const agent = decode({ model: "test/model", steps: 3, description: "Known keys only" })
    expect(agent).toMatchObject({ model: "test/model", steps: 3, description: "Known keys only" })
    expect(agent.options).toEqual({})
    expect(ConfigAgentV1.unknownKeys({ model: "test/model", steps: 3 })).toEqual([])
  })

  test("an unknown top-level key is folded into options and can be named", () => {
    const raw = { model: "test/model", budget: 5, audience: "executive" }
    const agent = decode(raw)
    expect(agent.options).toEqual({ budget: 5, audience: "executive" })
    expect(agent).not.toHaveProperty("steps")
    expect(ConfigAgentV1.unknownKeys(raw)).toEqual(["budget", "audience"])
  })

  test("keys nested under options keep working and are not reported", () => {
    const raw = { model: "test/model", options: { audience: "executive", reasoningEffort: "high" } }
    const agent = decode(raw)
    expect(agent.options).toEqual({ audience: "executive", reasoningEffort: "high" })
    expect(ConfigAgentV1.unknownKeys(raw)).toEqual([])
  })

  test("the known-key list is the schema's own", () => {
    expect([...ConfigAgentV1.knownKeys].sort()).toEqual(
      [
        "name",
        "model",
        "variant",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "disable",
        "tools",
      ].sort(),
    )
    expect(ConfigAgentV1.unknownKeys(undefined)).toEqual([])
    expect(ConfigAgentV1.unknownKeys(["budget"])).toEqual([])
  })

  test("every field the schema interprets is decoded as itself, not folded into options", () => {
    const raw = {
      name: "reviewer",
      model: "test/model",
      variant: "high",
      prompt: "Review the change.",
      description: "Reviews changes",
      temperature: 0.2,
      top_p: 0.9,
      mode: "subagent",
      hidden: true,
      color: "#FF5733",
      steps: 3,
      maxSteps: 4,
      options: { audience: "executive" },
      permission: { edit: "deny" },
      disable: false,
      tools: { bash: false },
    }
    expect(ConfigAgentV1.unknownKeys(raw)).toEqual([])
    expect(decode(raw).options).toEqual({ audience: "executive" })
  })
})

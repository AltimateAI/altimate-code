import { expect, test } from "bun:test"
import { isModelMetadataOnly, submissionModel } from "../../src/prompt/model"

const current = { providerID: "local", modelID: "chat" }
const commandAgentModel = { providerID: "local", modelID: "agent" }

test("command model outranks command agent and chat; empty explicit values remain invalid", () => {
  for (const model of ["cloud/command", ""]) {
    expect(
      submissionModel({ shell: false, text: "/test", command: { name: "test", model }, commandAgentModel, current }),
    ).toEqual({ required: true, model: { providerID: model ? "cloud" : "", modelID: model ? "command" : "" } })
  }
  expect(
    submissionModel({ shell: false, text: "/test", command: { name: "test" }, commandAgentModel, current }),
  ).toEqual({ required: true, model: commandAgentModel })
  expect(submissionModel({ shell: false, text: "hello", current })).toEqual({ required: true, model: current })
})

test("only direct MCP admin forms and shell bypass model validation", () => {
  expect(submissionModel({ shell: true, text: "pwd", current })).toEqual({ required: false })
  for (const text of ["/mcps", "/mcps  ", "/mcps enable warehouse", "/mcps disable warehouse"]) {
    expect(submissionModel({ shell: false, text, command: { name: "mcps" }, current })).toEqual({ required: false })
  }
  for (const text of ["/mcps explain", "/mcps enable", "/mcps disable", "/mcps enabled warehouse"]) {
    expect(submissionModel({ shell: false, text, command: { name: "mcps" }, current })).toEqual({
      required: true,
      model: current,
    })
  }
})

test("session model history skips shell and tagged MCP metadata, but preserves literal user prompts", () => {
  expect(isModelMetadataOnly([{ type: "text", synthetic: true, text: "The following tool was executed by the user" }])).toBe(true)
  expect(isModelMetadataOnly([{ type: "text", text: "/mcps", metadata: { modelMetadataOnly: true } }])).toBe(true)
  expect(isModelMetadataOnly([{ type: "text", text: "/mcps" }])).toBe(false)
  expect(isModelMetadataOnly([{ type: "text", text: "The following tool was executed by the user" }])).toBe(false)
})

test("subtask commands validate the parent chat model separately from the task override", () => {
  for (const command of [{ name: "task", model: "task/override", subtask: true }, { name: "task", model: "task/override" }]) {
    expect(submissionModel({ shell: false, text: "/task", command, commandAgentMode: "subagent", current }))
      .toEqual({ required: true, model: { providerID: "task", modelID: "override" }, subtask: true, parent: current })
  }
  expect(submissionModel({ shell: false, text: "/task", command: { name: "task", subtask: false }, commandAgentMode: "subagent", current }))
    .toEqual({ required: true, model: current })
})

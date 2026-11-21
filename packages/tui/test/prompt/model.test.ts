import { expandTrackedPastedText } from "../../src/prompt/part"
import { expect, test } from "bun:test"
import { captureDraftRevision, isModelMetadataOnly, resolveCommandAgent, submissionModel } from "../../src/prompt/model"

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

test("pasted command expansion selects its override and does not exempt indirect MCP forms", () => {
  const placeholder = "[Pasted ~3 lines]"
  for (const pasted of ["/task\nfirst\nsecond", "/mcps explain\nfirst\nsecond"]) {
    const text = expandTrackedPastedText(placeholder, [{ start: 0, end: placeholder.length, text: pasted }])
    const name = text.split("\n")[0].split(" ")[0].slice(1)
    const command = { name, model: "missing/command" }
    expect(submissionModel({ shell: false, text, command, current }))
      .toEqual({ required: true, model: { providerID: "missing", modelID: "command" } })
    expect(text).toBe(pasted)
  }
})

test("command agent resolution prefers exact build, then the builder compatibility alias", () => {
  const build = { name: "build", model: { providerID: "exact", modelID: "model" } }
  const builder = { name: "builder", model: { providerID: "alias", modelID: "model" } }
  expect(resolveCommandAgent([builder, build], "build")).toBe(build)
  expect(resolveCommandAgent([builder], "build")).toBe(builder)
  expect(resolveCommandAgent([builder], "missing")).toBeUndefined()
  expect(submissionModel({ shell: false, text: "/task", command: { name: "task" }, commandAgentModel: resolveCommandAgent([builder], "build")?.model, current }))
    .toEqual({ required: true, model: builder.model })
})


test("a later submit stage detects edits to text, mode, and attachments", () => {
  const draft = { input: "/report", mode: "normal", parts: [{ type: "file", url: "file:///first" }] }
  const changed = captureDraftRevision(() => draft)
  expect(changed()).toBe(false)
  draft.input = "/another"
  expect(changed()).toBe(true)
  draft.input = "/report"
  draft.mode = "shell"
  expect(changed()).toBe(true)
  draft.mode = "normal"
  draft.parts[0].url = "file:///updated"
  expect(changed()).toBe(true)
})

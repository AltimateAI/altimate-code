import { expandEnhancedPrompt, expandPastedTextPlaceholders, expandTrackedPastedText } from "../../src/prompt/part"
import { expect, test } from "bun:test"
import { wrapClientError } from "../../../sdk/js/src/error-interceptor"
import {
  captureDraftRevision,
  catalogGate,
  isModelMetadataOnly,
  acceptSubmissionModel,
  isServerReportedModelError,
  resolveCommandAgent,
  resolveSubmissionModel,
  submissionModel,
} from "../../src/prompt/model"

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
  const revision = captureDraftRevision(() => draft)
  expect(revision.changed()).toBe(false)
  draft.input = "/another"
  expect(revision.changed()).toBe(true)
  draft.input = "/report"
  draft.mode = "shell"
  expect(revision.changed()).toBe(true)
  draft.mode = "normal"
  draft.parts[0].url = "file:///updated"
  expect(revision.changed()).toBe(true)
})


test("the production session-setup guard detects an edit made while creation is pending", async () => {
  const draft = { input: "Original draft", mode: "normal", parts: [] }
  const revision = captureDraftRevision(() => draft)
  const creation = Promise.withResolvers<string>()
  const pending = revision.after(creation.promise)

  draft.input = "Edited draft"
  draft.mode = "shell"
  creation.resolve("ses_created")

  expect(await pending).toEqual({ result: "ses_created", changed: true })
  expect(draft).toEqual({ input: "Edited draft", mode: "shell", parts: [] })
})


test("expands pasted placeholders after enhancement and preserves originals if the rewriter drops one", () => {
  const placeholder = "[Pasted ~10 lines]"
  const parts = [{ type: "text", text: "original pasted text", source: { text: { value: placeholder } } }]
  const originalExpanded = "Review original pasted text"
  const original = `Review ${placeholder}`
  expect(expandEnhancedPrompt(original, `Please review ${placeholder} carefully.`, parts, originalExpanded))
    .toBe("Please review original pasted text carefully.")
  expect(expandEnhancedPrompt(original, "Please review it carefully.", parts, originalExpanded)).toBe(originalExpanded)
})


test("inserts pasted dollar tokens literally without reprocessing inserted markers", () => {
  const first = { type: "text", text: "$& plus [Pasted ~20 lines]", source: { text: { value: "[Pasted ~10 lines]" } } }
  const second = { type: "text", text: "$$ and $'", source: { text: { value: "[Pasted ~20 lines]" } } }
  const original = "[Pasted ~10 lines] [Pasted ~20 lines]"
  expect(expandPastedTextPlaceholders(first.source.text.value, [first])).toBe(first.text)
  expect(expandEnhancedPrompt(original, `Review ${original}`, [first, second], "fallback"))
    .toBe(`Review ${first.text} ${second.text}`)
})

test("keeps the original draft if a pasted marker is ambiguous before or after enhancement", () => {
  const marker = "[Pasted ~10 lines]"
  const part = { type: "text", text: "pasted", source: { text: { value: marker } } }
  expect(expandEnhancedPrompt(`${marker} ${marker}`, marker, [part], "original with literal")).toBe("original with literal")
  expect(expandEnhancedPrompt(marker, `${marker} ${marker}`, [part], "original")).toBe("original")
  expect(expandEnhancedPrompt(`${marker} ${marker}`, `${marker} ${marker}`, [part, part], "two pastes")).toBe("two pastes")
})

test("shell and MCP admin submissions wait only for catalogs, never for model readiness", () => {
  expect(submissionModel({ shell: true, text: "pwd" })).toEqual({ required: false })
  expect(catalogGate({ agentStatus: "ready", needsCommands: false, commandStatus: "loading" })).toBe("ready")
  expect(catalogGate({ agentStatus: "loading", needsCommands: false, commandStatus: "ready" })).toBe("wait")
  expect(catalogGate({ agentStatus: "failed", needsCommands: false, commandStatus: "ready" })).toBe("agents-failed")
  expect(catalogGate({ agentStatus: "ready", needsCommands: true, commandStatus: "loading" })).toBe("wait")
  expect(catalogGate({ agentStatus: "ready", needsCommands: true, commandStatus: "failed" })).toBe("commands-failed")
  expect(catalogGate({ agentStatus: "ready", needsCommands: true, commandStatus: "ready" })).toBe("ready")
})

test("enhancement without pasted text uses the rewritten prompt", () => {
  expect(expandEnhancedPrompt("draft", "rewritten", [], "draft")).toBe("rewritten")
})

test("a server-reported model rejection is not toasted a second time", () => {
  expect(isServerReportedModelError({ name: "ProviderModelNotFoundError", data: { providerID: "x", modelID: "y" } })).toBe(true)
  expect(isServerReportedModelError({ name: "UnknownError", data: { message: "boom" } })).toBe(false)
  expect(isServerReportedModelError(new Error("network"))).toBe(false)
  // The shape the SDK client throws with throwOnError: the body wrapped by wrapClientError.
  const body = { name: "ProviderModelNotFoundError", data: { providerID: "x", modelID: "y" } }
  expect(isServerReportedModelError(wrapClientError(body, new Response(null, { status: 400 }), undefined, { throwOnError: true })))
    .toBe(true)
  expect(isServerReportedModelError(wrapClientError({ name: "UnknownError", data: { message: "boom" } }, new Response(null, { status: 500 }), undefined, { throwOnError: true })))
    .toBe(false)
  expect(isServerReportedModelError(undefined)).toBe(false)
})

test("an unavailable configured model shows the error with its source and opens the picker", () => {
  const run = (valid: boolean, canOverride = true) => {
    const calls = { validated: [] as [string, string | undefined][], picker: 0 }
    const accepted = acceptSubmissionModel({
      model: "missing/model",
      source: "project or global config (model)",
      pickerCanOverride: canOverride,
      validate: (model, source, pickable) => {
        calls.validated.push([model, source])
        expect(pickable).toBe(canOverride)
        return valid
      },
      openPicker: () => calls.picker++,
    })
    return { accepted, ...calls }
  }
  expect(run(false)).toEqual({
    accepted: false,
    validated: [["missing/model", "project or global config (model)"]],
    picker: 1,
  })
  expect(run(true)).toEqual({
    accepted: true,
    validated: [["missing/model", "project or global config (model)"]],
    picker: 0,
  })
  // A command or command-agent model cannot be replaced by a pick, so no picker opens for it.
  expect(run(false, false)).toEqual({
    accepted: false,
    validated: [["missing/model", "project or global config (model)"]],
    picker: 0,
  })
  expect(
    acceptSubmissionModel({ model: undefined, pickerCanOverride: true, validate: () => false, openPicker: () => {} }),
  ).toBe(true)
})

test("each submission model source is named, and only chat-model sources let a pick override", () => {
  const current = { providerID: "chat", modelID: "model" }
  expect(resolveSubmissionModel({ command: { name: "review", model: "x/y" }, current, currentSource: "CLI --model" })).toEqual({
    model: { providerID: "x", modelID: "y" },
    source: 'command "review" config (model)',
    pickerCanOverride: false,
  })
  expect(
    resolveSubmissionModel({ command: { name: "review" }, commandAgent: { name: "explore", model: { providerID: "a", modelID: "b" } }, current }),
  ).toEqual({ model: { providerID: "a", modelID: "b" }, source: 'agent "explore" config (model)', pickerCanOverride: false })
  for (const source of ["CLI --model", 'agent "builder" config (model)', "session history", "project or global config (model)"])
    expect(resolveSubmissionModel({ current, currentSource: source })).toEqual({ model: current, source, pickerCanOverride: true })
})

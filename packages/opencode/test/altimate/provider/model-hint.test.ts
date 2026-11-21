// altimate_change - new file
import { describe, expect, test } from "bun:test"
import {
  modelConfigHint,
  modelNotFoundMessage,
  modelSelectionErrorText,
} from "../../../src/altimate/provider/model-hint"
import { isConfigModelSource } from "@opencode-ai/core/altimate-model-source"

describe("modelSelectionErrorText config advice", () => {
  test("config sources point at the config files", () => {
    for (const source of ["config (model)", 'agent "build" config (model)', 'command "review" config (model)']) {
      expect(modelSelectionErrorText({ providerID: "p", modelID: "m", source })).toContain(modelConfigHint)
    }
  })

  test("non-config sources omit the config-file advice", () => {
    for (const source of ["--model flag", "request (model)", 'subtask "plan" request (model)', "session history"]) {
      const text = modelSelectionErrorText({ providerID: "p", modelID: "m", source })
      expect(text).toContain(`(from ${source})`)
      expect(text).not.toContain(modelConfigHint)
    }
  })

  test("an unknown source keeps the advice", () => {
    expect(modelSelectionErrorText({ providerID: "p", modelID: "m" })).toContain(modelConfigHint)
  })

  test("a source merely mentioning config is not a config source", () => {
    expect(isConfigModelSource("request (model) from config-like flag")).toBe(false)
    expect(isConfigModelSource(undefined)).toBe(false)
    expect(isConfigModelSource('agent "x" config (model)')).toBe(true)
  })

  test("empty value advice names the environment variable only for config sources", () => {
    expect(modelNotFoundMessage("p", "", "config (model)")).toContain("check that the variable is set")
    expect(modelNotFoundMessage("p", "", "--model flag")).not.toContain("variable")
  })
})

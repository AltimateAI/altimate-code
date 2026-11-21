import { describe, expect, test } from "bun:test"
import { ModelMetadata } from "../../../src/altimate/session/model-metadata"
import type { MessageV2 } from "../../../src/session/message-v2"

const text = (value: Partial<MessageV2.TextPart>) =>
  ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "", ...value }) as MessageV2.Part

describe("ModelMetadata.isModelMetadataOnly", () => {
  test("recognizes shell and direct MCP rows", () => {
    expect(
      ModelMetadata.isModelMetadataOnly([text({ synthetic: true, text: "The following tool was executed by the user" })]),
    ).toBe(true)
    expect(ModelMetadata.isModelMetadataOnly([text({ text: "/mcps", metadata: { modelMetadataOnly: true } })])).toBe(true)
  })

  test("keeps ordinary prompts, including user text that quotes the shell marker", () => {
    expect(ModelMetadata.isModelMetadataOnly([text({ text: "hello" })])).toBe(false)
    expect(ModelMetadata.isModelMetadataOnly([text({ text: "The following tool was executed by the user" })])).toBe(false)
    expect(ModelMetadata.isModelMetadataOnly([])).toBe(false)
  })
})

describe("ModelMetadata reported errors", () => {
  test("only errors marked by the reporter count as reported", () => {
    const reported = new Error("reported")
    const unreported = new Error("unreported")
    ModelMetadata.markReported(reported)
    expect(ModelMetadata.wasReported(reported)).toBe(true)
    expect(ModelMetadata.wasReported(unreported)).toBe(false)
    expect(ModelMetadata.wasReported("text")).toBe(false)
    expect(ModelMetadata.wasReported(undefined)).toBe(false)
  })
})

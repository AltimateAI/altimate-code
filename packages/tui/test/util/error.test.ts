import { describe, expect, test } from "bun:test"
// altimate: ALT-F01
import { Identity } from "@opencode/util/identity"
import { cliErrorMessage, errorFormat, errorMessage } from "../../src/util/error"

describe("util.error", () => {
  // altimate: ALT-F01
  test("model lookup errors name the selected host command", () => {
    expect(
      cliErrorMessage({ _tag: "ProviderModelNotFoundError", providerID: "example", modelID: "missing" }),
    ).toContain(`Try: \`${Identity.app} models\` to list available models`)
  })

  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")
  })

  test("never returns bare {} for opaque object errors", () => {
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")
  })
})

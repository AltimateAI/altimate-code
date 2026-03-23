import { describe, test, expect } from "bun:test"
import { FormatError, FormatUnknownError } from "../../src/cli/error"

describe("FormatError: known error types", () => {
  test("MCP.Failed returns helpful message", () => {
    const err = { name: "MCPFailed", data: { name: "my-server" } }
    const result = FormatError(err)
    expect(result).toContain("my-server")
    expect(result).toContain("failed")
  })

  test("Provider.ModelNotFoundError with suggestions", () => {
    const err = {
      name: "ProviderModelNotFoundError",
      data: { providerID: "openai", modelID: "gpt-5", suggestions: ["gpt-4", "gpt-4o"] },
    }
    const result = FormatError(err)
    expect(result).toContain("gpt-5")
    expect(result).toContain("Did you mean")
    expect(result).toContain("gpt-4")
  })

  test("Provider.ModelNotFoundError without suggestions", () => {
    const err = {
      name: "ProviderModelNotFoundError",
      data: { providerID: "openai", modelID: "gpt-5", suggestions: [] },
    }
    const result = FormatError(err)
    expect(result).toContain("gpt-5")
    expect(result).not.toContain("Did you mean")
  })

  test("Provider.InitError returns provider name", () => {
    const err = { name: "ProviderInitError", data: { providerID: "anthropic" } }
    const result = FormatError(err)
    expect(result).toContain("anthropic")
  })

  test("Config.JsonError with message", () => {
    const err = { name: "ConfigJsonError", data: { path: "/home/user/.config/altimate.json", message: "Unexpected token" } }
    const result = FormatError(err)
    expect(result).toContain("altimate.json")
    expect(result).toContain("Unexpected token")
  })

  test("Config.JsonError without message", () => {
    const err = { name: "ConfigJsonError", data: { path: "/path/to/config.json" } }
    const result = FormatError(err)
    expect(result).toContain("config.json")
    expect(result).toContain("not valid JSON")
  })

  test("Config.ConfigDirectoryTypoError", () => {
    const err = {
      name: "ConfigDirectoryTypoError",
      data: { dir: ".openCode", path: "/project/.openCode", suggestion: ".opencode" },
    }
    const result = FormatError(err)
    expect(result).toContain(".openCode")
    expect(result).toContain(".opencode")
    expect(result).toContain("typo")
  })

  test("ConfigMarkdown.FrontmatterError", () => {
    const err = {
      name: "ConfigFrontmatterError",
      data: { path: "CLAUDE.md", message: "CLAUDE.md: Failed to parse YAML frontmatter: invalid key" },
    }
    const result = FormatError(err)
    expect(result).toContain("Failed to parse")
  })

  test("Config.InvalidError with issues", () => {
    const err = {
      name: "ConfigInvalidError",
      data: {
        path: "provider.model",
        message: "Invalid model",
        issues: [{ message: "must be string", path: ["provider", "model"] }],
      },
    }
    const result = FormatError(err)
    expect(result).toContain("provider.model")
    expect(result).toContain("must be string")
  })

  test("Config.InvalidError without path shows generic header", () => {
    const err = {
      name: "ConfigInvalidError",
      data: { path: "config", issues: [] },
    }
    const result = FormatError(err)
    expect(result).toContain("Configuration is invalid")
    // "config" path should not appear as a location qualifier
    expect(result).not.toContain("at config")
  })

  test("UI.CancelledError returns empty string", () => {
    const err = { name: "UICancelledError" }
    const result = FormatError(err)
    expect(result).toBe("")
  })

  test("unknown error returns undefined", () => {
    const err = new Error("random error")
    expect(FormatError(err)).toBeUndefined()
  })

  test("null input returns undefined", () => {
    expect(FormatError(null)).toBeUndefined()
  })
})

describe("FormatUnknownError", () => {
  test("Error with stack returns stack", () => {
    const err = new Error("boom")
    const result = FormatUnknownError(err)
    expect(result).toContain("boom")
    expect(result).toContain("Error")
  })

  test("Error without stack returns name + message", () => {
    const err = new Error("boom")
    err.stack = undefined
    const result = FormatUnknownError(err)
    expect(result).toBe("Error: boom")
  })

  test("plain object is JSON stringified", () => {
    const result = FormatUnknownError({ code: 42, msg: "fail" })
    expect(result).toContain('"code": 42')
    expect(result).toContain('"msg": "fail"')
  })

  test("circular object returns fallback message", () => {
    const obj: any = { a: 1 }
    obj.self = obj
    const result = FormatUnknownError(obj)
    expect(result).toBe("Unexpected error (unserializable)")
  })

  test("string input returns itself", () => {
    expect(FormatUnknownError("something went wrong")).toBe("something went wrong")
  })

  test("number input returns string representation", () => {
    expect(FormatUnknownError(404)).toBe("404")
  })

  test("undefined returns string 'undefined'", () => {
    expect(FormatUnknownError(undefined)).toBe("undefined")
  })

  test("null returns string 'null'", () => {
    expect(FormatUnknownError(null)).toBe("null")
  })
})

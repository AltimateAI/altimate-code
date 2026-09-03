// Regression coverage for `altimate-code auth login <provider>`.
//
// The login positional used to be declared as `[url]` and fed straight into
// `fetch(`${url}/.well-known/opencode`)`, so the natural thing to type —
// `auth login openai`, a provider id the CLI itself prints in `auth list` and
// accepts in `auth logout` — failed with:
//
//   Error: Failed to load auth provider metadata from openai: fetch() URL is invalid
//
// The positional is now `[target]`: an http(s) URL still takes the well-known
// path, anything else is resolved as a provider id (the same path `--provider`
// and the interactive picker use).
import { describe, expect, test } from "bun:test"
import { ProvidersLoginCommand, isAuthProviderUrl, resolveLoginTarget } from "../../src/cli/cmd/providers"

describe("isAuthProviderUrl", () => {
  test("accepts http(s) URLs", () => {
    for (const value of ["https://auth.example.com", "http://localhost:4000", "https://example.com/auth/"]) {
      expect(isAuthProviderUrl(value)).toBe(true)
    }
  })

  test("rejects provider ids and other non-URLs", () => {
    for (const value of ["openai", "anthropic", "github-copilot", "amazon-bedrock", "example.com", "", undefined]) {
      expect(isAuthProviderUrl(value)).toBe(false)
    }
  })

  test("rejects non-http schemes", () => {
    for (const value of ["file:///etc/passwd", "ftp://example.com", "mailto:a@b.c"]) {
      expect(isAuthProviderUrl(value)).toBe(false)
    }
  })
})

describe("resolveLoginTarget", () => {
  test("a provider id goes to the provider path, not a fetch (the reported bug)", () => {
    expect(resolveLoginTarget({ target: "openai" })).toEqual({ kind: "provider", provider: "openai" })
  })

  test("real URLs still take the well-known path", () => {
    expect(resolveLoginTarget({ target: "https://auth.example.com" })).toEqual({
      kind: "url",
      url: "https://auth.example.com",
    })
  })

  test("trailing slashes are stripped from URLs (unchanged behavior)", () => {
    expect(resolveLoginTarget({ target: "https://auth.example.com///" })).toEqual({
      kind: "url",
      url: "https://auth.example.com",
    })
  })

  test("no argument prompts with the picker", () => {
    expect(resolveLoginTarget({})).toEqual({ kind: "picker" })
    expect(resolveLoginTarget({ target: undefined, provider: undefined })).toEqual({ kind: "picker" })
  })

  test("--provider still works on its own", () => {
    expect(resolveLoginTarget({ provider: "anthropic" })).toEqual({ kind: "provider", provider: "anthropic" })
  })

  test("an explicit --provider flag beats the positional", () => {
    expect(resolveLoginTarget({ target: "openai", provider: "anthropic" })).toEqual({
      kind: "provider",
      provider: "anthropic",
    })
  })

  test("a URL positional keeps the well-known path even alongside --provider", () => {
    expect(resolveLoginTarget({ target: "https://auth.example.com", provider: "anthropic" })).toEqual({
      kind: "url",
      url: "https://auth.example.com",
    })
  })
})

describe("ProvidersLoginCommand", () => {
  test("help no longer advertises the positional as a URL", () => {
    expect(ProvidersLoginCommand.command).toBe("login [target]")
  })
})

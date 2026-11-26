import { describe, expect, test } from "bun:test"
import { logoutTarget, logoutTitle, type LogoutProvider } from "../../src/util/logout-target"

const provider = (overrides: Partial<LogoutProvider> & { id: string }): LogoutProvider => ({
  name: overrides.id,
  source: "custom",
  env: [],
  ...overrides,
})

describe("logoutTarget", () => {
  test("no current model means nothing to log out of", () => {
    expect(logoutTarget(undefined, [])).toBeUndefined()
    expect(logoutTitle(undefined)).toBe("Log out")
  })

  test("a current model whose provider is gone from the list has no target", () => {
    expect(logoutTarget({ providerID: "openai" }, [])).toBeUndefined()
  })

  test("the gateway keeps its own sign-out and name", () => {
    const target = logoutTarget({ providerID: "altimate-backend" }, [])
    expect(target?.kind).toBe("gateway")
    expect(logoutTitle(target)).toBe("Log out of Altimate LLM Gateway")
  })

  test("Altimate Base uses the managed sign-out", () => {
    const target = logoutTarget({ providerID: "altimate-free" }, [])
    expect(target?.kind).toBe("base")
    expect(logoutTitle(target)).toBe("Log out of Altimate Base")
  })

  test("a ChatGPT sign-in is named as the subscription", () => {
    const target = logoutTarget({ providerID: "openai" }, [provider({ id: "openai", name: "OpenAI", auth: "oauth" })])
    expect(target?.kind).toBe("saved")
    expect(logoutTitle(target)).toBe("Log out of OpenAI (ChatGPT subscription)")
  })

  test("a saved API key is named as an API key, even when config also lists the provider", () => {
    const target = logoutTarget(
      { providerID: "openai" },
      [provider({ id: "openai", name: "OpenAI", source: "config", auth: "api" })],
    )
    expect(logoutTitle(target)).toBe("Log out of OpenAI (API key)")
  })

  test("an OAuth sign-in for a provider without a known plan is a generic sign-in", () => {
    const target = logoutTarget({ providerID: "acme" }, [provider({ id: "acme", name: "Acme", auth: "oauth" })])
    expect(logoutTitle(target)).toBe("Log out of Acme (sign-in)")
  })

  test("a provider set by one environment variable names it and removes nothing", () => {
    const target = logoutTarget(
      { providerID: "openai" },
      [provider({ id: "openai", name: "OpenAI", source: "env", env: ["OPENAI_API_KEY"] })],
    )
    expect(target?.kind).toBe("external")
    expect(logoutTitle(target)).toBe("OpenAI is set by OPENAI_API_KEY")
    expect(target?.kind === "external" && target.hint).toContain("Unset it")
  })

  test("a provider with several candidate variables does not guess which one is set", () => {
    const target = logoutTarget(
      { providerID: "google" },
      [provider({ id: "google", name: "Google", source: "env", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] })],
    )
    expect(logoutTitle(target)).toBe("Google is set by an environment variable")
  })

  test("a provider from config without a saved login points at the config", () => {
    const target = logoutTarget({ providerID: "local" }, [provider({ id: "local", name: "Local", source: "config" })])
    expect(logoutTitle(target)).toBe("Local is set in your config")
  })

  test("a provider connected by another tool says there is nothing to remove", () => {
    const target = logoutTarget({ providerID: "claude-agent" }, [provider({ id: "claude-agent", name: "Claude" })])
    expect(target?.kind).toBe("external")
    expect(logoutTitle(target)).toBe("Claude is connected outside Altimate Code")
  })
})

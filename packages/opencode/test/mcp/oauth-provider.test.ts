import { test, expect, describe } from "bun:test"
import { McpOAuthProvider, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "../../src/mcp/oauth-provider"
import type { McpAuth } from "../../src/mcp/auth"

// Stub auth — only synchronous getters are exercised in these tests
const stubAuth = {} as McpAuth.Interface

const makeProvider = (config: ConstructorParameters<typeof McpOAuthProvider>[2]) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} }, stubAuth)

describe("McpOAuthProvider.redirectUrl", () => {
  test("defaults to 127.0.0.1:19876/mcp/oauth/callback", () => {
    const provider = makeProvider({})
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`)
  })

  test("uses callbackPort when set", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`)
  })

  test("redirectUri takes precedence over callbackPort", () => {
    const provider = makeProvider({
      callbackPort: 6620,
      redirectUri: "http://127.0.0.1:9999/custom/callback",
    })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9999/custom/callback")
  })

  test("uses explicit redirectUri when set without callbackPort", () => {
    const provider = makeProvider({ redirectUri: "http://127.0.0.1:8080/oauth/callback" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8080/oauth/callback")
  })
})

describe("McpOAuthProvider.redirectToAuthorization", () => {
  test("forwards http and https authorization URLs", async () => {
    const seen: string[] = []
    const provider = new McpOAuthProvider(
      "test-server",
      "https://mcp.example.com/mcp",
      {},
      { onRedirect: (url) => void seen.push(url.href) },
      stubAuth,
    )
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=1"))
    await provider.redirectToAuthorization(new URL("http://127.0.0.1:8080/authorize"))
    expect(seen).toEqual(["https://auth.example.com/authorize?state=1", "http://127.0.0.1:8080/authorize"])
  })

  test.each(["file:///tmp/authorize", "custom-scheme://authorize", "javascript:alert(1)", "data:text/html,authorize"])(
    "rejects authorization URL %s before invoking onRedirect",
    async (input) => {
      const seen: string[] = []
      const mcpName = "test-server"
      const serverUrl = "https://fixture-user:fixture-password@mcp.example.com/mcp?token=fixture-token"
      const provider = new McpOAuthProvider(
        mcpName,
        serverUrl,
        {},
        { onRedirect: (url) => void seen.push(url.href) },
        stubAuth,
      )
      const url = new URL(input)
      const redirect = provider.redirectToAuthorization(url)
      await expect(redirect).rejects.toThrow(`returned a ${url.protocol} authorization URL`)
      await expect(redirect).rejects.toThrow(mcpName)
      await expect(redirect).rejects.not.toThrow(serverUrl)
      expect(seen).toEqual([])
    },
  )
})

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes redirect_uris from redirectUrl", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.clientMetadata.redirect_uris).toEqual([`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`])
  })

  test("includes scope when set in config", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
    const provider = makeProvider({ clientSecret: "secret" })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("sets token_endpoint_auth_method to none when no clientSecret", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none")
  })
})

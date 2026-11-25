import { test, expect, describe } from "bun:test"
import { McpOAuthProvider, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "../../src/mcp/oauth-provider"
import type { McpAuth } from "../../src/mcp/auth"
// altimate_change start — SDK auth() round-trip tests
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { Effect } from "effect"
// altimate_change end

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

// altimate_change start — MCP SDK >= 1.32 stamps stored OAuth credentials with their issuer
describe("McpOAuthProvider with SDK auth()", () => {
  const SERVER = "https://mcp.example.com/mcp"
  const AS = "https://as.example.com"

  const memoryAuth = (initial: McpAuth.Entry) => {
    let entry: McpAuth.Entry = { ...initial, serverUrl: SERVER }
    const auth: Partial<McpAuth.Interface> = {
      get: () => Effect.succeed(entry),
      getForUrl: (_name, url) => Effect.succeed(entry.serverUrl === url ? entry : undefined),
      set: (_name, next) => Effect.sync(() => void (entry = next)),
      updateClientInfo: (_name, clientInfo) => Effect.sync(() => void (entry = { ...entry, clientInfo })),
      updateTokens: (_name, tokens) => Effect.sync(() => void (entry = { ...entry, tokens })),
      updateCodeVerifier: (_name, codeVerifier) => Effect.sync(() => void (entry = { ...entry, codeVerifier })),
      updateOAuthState: (_name, oauthState) => Effect.sync(() => void (entry = { ...entry, oauthState })),
    }
    return { auth: auth as McpAuth.Interface, current: () => entry }
  }

  const fakeServer = () => {
    const calls: { url: string; body: string }[] = []
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body ? String(init.body) : "" })
      const json = (data: unknown) => Response.json(data)
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp")
        return json({ resource: SERVER, authorization_servers: [AS] })
      if (url === `${AS}/.well-known/oauth-authorization-server`)
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url === `${AS}/token`) return json({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" })
      if (url === `${AS}/register`) return json({ client_id: "registered", redirect_uris: ["http://127.0.0.1/cb"] })
      return new Response("not found", { status: 404 })
    }
    return { calls, fetchFn }
  }

  test("token exchange keeps the client secret expiry and stores the issuer", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const store = memoryAuth({
      clientInfo: { clientId: "dyn", clientSecret: "s", clientIdIssuedAt: 1, clientSecretExpiresAt: expiresAt },
      codeVerifier: "verifier",
    })
    const provider = new McpOAuthProvider("test-server", SERVER, {}, { onRedirect: async () => {} }, store.auth)
    const server = fakeServer()

    expect(await auth(provider, { serverUrl: SERVER, authorizationCode: "code", fetchFn: server.fetchFn })).toBe(
      "AUTHORIZED",
    )

    expect(store.current().clientInfo).toMatchObject({
      clientId: "dyn",
      clientIdIssuedAt: 1,
      clientSecretExpiresAt: expiresAt,
    })
    expect(store.current().clientInfo?.issuer).toStartWith(AS)
    expect(store.current().tokens?.issuer).toStartWith(AS)
  })

  test("does not send a refresh token to a different authorization server", async () => {
    const store = memoryAuth({
      clientInfo: { clientId: "old-client", issuer: "https://old-as.example.com/" },
      tokens: { accessToken: "old", refreshToken: "old-refresh", issuer: "https://old-as.example.com/" },
    })
    const provider = new McpOAuthProvider("test-server", SERVER, {}, { onRedirect: async () => {} }, store.auth)
    const server = fakeServer()

    expect(await auth(provider, { serverUrl: SERVER, fetchFn: server.fetchFn })).toBe("REDIRECT")

    expect(server.calls.some((c) => c.body.includes("old-refresh"))).toBe(false)
    expect(server.calls.some((c) => c.url === `${AS}/token`)).toBe(false)
    expect(store.current().clientInfo?.clientId).toBe("registered")
  })
})
// altimate_change end

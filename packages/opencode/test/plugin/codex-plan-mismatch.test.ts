// Regression coverage for the wrong-account / insufficient-plan diagnosis in
// the Codex OAuth fetch wrapper (packages/opencode/src/plugin/codex.ts — the
// ACTIVE plugin, wired via plugin/index.ts).
//
// A ChatGPT credential belonging to a free-plan account fails every Codex model
// request with:
//
//   400 {"detail":"The 'gpt-5.6' model is not supported when using Codex with a
//        ChatGPT account."}
//
// which blames the model and never mentions the account, so the user has no way
// to tell that the real problem is which account they signed in with. The
// wrapper now rewrites exactly that 400 into a message naming the plan and the
// (truncated) account id, plus the commands to switch accounts.
//
// No network: `globalThis.fetch` is stubbed for the duration of each test, and
// the tokens are synthetic JWT-shaped strings.
import { afterEach, describe, expect, test } from "bun:test"
import { CodexAuthPlugin } from "../../src/plugin/codex"

function fakeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.not-a-real-signature`
}

const FREE_TOKEN = fakeJwt({
  chatgpt_plan_type: "free",
  chatgpt_account_id: "4f3a1b2c-9d8e-4a7b-8c6d-5e4f3a2b1c0d",
})

const PLAN_MISMATCH_BODY = JSON.stringify({
  detail: "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
})

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Build the provider fetch wrapper the AI SDK would call, with an OAuth
 * credential that is valid and unexpired (so no refresh round-trip happens). */
async function makeCodexFetch(accessToken: string, accountId?: string) {
  const plugin = await CodexAuthPlugin({ client: {} } as any)
  const auth = {
    type: "oauth" as const,
    access: accessToken,
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60 * 1000,
    ...(accountId && { accountId }),
  }
  const loaded = await plugin.auth!.loader!((async () => auth) as any, { models: { "gpt-5.6": {} } } as any)
  return (loaded as { fetch: typeof fetch }).fetch
}

function stubFetch(response: Response) {
  const calls: Array<{ url: string }> = []
  globalThis.fetch = (async (input: any) => {
    calls.push({ url: String(input) })
    return response
  }) as any
  return calls
}

describe("codex fetch wrapper — plan/account diagnosis", () => {
  test("free-plan 400 is rewritten into an actionable message", async () => {
    stubFetch(new Response(PLAN_MISMATCH_BODY, { status: 400, statusText: "Bad Request" }))
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    const response = await codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    expect(response.status).toBe(400)

    const detail = ((await response.json()) as { detail: string }).detail
    expect(detail).toContain("4f3a1b2c…")
    expect(detail).toContain("`free` plan")
    expect(detail).toContain("Plus or Pro")
    expect(detail).toContain("altimate-code auth logout openai")
    expect(detail).toContain("altimate-code auth login openai")
  })

  test("the rewritten body never contains the access token or the full account id", async () => {
    stubFetch(new Response(PLAN_MISMATCH_BODY, { status: 400 }))
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    const body = await (await codexFetch("https://api.openai.com/v1/responses", { method: "POST" })).text()
    expect(body).not.toContain(FREE_TOKEN)
    for (const segment of FREE_TOKEN.split(".")) {
      expect(body).not.toContain(segment)
    }
    expect(body).not.toContain("4f3a1b2c-9d8e-4a7b-8c6d-5e4f3a2b1c0d")
    expect(body).not.toContain("refresh-token")
  })

  test("still actionable when the token carries no readable claims", async () => {
    stubFetch(new Response(PLAN_MISMATCH_BODY, { status: 400 }))
    const codexFetch = await makeCodexFetch("opaque-access-token")

    const detail = ((await (await codexFetch("https://api.openai.com/v1/responses", {})).json()) as { detail: string })
      .detail
    expect(detail).toContain("plan could not be read")
    expect(detail).toContain("altimate-code auth login openai")
  })

  test("other 400s pass through untouched", async () => {
    const original = JSON.stringify({ detail: "context length exceeded" })
    stubFetch(new Response(original, { status: 400 }))
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    const response = await codexFetch("https://api.openai.com/v1/responses", {})
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(original)
  })

  test("successful responses pass through untouched", async () => {
    stubFetch(new Response('{"ok":true}', { status: 200 }))
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    const response = await codexFetch("https://api.openai.com/v1/responses", {})
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
  })

  test("requests still go to the Codex endpoint (rewrite is unchanged)", async () => {
    const calls = stubFetch(new Response("{}", { status: 200 }))
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    await codexFetch("https://api.openai.com/v1/responses", {})
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("preserves upstream headers (e.g. a request id) on the enriched error", async () => {
    stubFetch(
      new Response(PLAN_MISMATCH_BODY, {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "x-request-id": "req_abc123",
          "content-type": "application/json",
          "content-length": String(PLAN_MISMATCH_BODY.length),
        },
      }),
    )
    const codexFetch = await makeCodexFetch(FREE_TOKEN)

    const response = await codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    expect(response.status).toBe(400)
    // The diagnostic request id survives so this failure stays correlatable
    // with provider-side logs.
    expect(response.headers.get("x-request-id")).toBe("req_abc123")
    expect(response.headers.get("content-type")).toBe("application/json")
    // The body was replaced, so a stale content-length must not survive with it.
    const body = await response.text()
    expect(response.headers.get("content-length")).not.toBe(String(PLAN_MISMATCH_BODY.length))
    expect(body.length).toBeGreaterThan(0)
  })

  test("falls back to the stored OAuth account id when the token carries none", async () => {
    stubFetch(new Response(PLAN_MISMATCH_BODY, { status: 400 }))
    // A token with a readable plan but no account claim — the request itself
    // still selected an account via the stored id (sent as ChatGPT-Account-Id).
    const tokenWithNoAccount = fakeJwt({ chatgpt_plan_type: "free" })
    const codexFetch = await makeCodexFetch(tokenWithNoAccount, "stored-acct-12345")

    const detail = ((await (await codexFetch("https://api.openai.com/v1/responses", {})).json()) as {
      detail: string
    }).detail
    expect(detail).toContain("stored-a…")
  })
})

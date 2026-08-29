// Coverage for the non-secret OAuth claim helpers behind two UX fixes:
//
//   1. `auth list` showing which ChatGPT account/plan a credential belongs to.
//   2. The enriched 400 shown when a Codex request is made with a credential
//      whose plan has no Codex entitlement — previously the user only saw
//      `{"detail":"The 'gpt-5.6' model is not supported when using Codex with
//      a ChatGPT account."}`, which blames the model, not the account.
//
// Tokens here are synthetic JWT-shaped strings with `alg: none`; nothing in
// this file talks to a network or to a real credential.
import { describe, expect, test } from "bun:test"
import {
  decodeJwtClaims,
  describeOAuthIdentity,
  enrichCodexPlanMismatchBody,
  extractOAuthIdentity,
  isCodexPlanMismatchBody,
  maskAccountId,
} from "../../src/auth/oauth-claims"

function fakeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.not-a-real-signature`
}

const FREE_ACCOUNT_ID = "4f3a1b2c-9d8e-4a7b-8c6d-5e4f3a2b1c0d"

const FREE_TOKEN = fakeJwt({
  chatgpt_plan_type: "free",
  chatgpt_account_id: FREE_ACCOUNT_ID,
})

const NESTED_PRO_TOKEN = fakeJwt({
  "https://api.openai.com/auth": {
    chatgpt_plan_type: "pro",
    chatgpt_account_id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
  },
})

const MISMATCH_BODY = JSON.stringify({
  detail: "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
})

describe("decodeJwtClaims", () => {
  test("decodes a three-segment token payload", () => {
    expect(decodeJwtClaims(fakeJwt({ a: 1 }))).toEqual({ a: 1 })
  })

  test("returns undefined for non-JWT input", () => {
    expect(decodeJwtClaims("sk-not-a-jwt")).toBeUndefined()
    expect(decodeJwtClaims("only.two")).toBeUndefined()
    expect(decodeJwtClaims("")).toBeUndefined()
  })

  test("returns undefined when the payload is not a JSON object", () => {
    const header = Buffer.from("{}").toString("base64url")
    expect(decodeJwtClaims(`${header}.${Buffer.from("[1,2]").toString("base64url")}.sig`)).toBeUndefined()
    expect(decodeJwtClaims(`${header}.${Buffer.from("nonsense").toString("base64url")}.sig`)).toBeUndefined()
  })
})

describe("extractOAuthIdentity", () => {
  test("reads top-level plan + account claims", () => {
    expect(extractOAuthIdentity(FREE_TOKEN)).toEqual({
      plan: "free",
      accountId: FREE_ACCOUNT_ID,
    })
  })

  test("reads the OpenAI-namespaced claim bag", () => {
    expect(extractOAuthIdentity(NESTED_PRO_TOKEN)).toEqual({
      plan: "pro",
      accountId: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
    })
  })

  test("returns empty for missing or undecodable tokens", () => {
    expect(extractOAuthIdentity(undefined)).toEqual({})
    expect(extractOAuthIdentity("opaque-token")).toEqual({})
    expect(extractOAuthIdentity(fakeJwt({ sub: "user" }))).toEqual({})
  })
})

describe("maskAccountId", () => {
  test("truncates long ids", () => {
    expect(maskAccountId(FREE_ACCOUNT_ID)).toBe("4f3a1b2c…")
  })

  test("leaves short ids alone and passes undefined through", () => {
    expect(maskAccountId("abc")).toBe("abc")
    expect(maskAccountId(undefined)).toBeUndefined()
  })
})

describe("describeOAuthIdentity — the `auth list` annotation", () => {
  test("names plan and truncated account", () => {
    expect(describeOAuthIdentity(FREE_TOKEN)).toBe("free plan, account 4f3a1b2c…")
  })

  test("degrades to whichever claim is present", () => {
    expect(describeOAuthIdentity(fakeJwt({ chatgpt_plan_type: "plus" }))).toBe("plus plan")
    expect(describeOAuthIdentity(fakeJwt({ chatgpt_account_id: "acct-1234567890" }))).toBe("account acct-123…")
  })

  test("returns undefined when there is nothing to show", () => {
    expect(describeOAuthIdentity(fakeJwt({ sub: "user" }))).toBeUndefined()
    expect(describeOAuthIdentity(undefined)).toBeUndefined()
  })

  test("never leaks the token itself", () => {
    const described = describeOAuthIdentity(FREE_TOKEN)!
    expect(FREE_TOKEN.includes(described)).toBe(false)
    for (const segment of FREE_TOKEN.split(".")) {
      expect(described).not.toContain(segment)
    }
  })
})

describe("isCodexPlanMismatchBody", () => {
  test("matches the plan-entitlement 400 regardless of the quoted model", () => {
    expect(isCodexPlanMismatchBody(MISMATCH_BODY)).toBe(true)
    expect(
      isCodexPlanMismatchBody(
        JSON.stringify({
          detail: "The 'gpt-9.9-codex' model is not supported when using Codex with a ChatGPT account.",
        }),
      ),
    ).toBe(true)
  })

  test("does not match unrelated failures", () => {
    expect(isCodexPlanMismatchBody(JSON.stringify({ detail: "rate limit exceeded" }))).toBe(false)
    expect(isCodexPlanMismatchBody("")).toBe(false)
    expect(isCodexPlanMismatchBody(undefined)).toBe(false)
  })
})

describe("enrichCodexPlanMismatchBody", () => {
  test("free-plan token produces an actionable message", () => {
    const message = enrichCodexPlanMismatchBody(MISMATCH_BODY, FREE_TOKEN)!
    expect(message).toContain("4f3a1b2c…")
    expect(message).toContain("`free` plan")
    expect(message).toContain("Plus or Pro")
    expect(message).toContain("altimate-code auth logout openai")
    expect(message).toContain("altimate-code auth login openai")
    // The provider's own wording is preserved for context.
    expect(message).toContain("not supported when using Codex with a ChatGPT account")
  })

  test("never includes the token, its payload segment, or the full account id", () => {
    const message = enrichCodexPlanMismatchBody(MISMATCH_BODY, FREE_TOKEN)!
    for (const segment of FREE_TOKEN.split(".")) {
      expect(message).not.toContain(segment)
    }
    expect(message).not.toContain(FREE_ACCOUNT_ID)
  })

  test("still actionable when the token carries no readable claims", () => {
    const message = enrichCodexPlanMismatchBody(MISMATCH_BODY, "opaque-token")!
    expect(message).toContain("altimate-code auth login openai")
    expect(message).toContain("plan could not be read")
  })

  test("handles a non-JSON body that still carries the phrase", () => {
    const message = enrichCodexPlanMismatchBody(
      "model is not supported when using Codex with a ChatGPT account",
      FREE_TOKEN,
    )!
    expect(message).toContain("`free` plan")
    expect(message).not.toContain("Provider said:")
  })

  test("leaves every other error alone", () => {
    expect(
      enrichCodexPlanMismatchBody(JSON.stringify({ detail: "context length exceeded" }), FREE_TOKEN),
    ).toBeUndefined()
    expect(enrichCodexPlanMismatchBody(undefined, FREE_TOKEN)).toBeUndefined()
  })
})

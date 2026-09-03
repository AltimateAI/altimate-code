/**
 * Non-secret identity claims carried by OAuth access tokens, plus the
 * diagnostics built on top of them.
 *
 * Why this exists: a ChatGPT OAuth credential that belongs to a free-plan
 * account fails every Codex model request with a 400 whose body only says the
 * *model* is unsupported — it never says the real problem is WHICH account you
 * signed in with. These helpers pull the two non-secret claims that answer
 * that question (plan type + account id) so the CLI can say it out loud.
 *
 * SECURITY: nothing here may return, log, or embed the token, the refresh
 * token, or any other credential material. Only `plan` and a TRUNCATED account
 * id ever leave this module. Callers render the returned strings directly to
 * the terminal, so treat every return value as user-visible output.
 */

/** Account ids are opaque identifiers, not secrets, but there is no reason to
 * print one in full — the first segment is enough to tell two accounts apart. */
const ACCOUNT_ID_VISIBLE_CHARS = 8

/** The OpenAI-namespaced claim bag inside ChatGPT id/access tokens. */
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"

export interface OAuthIdentity {
  /** ChatGPT plan type claim, e.g. "free", "plus", "pro". */
  plan?: string
  /** Raw account id — mask with `maskAccountId` before displaying. */
  accountId?: string
}

/**
 * Decode the payload of a JWT-shaped token WITHOUT verifying its signature.
 *
 * Verification is deliberately skipped: these claims are used for human-facing
 * diagnostics only, never for an authorization decision. Returns undefined for
 * anything that is not a three-segment token with a JSON object payload.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString())
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined
    return decoded as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Claim values are rendered straight into a terminal and into error text, and
 * the token is never signature-verified, so treat every claim as untrusted
 * input: keep printable ASCII only (no control or escape sequences) and cap the
 * length so a hostile claim cannot wallpaper the output. */
const MAX_CLAIM_LENGTH = 64

function sanitizeClaim(value: string): string | undefined {
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").slice(0, MAX_CLAIM_LENGTH)
  return cleaned.length > 0 ? cleaned : undefined
}

function stringClaim(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 ? sanitizeClaim(value) : undefined
}

/**
 * Pull the plan type and account id out of an OAuth access token. Both claims
 * appear either at the top level or inside the OpenAI-namespaced claim bag,
 * depending on which flow minted the token, so check both.
 */
export function extractOAuthIdentity(accessToken: string | undefined): OAuthIdentity {
  if (!accessToken) return {}
  const claims = decodeJwtClaims(accessToken)
  if (!claims) return {}
  const namespaced = claims[OPENAI_AUTH_CLAIM]
  const nested =
    namespaced && typeof namespaced === "object" && !Array.isArray(namespaced)
      ? (namespaced as Record<string, unknown>)
      : undefined
  return {
    plan: stringClaim(claims, "chatgpt_plan_type") ?? stringClaim(nested, "chatgpt_plan_type"),
    accountId: stringClaim(claims, "chatgpt_account_id") ?? stringClaim(nested, "chatgpt_account_id"),
  }
}

/** Truncate an account id for display. */
export function maskAccountId(accountId: string | undefined): string | undefined {
  if (!accountId) return undefined
  if (accountId.length <= ACCOUNT_ID_VISIBLE_CHARS) return accountId
  return accountId.slice(0, ACCOUNT_ID_VISIBLE_CHARS) + "…"
}

/**
 * One-line summary of an OAuth credential for `auth list`, e.g.
 * `free plan, account 4f3a1b2c…`. Returns undefined when the token carries
 * neither claim (nothing useful to show, so show nothing).
 *
 * `storedAccountId` is a fallback for credentials whose access token never
 * carries `chatgpt_account_id` — some accounts only get an id via the ID
 * token's `organizations[0].id`, which login stores separately (see
 * `extractAccountId` in `plugin/codex.ts`). The token claim wins when both are
 * present; it is what the request itself sends.
 */
export function describeOAuthIdentity(accessToken: string | undefined, storedAccountId?: string): string | undefined {
  const { plan, accountId } = extractOAuthIdentity(accessToken)
  const masked = maskAccountId(accountId ?? stringClaim({ accountId: storedAccountId }, "accountId"))
  const parts = [plan ? `${plan} plan` : undefined, masked ? `account ${masked}` : undefined].filter((x): x is string =>
    Boolean(x),
  )
  return parts.length > 0 ? parts.join(", ") : undefined
}

/**
 * The 400 body OpenAI returns when a Codex request is made with a ChatGPT
 * credential whose plan has no Codex entitlement:
 *
 *   {"detail":"The 'gpt-5.6' model is not supported when using Codex with a
 *    ChatGPT account."}
 *
 * Matching on the stable phrase rather than the whole sentence keeps this
 * working as the quoted model id changes.
 */
const CODEX_PLAN_MISMATCH_PATTERN = /not supported when using Codex with a ChatGPT account/i

export function isCodexPlanMismatchBody(body: string | undefined): boolean {
  return Boolean(body) && CODEX_PLAN_MISMATCH_PATTERN.test(body!)
}

/** Plans that do carry Codex access. On one of these the 400 is NOT an
 * entitlement problem, so the message must not claim the plan is too low —
 * it would contradict what the user is paying for. */
const CODEX_ENTITLED_PLANS = new Set(["plus", "pro", "team", "business", "enterprise"])

/** The provider's own `detail` string is relayed verbatim into this message,
 * but it comes straight off the wire — not a claim we decode ourselves — so it
 * gets the same untrusted-input treatment: printable ASCII only, bounded
 * length. The cap is far larger than a claim's because real API error text
 * runs to a full sentence. */
const MAX_PROVIDER_DETAIL_LENGTH = 200

function sanitizeProviderDetail(value: string): string | undefined {
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").slice(0, MAX_PROVIDER_DETAIL_LENGTH)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Build the actionable replacement for that 400. Names the account and plan the
 * request actually used; on an unentitled plan it says to switch accounts, and
 * on an entitled one it says the model, not the plan, is the problem.
 */
export function codexPlanMismatchMessage(identity: OAuthIdentity, originalDetail?: string): string {
  const masked = maskAccountId(identity.accountId)
  const who = masked ? `Signed in as ChatGPT account ${masked}` : "Signed in with a ChatGPT account"
  const safeDetail = originalDetail ? sanitizeProviderDetail(originalDetail) : undefined
  const provider = safeDetail ? `\nProvider said: ${safeDetail}` : ""

  if (identity.plan && CODEX_ENTITLED_PLANS.has(identity.plan.toLowerCase())) {
    return (
      `${who} on the \`${identity.plan}\` plan, which does include Codex — so this is the model, ` +
      `not the plan. This model is not offered to ChatGPT-subscription accounts; pick a different ` +
      `model, or use an OpenAI API key.\n` +
      `If that account is not the one you meant to use, \`altimate-code auth list\` shows which is stored.` +
      provider
    )
  }

  const plan = identity.plan
    ? ` on the \`${identity.plan}\` plan`
    : " whose plan could not be read from the stored credential"
  return (
    `${who}${plan}. Codex models require a ChatGPT Plus or Pro plan, ` +
    `so this account cannot run them.\n` +
    `If you have a Plus/Pro account, switch to it:\n` +
    `  altimate-code auth logout openai\n` +
    `  altimate-code auth login openai\n` +
    `Otherwise use an OpenAI API key instead of the ChatGPT subscription, ` +
    `or pick a model from another provider.` +
    provider
  )
}

/**
 * Given a raw 400 response body and the access token the request used, return
 * an enriched `detail` string plus the identity it was built from — or
 * undefined when the body is not this failure (leave every other error
 * untouched). Callers that also want to log the plan/account should reuse the
 * returned `identity` instead of decoding the token again.
 *
 * `storedAccountId` is the same login-time fallback `describeOAuthIdentity`
 * accepts: some credentials never carry `chatgpt_account_id` on the access
 * token, so the account the request actually selected (`ChatGPT-Account-Id`)
 * would otherwise go unnamed in this diagnostic.
 */
export function enrichCodexPlanMismatchBody(
  body: string | undefined,
  accessToken: string | undefined,
  storedAccountId?: string,
): { message: string; identity: OAuthIdentity } | undefined {
  if (!isCodexPlanMismatchBody(body)) return undefined
  let detail: string | undefined
  try {
    const parsed = JSON.parse(body!)
    if (parsed && typeof parsed.detail === "string") detail = parsed.detail
  } catch {
    // Body was not JSON — the phrase still matched, so still enrich, just
    // without quoting a `detail` field we could not parse out.
  }
  const tokenIdentity = extractOAuthIdentity(accessToken)
  const identity: OAuthIdentity = {
    plan: tokenIdentity.plan,
    accountId: tokenIdentity.accountId ?? stringClaim({ accountId: storedAccountId }, "accountId"),
  }
  return { message: codexPlanMismatchMessage(identity, detail), identity }
}

export * as OAuthClaims from "./oauth-claims"

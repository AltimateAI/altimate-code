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

function stringClaim(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
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
 */
export function describeOAuthIdentity(accessToken: string | undefined): string | undefined {
  const { plan, accountId } = extractOAuthIdentity(accessToken)
  const masked = maskAccountId(accountId)
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

/**
 * Build the actionable replacement for that 400. Names the account and plan the
 * request actually used, then gives the exact commands to switch accounts.
 */
export function codexPlanMismatchMessage(identity: OAuthIdentity, originalDetail?: string): string {
  const masked = maskAccountId(identity.accountId)
  const who = masked ? `Signed in as ChatGPT account ${masked}` : "Signed in with a ChatGPT account"
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
    (originalDetail ? `\nProvider said: ${originalDetail}` : "")
  )
}

/**
 * Given a raw 400 response body and the access token the request used, return
 * an enriched `detail` string — or undefined when the body is not this failure
 * (leave every other error untouched).
 */
export function enrichCodexPlanMismatchBody(body: string | undefined, accessToken: string | undefined) {
  if (!isCodexPlanMismatchBody(body)) return undefined
  let detail: string | undefined
  try {
    const parsed = JSON.parse(body!)
    if (parsed && typeof parsed.detail === "string") detail = parsed.detail
  } catch {
    // Body was not JSON — the phrase still matched, so still enrich, just
    // without quoting a `detail` field we could not parse out.
  }
  return codexPlanMismatchMessage(extractOAuthIdentity(accessToken), detail)
}

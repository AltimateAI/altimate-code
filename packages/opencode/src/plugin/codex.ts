import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"
import os from "os"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"
import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "http"

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

/** Exact set of model ids the ChatGPT-subscription (Codex) tier accepts.
 *
 * Every entry was verified against the live backend
 * (POST https://chatgpt.com/backend-api/codex/responses) on a ChatGPT Pro
 * credential: entries here returned HTTP 200.
 *
 * CONFIRMED REJECTED, so deliberately absent — each returned
 * ``400 {"detail":"The '<id>' model is not supported when using Codex with a
 * ChatGPT account."}``: gpt-5, gpt-5.1, gpt-5.2, gpt-5.2-pro,
 * gpt-5.3-chat-latest, gpt-5.3-codex, gpt-5.4-nano, gpt-5.4-pro, gpt-5.5-pro,
 * gpt-5.6.
 *
 * NOT PROBED, and excluded by default because this list is fail-closed:
 * gpt-5-mini, gpt-5-nano, gpt-5-pro, gpt-5.2-chat-latest. They are in the
 * models.dev catalog but are not plausible Codex-tier models, and the
 * discovery endpoint below does not list them either. An earlier revision of
 * this comment claimed every other catalog id had been probed; that overstated
 * the evidence, and these four are the exception.
 *
 * TIER SCOPE. All of the above is what ONE ChatGPT Pro account was served.
 * It has not been verified against a Plus credential, so it is possible Plus
 * is entitled to a narrower (or wider) set. If a Plus subscriber reports a
 * model missing from the picker that the official client offers them, that is
 * the likely cause and the fix is a per-account list, not another id here.
 *
 * OLDER CODEX IDS ARE DROPPED, AND THAT DROP IS UNVERIFIED. Reviewers keep
 * asking why codex-tagged ids appear in neither list above. The honest answer
 * depends on WHICH catalog is live, because the two disagree:
 *
 *   * live https://models.dev/api.json carries exactly two codex ids —
 *     gpt-5.3-codex and gpt-5.3-codex-spark — both accounted for above.
 *   * the BUNDLED snapshot (provider/models-snapshot.ts) is staler and still
 *     carries gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max,
 *     gpt-5.1-codex-mini and gpt-5.2-codex under ``openai``.
 *
 * ModelsDev.Data resolves disk cache -> bundled snapshot -> fetch, so on a
 * fresh install or cold cache the snapshot IS the catalog, and those five ids
 * do reach this loader. The removed ``includes("codex")`` rule offered them;
 * exact matching now deletes them. None was individually probed. They are
 * absent from the discovery endpoint's nine slugs (a Pro account), which is
 * evidence but not a probe, and consistent with older codex models having been
 * retired.
 *
 * They stay out on the same fail-closed reasoning as the ids above: an
 * unverified inclusion fails opaquely mid-request, an unverified exclusion
 * fails visibly at selection with a "did you mean" list. Probe one and move it
 * into the right list to settle it.
 *
 * COLD-CACHE CAVEAT. That same snapshot staleness cuts the other way for the
 * models this list adds: it contains NO gpt-5.6 variant, so on a cold cache
 * sol/luna/terra are absent from the catalog entirely and this allowlist cannot
 * conjure them — the filter only ever deletes. They become selectable once the
 * catalog refreshes from models.dev (or the bundled snapshot is regenerated at
 * the next release build). This allowlist is necessary for them to appear, but
 * on a cold cache it is not sufficient.
 *
 * There is no derivable rule here — the tier accepts ``gpt-5.3-codex-spark``
 * but rejects ``gpt-5.3-codex``, and accepts the gpt-5.6 sol/luna/terra
 * variants but rejects plain ``gpt-5.6``. So this is an exact-match list by
 * necessity, not by preference. Only add an id after confirming a 200 from the
 * endpoint above on a subscription credential; guessing puts a model in the
 * picker that then fails at request time.
 *
 * WHY THIS IS STATIC AND NOT DISCOVERED. There is an authoritative per-account
 * endpoint — ``GET https://chatgpt.com/backend-api/codex/models?client_version=<v>``
 * — and it accepts our own identity (``originator: altimate`` plus our
 * User-Agent; no impersonation needed) and returns exactly the set above, each
 * entry carrying ``slug``, ``visibility`` and ``minimal_client_version``. Its
 * ``visibility: "list"`` slugs corroborate this list precisely, which is why
 * that list is reproduced here rather than derived at runtime:
 *
 * ``client_version`` is mandatory (omitted or unparseable ⇒ HTTP 400) and is
 * gated against each model's ``minimal_client_version``, which at the time of
 * probing ranged from 0.98.0 to 0.144.0. Those are Codex CLI release numbers —
 * a numbering line we are not on, so comparing our number against theirs is
 * meaningless regardless of which way it happens to sort.
 *
 * Two different version numbers exist in this repo and it matters which one
 * reaches the wire. What we would send is ``Installation.VERSION``, i.e. the
 * build-injected ``OPENCODE_VERSION`` — the NPM-published version, 0.9.7 at
 * the time of probing, or the literal ``local`` for a dev build. It is NOT the
 * 1.17.9 in packages/opencode/package.json, which is inherited from the
 * upstream numbering line and never sent. Both observed values fail, and the
 * failure is SILENT for one of them: ``client_version=0.9.7`` returns
 * ``HTTP 200 {"models":[]}`` — no error to debug, just an empty picker — while
 * a dev build's ``local`` returns
 * ``400 {"detail":"Invalid client_version format"}``.
 *
 * The blocker is not arithmetic, so bumping our version would not lift it: the
 * field means "which Codex CLI release am I", and answering it is impersonating
 * the first-party client whatever number we put there. We do not do that, so
 * the list stays static. If we ever have a legitimate client_version to send,
 * the mechanism is a small drop-in: fetch, keep ``visibility === "list"``, and
 * fall back to this set whenever the response is empty or the call fails.
 *
 * Exported for unit-test coverage — see test/plugin/codex-allowlist.test.ts. */
export const OAUTH_ALLOWED_MODELS = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
])

/** OAuth (ChatGPT-subscription) model-filter policy for the ACTIVE plugin
 * (this file — wired via plugin/index.ts). Exact membership in
 * ``OAUTH_ALLOWED_MODELS`` — no substring heuristics.
 *
 * This previously auto-allowed any id containing ``"codex"``, which admitted
 * ``gpt-5.3-codex``. The backend rejects that id, so it reached the picker and
 * then failed at request time with an HTTP 400. Substring matching cannot
 * express the real policy (``gpt-5.3-codex-spark`` is accepted while
 * ``gpt-5.3-codex`` is not), so the heuristic is gone.
 *
 * The sibling file plugin/openai/codex.ts (an in-progress refactor, currently
 * NOT wired) has its own separate filter with a ``parseFloat(match[1]) > 5.4``
 * fallback. Adopting this helper is followup work on that refactor — do NOT
 * assume the two files share this policy today. */
export function shouldAllowOAuthModel(modelId: string): boolean {
  return OAUTH_ALLOWED_MODELS.has(modelId)
}

/** Map keys to delete from an OAuth (subscription) provider's model record.
 *
 * Matches on the UPSTREAM api id, not the map key. The two are equal for every
 * models.dev catalog entry, but a user can alias a model in config —
 * ``provider.openai.models.fast-spark.id = "gpt-5.3-codex-spark"`` — which
 * produces an entry keyed ``fast-spark`` whose ``api.id`` carries the real id.
 * Config models are folded into the provider database (Provider.state, "extend
 * database from config") BEFORE auth loaders run, so they do reach this filter;
 * matching the key would delete a model the backend actually serves.
 *
 * Falls back to the key when ``api.id`` is absent: the database only backfills
 * ``model.api.id ?? model.id ?? modelID`` after this hook has run, so the field
 * is not guaranteed populated at this point even though the type says so.
 *
 * Returns keys rather than mutating, so the caller keeps the in-place delete on
 * the shared database object and this stays unit-testable. */
export function disallowedOAuthModelKeys(models: Record<string, { api?: { id?: string } }>): string[] {
  return Object.entries(models)
    .filter(([key, model]) => !shouldAllowOAuthModel(model?.api?.id ?? key))
    .map(([key]) => key)
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "altimate",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  // altimate_change start — upstream_fix: bridge merge dropped the 3-attempt retry
  // loop with 4xx-vs-5xx awareness. Without it transient network blips during OAuth
  // refresh hard-fail user sessions. Restore the loop and the descriptive error
  // message that points at `altimate-code auth login openai` for permanent failures.
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }).toString(),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(
          `Codex OAuth token refresh failed (HTTP ${response.status}). ` +
            `Try re-authenticating: altimate-code auth login openai` +
            (body ? ` — ${body.slice(0, 200)}` : ""),
        )
      }
      return response.json()
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      // Don't retry on 4xx (permanent auth failures) — only retry on network errors / 5xx
      const is4xx = lastError.message.includes("HTTP 4")
      if (is4xx || attempt >= 2) break
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw lastError ?? new Error("Codex OAuth token refresh failed")
  // altimate_change end
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Altimate CLI - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Altimate CLI.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

// altimate_change start — escape user-controlled error text before interpolating into HTML
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
// altimate_change end

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Altimate CLI - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${escapeHtml(error)}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => {
      log.info("codex oauth server started", { port: OAUTH_PORT })
      resolve()
    })
    oauthServer!.on("error", reject)
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {
      log.info("codex oauth server stopped")
    })
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Filter models to only those the ChatGPT-subscription (Codex) tier
        // accepts. Delegates to ``disallowedOAuthModelKeys`` (module-level,
        // above), which matches on each model's upstream ``api.id`` so a
        // config alias of a supported model survives. See OAUTH_ALLOWED_MODELS
        // for the criteria + how to add new gpt-5.N releases.
        //
        // NOTE: this file is the ACTIVE plugin (wired via plugin/index.ts).
        // The sibling plugin/openai/codex.ts is an unwired in-progress
        // refactor that keeps its OWN ALLOWED_MODELS + parseFloat > 5.4
        // fallback — this filter does NOT share a source of truth with it.
        // Adopting shouldAllowOAuthModel there is followup on that refactor.
        // (Closes #1132 — GPT 5.6 missing from picker.)
        for (const modelId of disallowedOAuthModelKeys(provider.models)) {
          delete provider.models[modelId]
        }

        // Zero out costs for Codex (included with ChatGPT subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Cast to include accountId field
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            // altimate_change start — upstream_fix: bridge merge dropped the 30s skew
            // buffer. Without it, requests that span the expiry boundary mid-flight
            // race to a 401 from the API even though we just verified the token. The
            // 30s buffer gives in-flight requests headroom to finish before the token
            // becomes invalid.
            if (!currentAuth.access || currentAuth.expires < Date.now() + 30_000) {
              // altimate_change end
              log.info("refreshing codex access token")
              const tokens = await refreshAccessToken(currentAuth.refresh)
              const newAccountId = extractAccountId(tokens) || authWithAccount.accountId
              await input.client.auth.set({
                path: { id: "openai" },
                body: {
                  type: "oauth",
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  ...(newAccountId && { accountId: newAccountId }),
                },
              })
              currentAuth.access = tokens.access_token
              authWithAccount.accountId = newAccountId
            }

            // Build headers
            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            // Set authorization header with access token
            headers.set("authorization", `Bearer ${currentAuth.access}`)

            // Set ChatGPT-Account-Id header for organization subscriptions
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            // Rewrite URL to Codex endpoint
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed

            return fetch(url, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `altimate-code/${Installation.VERSION}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `altimate-code/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "altimate"
      output.headers["User-Agent"] = `altimate/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}

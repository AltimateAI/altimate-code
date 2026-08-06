// Free-tier gateway client: registration, credential storage, and silent key rotation for the
// `altimate-free` provider (see docs/internal/2026-08-06-free-gemini-flash-model.md).
//
// Registration is consent-gated: nothing here runs until the user accepts the disclosure
// interstitial. The provider loader only ever calls the read-only helpers, so a fresh install
// makes no network call and mints no identifier.
import { randomBytes, createHash } from "node:crypto"
import { Auth } from "../../auth"
import { Installation } from "../../installation"
import { Log } from "../util/log"

const log = Log.create({ service: "free-tier" })

export namespace FreeTier {
  export const PROVIDER_ID = "altimate-free"
  export const MODEL_ID = "gemini-flash-free"

  const DEFAULT_GATEWAY_URL = "https://free.onealtimate.com"

  /** Rotate this far ahead of expiry so a long session does not fail mid-request. */
  const REFRESH_SKEW_MS = 5 * 60 * 1000
  const REGISTER_TIMEOUT_MS = 15_000

  export function gatewayUrl(): string {
    const configured = process.env["ALTIMATE_FREE_GATEWAY_URL"]?.trim()
    return (configured || DEFAULT_GATEWAY_URL).replace(/\/+$/, "")
  }

  export interface Credentials {
    apiKey: string
    baseURL: string
    /** ISO 8601. Absent when the gateway does not pin an expiry. */
    expiresAt?: string
    /** Stable across rotations — the gateway's budget principal is derived from its hash. */
    installSecret: string
  }

  /**
   * The install secret is a gateway-scoped random value, deliberately NOT the telemetry
   * machine-id: that id is documented as serving aggregate telemetry only, and reusing it would
   * join the telemetry and inference datasets.
   */
  function mintInstallSecret(): string {
    return randomBytes(32).toString("hex")
  }

  export function hashInstallSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex")
  }

  export async function credentials(): Promise<Credentials | undefined> {
    const auth = await Auth.get(PROVIDER_ID).catch(() => undefined)
    if (auth?.type !== "api") return undefined
    const installSecret = auth.metadata?.["install_secret"]
    const baseURL = auth.metadata?.["base_url"]
    if (!auth.key || !installSecret || !baseURL) return undefined
    return { apiKey: auth.key, baseURL, expiresAt: auth.metadata?.["expires_at"], installSecret }
  }

  export async function isRegistered(): Promise<boolean> {
    return (await credentials()) !== undefined
  }

  async function store(creds: Credentials): Promise<void> {
    await Auth.set(PROVIDER_ID, {
      type: "api",
      key: creds.apiKey,
      metadata: {
        install_secret: creds.installSecret,
        base_url: creds.baseURL,
        ...(creds.expiresAt ? { expires_at: creds.expiresAt } : {}),
      },
    })
  }

  export async function clear(): Promise<void> {
    await Auth.remove(PROVIDER_ID).catch(() => {})
  }

  export class RegistrationError extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message)
      this.name = "FreeTierRegistrationError"
    }
  }

  /**
   * Accept only a URL we are willing to send the key and the user's prompts to. The gateway
   * chooses this value, so an unencrypted or malformed one has to be rejected here rather than
   * trusted — localhost is allowed for running against a local gateway.
   */
  function normalizeBaseUrl(value: string): string | undefined {
    let url: URL
    try {
      url = new URL(value.trim())
    } catch {
      return undefined
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined
    return url.toString().replace(/\/+$/, "")
  }

  /**
   * Coerce the build's version string into the grammar the gateway accepts
   * (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$`, so 32 characters at most).
   *
   * Release builds already conform — a tag with its leading `v` stripped. Other builds do not,
   * and they are not hypothetical: CI's sanity build stamps `0.0.0-sanity-<40-char sha>`, which
   * is 53 characters, and a build made from a branch rather than a tag carries the branch name,
   * which in this repo contains slashes. Either one is a 422 from the gateway, surfaced to the
   * user as a bare "could not set up the free model".
   *
   * Sanitising here rather than widening the gateway's rule: a client that can emit a 53-character
   * version string is the defect, and the gateway is right to be strict about what it stores.
   */
  export function sanitizeCliVersion(raw: string): string {
    const coerced = raw
      .replace(/[^A-Za-z0-9._+-]/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 32)
    return coerced || "unknown"
  }

  /**
   * User-facing text for a 429 from the inference path, or undefined if we don't recognise it.
   *
   * Two limits share the 429 status and mean opposite things to a user: `throttling_error` is
   * "you are going too fast, wait a moment", `budget_exceeded` is "you are done for the day, and
   * waiting a moment will not help". Telling someone to retry shortly when their daily allowance
   * is gone sends them into a retry loop that cannot succeed.
   *
   * Keyed on the body discriminator rather than the status: the gateway's own measurements found
   * budget statuses moving between LiteLLM releases, and an unrecognised discriminator returns
   * undefined so the caller keeps the provider's original message rather than swallowing it.
   */
  export function describeRateLimit(input: { body?: string; retryAfter?: string }): string | undefined {
    let parsed: { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown } | undefined
    try {
      parsed = input.body ? JSON.parse(input.body) : undefined
    } catch {
      return undefined
    }
    const kind = typeof parsed?.error?.type === "string" ? parsed.error.type : parsed?.type
    const detail = typeof parsed?.error?.message === "string" ? parsed.error.message : ""

    if (kind === "throttling_error") {
      const seconds = Number(input.retryAfter)
      const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)}s.` : " Try again shortly."
      return `Too many requests to Gemini Flash (Free) right now.${wait}`
    }

    if (kind === "budget_exceeded") {
      // Same discriminator, two situations: this install's own daily allowance, or the shared
      // ceiling across the whole free tier. Reporting the shared one as "your limit" would be
      // wrong, so the wording falls back to something true of both when neither marker matches.
      if (detail.includes("ExceededBudget: User=")) {
        return "You've used today's free allowance for Gemini Flash (Free). It resets tomorrow — switch models or add your own API key to keep going."
      }
      if (detail.includes("Budget has been exceeded")) {
        return "The free tier has reached its shared daily limit. It resets tomorrow — switch models or add your own API key to keep going."
      }
      return "The daily limit for Gemini Flash (Free) has been reached. It resets tomorrow — switch models or add your own API key to keep going."
    }

    return undefined
  }

  /**
   * User-facing text for a 413 from the gateway, or undefined if it isn't one of ours.
   *
   * This is a fixed byte cap on the request, not a model context limit, and the two behave
   * differently under retry: the generic 413 path treats "too large" as recoverable and lets the
   * session compact and try again, which is right when the conversation is what grew. Here the
   * incompressible part — system prompt plus tool schemas — can exceed the cap on its own, and
   * then compaction shrinks nothing that matters and every retry fails identically. Measured
   * against a 128KB cap, one prompt produced ~90 doomed attempts and looked to the user like a
   * hang rather than an error.
   *
   * So this returns a terminal message carrying both numbers. Failing with an explanation the
   * user can act on beats retrying something that cannot succeed; if their conversation really
   * was the cause, starting a new session does what compaction would have.
   */
  export function describeRequestTooLarge(body?: string): string | undefined {
    type Inner = { code?: unknown; message?: unknown; provider_specific_fields?: { error?: Inner } }
    let parsed: { error?: Inner } | undefined
    try {
      parsed = body ? JSON.parse(body) : undefined
    } catch {
      return undefined
    }
    // LiteLLM keeps its own `code` ("413") on the outer error and nests our hook's discriminator
    // under error.provider_specific_fields.error — the flat shape is accepted too, so a future
    // LiteLLM that stops nesting does not silently take us back to the retry loop.
    const inner = parsed?.error?.provider_specific_fields?.error
    if (parsed?.error?.code !== "request_too_large" && inner?.code !== "request_too_large") return undefined

    const detail =
      typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : typeof inner?.message === "string"
          ? inner.message
          : ""
    const sizes = detail.match(/Request is (\d+) bytes; the free tier limit is (\d+) bytes/)
    const numbers = sizes ? ` (${Math.round(Number(sizes[1]) / 1024)}KB against a ${Math.round(Number(sizes[2]) / 1024)}KB limit)` : ""
    return `This request is too large for Gemini Flash (Free)${numbers}. Start a new session, or switch to another model for this task.`
  }

  function describeFailure(status: number): string {
    if (status === 429) return "Too many sign-ups from this network right now. Try again later."
    if (status === 503) return "The free model is temporarily unavailable. Try again later."
    return `Registration failed (HTTP ${status}).`
  }

  /**
   * Register with the gateway and persist the returned key.
   *
   * Reuses the stored install secret when one exists so re-registration rotates the key against
   * the same budget principal rather than creating a fresh one.
   */
  export async function register(): Promise<Credentials> {
    // Concurrent callers share one registration. Without this, a burst of parallel 401s would
    // each mint a key, and every one but the last would be orphaned on the gateway.
    if (!inflight) inflight = registerOnce().finally(() => (inflight = undefined))
    return inflight
  }

  let inflight: Promise<Credentials> | undefined

  async function registerOnce(): Promise<Credentials> {
    const existing = await credentials()
    const installSecret = existing?.installSecret ?? mintInstallSecret()
    const url = `${gatewayUrl()}/register`

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          install_secret_hash: hashInstallSecret(installSecret),
          cli_version: sanitizeCliVersion(Installation.VERSION),
        }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      })
    } catch (err) {
      log.warn("free tier registration request failed", { error: err })
      throw new RegistrationError("Could not reach the free model gateway. Check your connection.")
    }

    if (!response.ok) {
      log.warn("free tier registration rejected", { status: response.status })
      throw new RegistrationError(describeFailure(response.status), response.status)
    }

    const body = (await response.json().catch(() => undefined)) as
      | { api_key?: unknown; base_url?: unknown; expires_at?: unknown }
      | undefined
    const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : ""
    const baseURL = typeof body?.base_url === "string" ? normalizeBaseUrl(body.base_url) : undefined
    if (!apiKey || !baseURL) {
      throw new RegistrationError("The free model gateway returned an unexpected response.")
    }

    const creds: Credentials = {
      apiKey,
      baseURL,
      expiresAt: typeof body?.expires_at === "string" ? body.expires_at : undefined,
      installSecret,
    }
    await store(creds)
    return creds
  }

  function isExpired(creds: Credentials): boolean {
    if (!creds.expiresAt) return false
    const expiry = Date.parse(creds.expiresAt)
    // An unparseable expiry is treated as expired, not as immortal. Rotating once replaces the
    // bad value with a good one; the alternative leaves a credential that can never refresh.
    if (Number.isNaN(expiry)) return true
    return expiry - REFRESH_SKEW_MS <= Date.now()
  }

  /**
   * The credential to load the provider with.
   *
   * Rotation is started when the credential is at or near expiry but is deliberately NOT awaited:
   * provider load runs at startup and on every reload, and blocking it on the gateway would put a
   * remote service on the startup path — a slow or dead gateway would stall the CLI for the
   * registration timeout, repeatedly. The current credential is returned immediately; if it has
   * genuinely lapsed, the 401 path in authorizedFetch rotates and retries the request itself.
   */
  export async function refreshIfNeeded(): Promise<Credentials | undefined> {
    const current = await credentials()
    if (!current) return undefined
    if (isExpired(current)) {
      void register().catch((err) => log.warn("free tier background rotation failed", { error: err }))
    }
    return current
  }

  /** A body we can send a second time. Streams cannot be replayed, so a retry would send nothing. */
  function isReplayable(body: BodyInit | null | undefined): boolean {
    return body == null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
  }

  /**
   * Inference fetch for the provider.
   *
   * Two jobs, both driven by the fact that keys are short-lived. It stamps the Authorization
   * header from the credential on disk rather than the one captured when the SDK was built, and
   * it re-registers once on a 401 — the gateway can revoke a key before its stated expiry (kill
   * switch, principal revocation), which the expiry-based rotation in refreshIfNeeded() cannot
   * see. Failure is non-fatal: the original 401 is returned and surfaces as a normal provider
   * error.
   */
  export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const current = await credentials()
    if (!current) return fetch(input, init)

    const send = (apiKey: string) => {
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${apiKey}`)
      return fetch(input, { ...init, headers })
    }

    const response = await send(current.apiKey)
    if (response.status !== 401 || !isReplayable(init?.body)) return response

    // Re-read before registering. Under concurrency another request's rotation may already have
    // landed while this one was in flight, in which case the fix is to use that key, not to mint
    // another and orphan it.
    const stored = await credentials()
    if (stored && stored.apiKey !== current.apiKey) return send(stored.apiKey)

    log.info("free tier key rejected; re-registering")
    const rotated = await register().catch((err) => {
      log.warn("free tier re-registration after 401 failed", { error: err })
      return undefined
    })
    if (!rotated || rotated.apiKey === current.apiKey) return response
    return send(rotated.apiKey)
  }
}

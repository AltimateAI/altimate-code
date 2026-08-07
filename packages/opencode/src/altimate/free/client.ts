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
import { Flock } from "@opencode-ai/core/util/flock"

const log = Log.create({ service: "free-tier" })

export namespace FreeTier {
  export const PROVIDER_ID = "altimate-free"
  export const MODEL_ID = "gemini-flash-free"

  const DEFAULT_GATEWAY_URL = "https://free.onealtimate.com"

  /** Rotate this far ahead of expiry so a long session does not fail mid-request. */
  const REFRESH_SKEW_MS = 5 * 60 * 1000
  const REGISTER_TIMEOUT_MS = 15_000

  /**
   * Env var carrying the per-launch consent capability, and the header that presents it.
   *
   * Registration mints an identity and spends our budget, so it must not be callable by anything
   * that merely reached the HTTP server. The TUI reaches its server through an in-process worker
   * bridge and inherits this value from the parent's environment; an external HTTP caller does
   * not. `serve` never sets it, which disables the route there entirely.
   *
   * This is a capability, not an authentication boundary: another process running as the same
   * user can read the environment — but that process can already read auth.json, so this does not
   * widen anything. What it closes is the gap where ANY reachable caller could mint an identity.
   */
  export const CONSENT_TOKEN_ENV = "ALTIMATE_FREE_CONSENT_TOKEN"
  export const CONSENT_TOKEN_HEADER = "x-altimate-free-consent"

  /** Mint the per-launch capability. Called once by the CLI before the server worker starts. */
  export function mintConsentToken(): string {
    return randomBytes(32).toString("hex")
  }

  /**
   * Constant-time-ish check of a presented capability. Absent env means the route is disabled,
   * which is the `serve` case and is deliberate.
   */
  export function consentTokenValid(presented: string | undefined | null): boolean {
    const expected = process.env[CONSENT_TOKEN_ENV]
    if (!expected || !presented) return false
    if (presented.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i)
    return diff === 0
  }

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
      // Measured against the live gateway rather than assumed: LiteLLM sends no Retry-After here,
      // it puts the reset in the message ("Limit resets at: 2026-08-06 13:57:48 UTC"), and it has
      // two sub-flavours that need different advice.
      const resetIn = secondsUntil(detail.match(/Limit resets at: ([\d-]+ [\d:]+) UTC/)?.[1])
      const headerSeconds = Number(input.retryAfter)
      const seconds = resetIn ?? (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : undefined)
      const wait = seconds ? ` Try again in ${Math.ceil(seconds)}s.` : " Try again shortly."

      // "Limit type: tokens" means this one request exceeded the per-minute token ceiling, so an
      // immediate identical retry fails identically — the size is the problem, not the timing.
      // Reported as terminal with advice rather than retryable: the lead's standing instruction is
      // to prefer an actionable message over a loop when the two cannot be told apart, and a
      // shorter session is the only thing that reliably clears it. (Compaction would also clear
      // it, which is the argument for classifying this as overflow instead — flagged, not taken.)
      if (/Limit type: tokens/.test(detail)) {
        return `This request is too large for the free model's per-minute token limit. Start a new session or shorten the context, then try again.`
      }
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

  /** Seconds from now until a "YYYY-MM-DD HH:MM:SS" UTC stamp, if it is in the future. */
  function secondsUntil(stamp: string | undefined): number | undefined {
    if (!stamp) return undefined
    const at = Date.parse(stamp.replace(" ", "T") + "Z")
    if (Number.isNaN(at)) return undefined
    const seconds = (at - Date.now()) / 1000
    return seconds > 0 ? seconds : undefined
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
  export async function register(
    input: {
      supersede?: string
      // altimate_change — every key the CALLING request has already been rejected on, not just the
      // one in hand. The adopt branch below hands back whatever the store holds; without this it
      // can hand back a key the caller has already proven dead, which is the alternating-rotation
      // case in authorizedFetch. Optional: callers outside the 401 path have no such history.
      rejected?: ReadonlySet<string>
    } = {},
  ): Promise<Credentials> {
    // Two layers, because there are two kinds of concurrency here. In-process, a burst of
    // parallel 401s shares one registration so we do not mint a key per request. Across
    // processes — two CLIs open on the same machine, which is ordinary — a file lock serializes
    // the whole read-modify-write, since both would otherwise rotate the same principal and race
    // each other's writes to the shared auth store, orphaning keys.
    // Deduplicated by `supersede`, NOT process-wide. The in-process share exists so a burst of
    // parallel 401s on one key triggers one rotation instead of one per request — and such a
    // burst is by definition on the SAME key, so keying by it keeps that property intact.
    //
    // Sharing across DIFFERENT rejected keys was a bug: the lock body's adopt-vs-rotate decision
    // is computed against whichever caller created the promise. A caller rejected on key B that
    // joined a rotation started for key A could be handed back B itself — the very key it had
    // just proven dead — and would return the original 401 without ever rotating.
    const dedupeKey = input.supersede ?? ""
    const existing = inflight.get(dedupeKey)
    if (existing) return existing
    const started: Promise<Credentials> = Flock.withLock(LOCK_KEY, async () => {
      // Re-read inside the lock. `supersede` is the key the caller found rejected, so a stored
      // key that differs from it means another process already rotated while we waited and we
      // should adopt theirs. Deliberately NOT an expiry check: a revoked key still looks live,
      // and treating it as "nothing to do" would leave the 401 unrecoverable.
      const fresh = await credentials()
      // altimate_change — `!rejected.has(...)`: "differs from the key in hand" is not enough to
      // call the stored key live. Under rotations in both directions it can be an EARLIER key this
      // same request was already rejected on, and adopting it spends a recovery pass on a corpse.
      // Falling through to a real mint is the only thing left that can produce a working key.
      if (fresh && input.supersede && fresh.apiKey !== input.supersede && !input.rejected?.has(fresh.apiKey))
        return fresh
      return registerOnce()
    }).finally(() => {
      // Only clear our own entry: a later caller with the same rejected key may already have
      // started a fresh rotation under this dedupeKey.
      if (inflight.get(dedupeKey) === started) inflight.delete(dedupeKey)
    })
    inflight.set(dedupeKey, started)
    return started
  }

  const LOCK_KEY = "altimate-free-registration"

  const inflight = new Map<string, Promise<Credentials>>()

  /**
   * The install secret we should register with, minting one only if this machine has never had
   * one. Reads the stored secret even when no key accompanies it, which is what makes a lost
   * response recoverable.
   */
  async function installSecretForRegistration(): Promise<string> {
    const auth = await Auth.get(PROVIDER_ID).catch(() => undefined)
    const stored = auth?.type === "api" ? auth.metadata?.["install_secret"] : undefined
    if (stored) return stored
    const minted = mintInstallSecret()
    // Persisted BEFORE the request, deliberately. The gateway derives its budget principal from
    // this secret's hash, so if it commits a registration and the response is lost — a dropped
    // connection, a timeout, a crash — the retry has to present the SAME hash. Minting a fresh
    // one on retry silently creates a second principal with its own grant, which is both a
    // duplicate identity and a way to farm budget by interrupting registrations.
    await Auth.set(PROVIDER_ID, { type: "api", key: "", metadata: { install_secret: minted } })
    return minted
  }

  async function registerOnce(): Promise<Credentials> {
    const installSecret = await installSecretForRegistration()
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
   * The credential to load the provider with. Reads, and only reads.
   *
   * An earlier version kicked off a background rotation here when the credential looked expired.
   * That was still a network call originating from provider load, which happens at startup and on
   * every reload — so a stale credential meant the process contacted the gateway before the user
   * did anything, and a failing refresh repeated it on each reload. The invariant this design
   * rests on is that nothing reaches the gateway except from an explicit user action, and
   * "expired" is not a user action.
   *
   * Rotation happens where a request actually needs a working key: the 401 path in
   * authorizedFetch.
   */
  export async function credentialsForLoad(): Promise<Credentials | undefined> {
    return credentials()
  }

  function safeOrigin(value: string): string {
    try {
      return new URL(value).origin
    } catch {
      return "<unparseable>"
    }
  }

  /** Whether a request URL points at the same origin the credential was issued for. */
  function sameOrigin(target: string, registered: string): boolean {
    try {
      return new URL(target).origin === new URL(registered).origin
    } catch {
      return false
    }
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
   * switch, principal revocation), which the expiry check alone could never
   * see. Failure is non-fatal: the original 401 is returned and surfaces as a normal provider
   * error.
   */
  export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const current = await credentials()
    if (!current) return fetch(input, init)

    // The key is bound to the origin that issued it. If the request is going anywhere else, the
    // endpoint was redirected after the credential was loaded — a project-local config override
    // is the concrete way that happens — and attaching the Authorization header would hand the
    // key, the prompt and the session id to whoever chose that origin. Send it unauthenticated
    // instead and let the far end reject it.
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!sameOrigin(target, current.baseURL)) {
      log.error("free tier request target does not match the registered origin; sending no credential", {
        expected: safeOrigin(current.baseURL),
        actual: safeOrigin(target),
      })
      return fetch(input, init)
    }

    const send = (apiKey: string) => {
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${apiKey}`)
      return fetch(input, { ...init, headers })
    }

    let key = current.apiKey
    let response = await send(key)
    if (!isReplayable(init?.body)) return response

    // altimate_change start — bounded recovery LOOP, not a single retry.
    //
    // A recovery pass does one of two things, and either can lose a race:
    //   adopt   another request rotated while we were in flight, so we use its key — but that key
    //           may be the very one a THIRD request has meanwhile proven dead
    //   rotate  we mint a new key — which a concurrent rotation may already have superseded
    //
    // The single-pass version returned the second response unchecked. Concretely: stored key is
    // B; this caller was rejected on A and adopts B; the B-rejected caller rotates to C; we retry
    // B, get a second 401, and hand that to the model as a provider error even though C is live
    // and sitting in the store.
    //
    // Bounded rather than "until it works": a 401 can also mean revoked principal or kill switch,
    // which no amount of rotating fixes, and an unbounded loop would hang the request instead of
    // surfacing an error. Each pass must move to a key THIS REQUEST has not already been rejected
    // on, or we stop — that is what makes termination independent of the bound.
    //
    // `rejected` is what the comparison has to be against, not just the immediately previous key.
    // Comparing to the previous key alone lets rotations alternate us back onto a corpse: A is
    // rejected, we adopt B, B is rejected, the store meanwhile rotates back to A, and `!== key`
    // happily accepts A and sends it a second time. Still bounded, but it burns every remaining
    // pass on keys already proven dead and can return the 401 while a live key exists. A key only
    // enters the set once we have sent it and seen it fail, so this never refuses a key that might
    // still work.
    const rejected = new Set<string>([key])
    for (let attempt = 0; response.status === 401 && attempt < MAX_AUTH_RECOVERY_ATTEMPTS; attempt++) {
      const stored = await credentials()
      let next: string | undefined
      if (stored && !rejected.has(stored.apiKey)) {
        // Someone else already rotated. Use theirs rather than minting another and orphaning it.
        next = stored.apiKey
      } else {
        log.info("free tier key rejected; re-registering", { attempt })
        next = await register({ supersede: key, rejected })
          .then((rotated) => rotated.apiKey)
          .catch((err) => {
            log.warn("free tier re-registration after 401 failed", { error: err, attempt })
            return undefined
          })
      }
      // A rotation that hands back something we have already been rejected on has nothing left to
      // offer this request; stop and surface the 401 rather than spending a pass on it.
      if (!next || rejected.has(next)) return response
      key = next
      rejected.add(key)
      response = await send(key)
    }
    return response
    // altimate_change end
  }

  /** Initial send plus at most this many recovery passes. See authorizedFetch. */
  const MAX_AUTH_RECOVERY_ATTEMPTS = 3
}

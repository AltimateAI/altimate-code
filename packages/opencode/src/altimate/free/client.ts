import { createHash, randomBytes } from "node:crypto"
import { Flock } from "@opencode-ai/core/util/flock"
import { FreeTierCapability } from "./capability"
import { Installation } from "../../installation"
import { Log } from "../util/log"
import { FreeTierStore } from "./store"
import { FreeTierUrl } from "./url"

const log = Log.create({ service: "altimate-base" })

export const PROVIDER_ID = "altimate-free"
export const MODEL_ID = "altimate-base"
// The OpenAI-compatible SDK requires a non-empty key, but the real managed key must never enter
// Provider.Info/options because those objects are returned by public provider endpoints.
export const MANAGED_API_KEY_PLACEHOLDER = "altimate-base-managed"
// Release builds replace this identifier with the current official endpoint.
// Source-mode development and tests intentionally have no implicit network host.
declare const ALTIMATE_BASE_DEFAULT_GATEWAY_URL: string | undefined

const REGISTER_TIMEOUT_MS = 15_000
const LOCK_KEY = "altimate-base-registration"
const inflight = new Map<string, Promise<Credentials>>()
const rejectedCredentials = new Set<string>()
const REJECTED_CREDENTIAL_LIMIT = 32
// A credential is only disowned on disk after this many 401s in a row. One 401 can come from a
// gateway deploy, an LB restart, or key-propagation skew; persisting on the first one would take
// the whole free tier offline until every user re-ran the disclosure flow.
const REJECTED_PERSIST_THRESHOLD = 2
const unauthorizedCounts = new Map<string, number>()
// Claimed once, at module load: this module is the ONE place that may redeem an Altimate Base
// consent token. `issueRedeemer` throws on a second call, so no other in-process code can obtain
// an equivalent redeemer bound to the same production authority — see capability.ts.
const redeemConsent = FreeTierCapability.issueRedeemer()

export interface Credentials {
  apiKey: string
  baseURL: string
  expiresAt?: string
  installSecret: string
  rejected?: boolean
}

export type RegistrationFailureKind = "network" | "http" | "response" | "cancelled"

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly kind: RegistrationFailureKind,
    readonly status?: number,
  ) {
    super(message)
    this.name = "AltimateBaseRegistrationError"
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AltimateBaseConfigurationError"
  }
}

export function gatewayUrl(): string {
  const embedded =
    typeof ALTIMATE_BASE_DEFAULT_GATEWAY_URL === "string" ? ALTIMATE_BASE_DEFAULT_GATEWAY_URL.trim() : ""
  const configured =
    process.env["ALTIMATE_BASE_GATEWAY_URL"]?.trim() ||
    process.env["ALTIMATE_FREE_GATEWAY_URL"]?.trim() ||
    embedded
  const normalized = FreeTierUrl.normalizeGatewayUrl(configured)
  if (!normalized) {
    throw new ConfigurationError(
      configured
        ? "ALTIMATE_BASE_GATEWAY_URL must be HTTPS and cannot contain credentials, a query, or a fragment."
        : "The Altimate Base gateway is not configured. Set ALTIMATE_BASE_GATEWAY_URL and try again.",
    )
  }
  return normalized
}

function mintInstallSecret(): string {
  return randomBytes(32).toString("hex")
}

export function hashInstallSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function credentialsFromStored(stored: FreeTierStore.Record | undefined): Credentials | undefined {
  if (!stored?.apiKey || !stored.baseURL) return undefined
  return {
    apiKey: stored.apiKey,
    baseURL: stored.baseURL,
    expiresAt: stored.expiresAt,
    installSecret: stored.installSecret,
    ...(stored.rejected ? { rejected: true } : {}),
  }
}

export async function credentials(): Promise<Credentials | undefined> {
  return credentialsFromStored(await FreeTierStore.read())
}

export async function hasStoredRegistrationState(): Promise<boolean> {
  return (await FreeTierStore.read()) !== undefined
}

function expired(value: Credentials): boolean {
  if (!value.expiresAt) return false
  const timestamp = Date.parse(value.expiresAt)
  return !Number.isFinite(timestamp) || timestamp <= Date.now()
}

export async function credentialsForLoad(): Promise<Credentials | undefined> {
  const stored = await credentials()
  if (!stored || stored.baseURL !== gatewayUrl()) return undefined
  // Provider discovery must remain read-only. Refreshing here would mint credentials without the
  // current launch's explicit TUI disclosure/consent operation.
  if (stored.rejected || expired(stored)) return undefined
  return stored
}

export async function isRegistered(): Promise<boolean> {
  return (await credentialsForLoad()) !== undefined
}

/**
 * Disconnect the managed provider without resetting the fair-use identity.
 *
 * The install secret never leaves this machine; registration sends only its SHA-256 hash. Keeping
 * it across logout prevents the supported CLI flow from minting a fresh free-allowance principal.
 */
export async function logout(): Promise<void> {
  rejectedCredentials.clear()
  await Flock.withLock(LOCK_KEY, async () => {
    let stored: FreeTierStore.Record | undefined
    try {
      stored = await FreeTierStore.read()
    } catch (error) {
      if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
      // A malformed record has no trustworthy identity or credential to preserve. Atomically
      // replacing it still disconnects the provider and gives pending registrations a new nonce.
      log.warn("replacing invalid Altimate Base credential record during logout", { error })
    }
    await FreeTierStore.write({
      version: 1,
      // A legacy-only logout may race the first managed registration before that registration has
      // written its identity. Persisting one here gives the nonce a durable record in that case.
      installSecret: stored?.installSecret ?? mintInstallSecret(),
      // A pending registration captures the previous nonce before waiting for this same file lock.
      // Rotating it makes that stale operation fail its post-lock check instead of reconnecting.
      logoutNonce: randomBytes(16).toString("hex"),
    })
  })
}

export function sanitizeCliVersion(raw: string): string {
  const coerced = raw
    .replace(/[^A-Za-z0-9._+-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 32)
  return coerced || "unknown"
}

function describeRegistrationFailure(status: number): string {
  if (status === 429) return "Too many Altimate Base registrations from this network right now. Try again later."
  if (status === 503) return "Altimate Base is temporarily unavailable. Try again later."
  return `Altimate Base registration failed (HTTP ${status}).`
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return "<invalid>"
  }
}

function credentialFingerprint(value: Pick<Credentials, "apiKey" | "baseURL">): string {
  return createHash("sha256").update(`${value.baseURL}\0${value.apiKey}`).digest("hex")
}

function markCredentialRejectedInMemory(value: Pick<Credentials, "apiKey" | "baseURL">): void {
  const fingerprint = credentialFingerprint(value)
  rejectedCredentials.delete(fingerprint)
  rejectedCredentials.add(fingerprint)
  while (rejectedCredentials.size > REJECTED_CREDENTIAL_LIMIT) {
    const oldest = rejectedCredentials.keys().next().value
    if (!oldest) break
    rejectedCredentials.delete(oldest)
  }
}

function credentialWasRejected(value: Pick<Credentials, "apiKey" | "baseURL">): boolean {
  return rejectedCredentials.has(credentialFingerprint(value))
}

function clearRejectedCredentialInMemory(value: Pick<Credentials, "apiKey" | "baseURL">): void {
  rejectedCredentials.delete(credentialFingerprint(value))
  clearUnauthorizedCount(value)
}

function countUnauthorized(value: Pick<Credentials, "apiKey" | "baseURL">): number {
  const fingerprint = credentialFingerprint(value)
  const next = (unauthorizedCounts.get(fingerprint) ?? 0) + 1
  unauthorizedCounts.delete(fingerprint)
  unauthorizedCounts.set(fingerprint, next)
  while (unauthorizedCounts.size > REJECTED_CREDENTIAL_LIMIT) {
    const oldest = unauthorizedCounts.keys().next().value
    if (!oldest) break
    unauthorizedCounts.delete(oldest)
  }
  return next
}

function clearUnauthorizedCount(value: Pick<Credentials, "apiKey" | "baseURL">): void {
  unauthorizedCounts.delete(credentialFingerprint(value))
}

async function markCredentialRejected(value: Pick<Credentials, "apiKey" | "baseURL">): Promise<void> {
  markCredentialRejectedInMemory(value)
  if (countUnauthorized(value) < REJECTED_PERSIST_THRESHOLD) {
    // Blocked for the rest of this process, but not disowned on disk: a relaunch retries the
    // credential, so a transient gateway fault resolves itself without another disclosure.
    log.warn("Altimate Base credential rejected once; not persisting yet")
    return
  }
  await Flock.withLock(LOCK_KEY, async () => {
    const stored = await FreeTierStore.read()
    if (!stored?.apiKey || stored.apiKey !== value.apiKey || stored.baseURL !== value.baseURL || stored.rejected) return
    await FreeTierStore.write({ ...stored, rejected: true })
  }).catch((error) => {
    // The in-memory marker still prevents reuse in this process. Preserve the gateway's response
    // instead of replacing it with a local persistence failure.
    log.warn("failed to persist rejected Altimate Base credentials", { error })
  })
}

function registrationCancelled(): RegistrationError {
  return new RegistrationError("Altimate Base setup was cancelled by logout. Reopen setup to connect again.", "cancelled")
}

async function installSecretForRegistration(expectedLogoutNonce: string | undefined): Promise<string> {
  const stored = await FreeTierStore.read()
  if (stored?.logoutNonce !== expectedLogoutNonce) throw registrationCancelled()
  if (stored?.installSecret) return stored.installSecret
  const installSecret = mintInstallSecret()
  // Persist before the request so a lost response cannot mint another budget principal on retry.
  await FreeTierStore.write({
    version: 1,
    installSecret,
    ...(expectedLogoutNonce ? { logoutNonce: expectedLogoutNonce } : {}),
  })
  return installSecret
}

async function registerOnce(
  configuredGateway: string,
  expectedLogoutNonce: string | undefined,
  signal?: AbortSignal,
): Promise<Credentials> {
  signal?.throwIfAborted()
  const installSecret = await installSecretForRegistration(expectedLogoutNonce)
  signal?.throwIfAborted()
  let response: Response
  try {
    response = await fetch(`${configuredGateway}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_secret_hash: hashInstallSecret(installSecret),
        cli_version: sanitizeCliVersion(Installation.VERSION),
      }),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REGISTER_TIMEOUT_MS)])
        : AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    })
  } catch (error) {
    log.warn("Altimate Base registration request failed", { error })
    throw new RegistrationError("Could not reach the Altimate Base gateway. Check your connection.", "network")
  }

  if (!response.ok) {
    log.warn("Altimate Base registration rejected", { status: response.status })
    throw new RegistrationError(describeRegistrationFailure(response.status), "http", response.status)
  }

  const body = (await response.json().catch(() => undefined)) as
    | { api_key?: unknown; base_url?: unknown; expires_at?: unknown; model?: unknown }
    | undefined
  const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : ""
  const baseURL = typeof body?.base_url === "string" ? FreeTierUrl.normalizeGatewayUrl(body.base_url) : undefined
  const expiresAtPresent = body?.expires_at !== undefined
  const expiresAt = typeof body?.expires_at === "string" ? body.expires_at.trim() : undefined
  const expiresAtTimestamp = expiresAt ? Date.parse(expiresAt) : undefined
  if (
    !apiKey ||
    !baseURL ||
    baseURL !== configuredGateway ||
    (expiresAtPresent &&
      (!expiresAt ||
        expiresAtTimestamp === undefined ||
        !Number.isFinite(expiresAtTimestamp) ||
        expiresAtTimestamp <= Date.now())) ||
    (body?.model !== undefined && body.model !== MODEL_ID)
  ) {
    throw new RegistrationError("The Altimate Base gateway returned an unexpected response.", "response")
  }

  const result: Credentials = {
    apiKey,
    baseURL,
    installSecret,
    ...(expiresAt ? { expiresAt } : {}),
  }
  await FreeTierStore.write({
    version: 1,
    installSecret,
    ...(expectedLogoutNonce ? { logoutNonce: expectedLogoutNonce } : {}),
    apiKey,
    baseURL,
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
  })
  // registerOnce runs while LOCK_KEY is already held, so only touch the process-local cache here;
  // the newly written record above has already cleared the persisted rejection marker.
  clearRejectedCredentialInMemory(result)
  return result
}

/**
 * Register only after redeeming a one-shot consent token.
 *
 * The token is checked here, before any network or storage effect, against the private consent
 * authority this module claimed at load time (`redeemConsent`, see capability.ts) — so
 * "registration requires an accepted disclosure" is enforced by this function itself rather than
 * by the discipline of its callers. A caller cannot forge a token by constructing their own
 * `ConsentCapabilityStore`: that class's `arm`/`consume` only ever validate against the instance
 * you built, and the ONE instance this function actually checks is never exported — the only way
 * to arm it is `FreeTierCapability.issueArmer()`, claimed once by the TUI worker's consent gate at
 * boot. A future CLI, HTTP route, or plugin cannot register by importing this: it would have to
 * obtain a token minted by that gate. Provider discovery and inference never call it.
 */
export async function registerAfterConsent(
  token: string,
  input: { signal?: AbortSignal } = {},
): Promise<Credentials> {
  if (!redeemConsent(token)) {
    throw new RegistrationError("Altimate Base consent expired. Reopen setup and try again.", "cancelled")
  }
  const configuredGateway = gatewayUrl()
  const dedupeKey = configuredGateway
  const pending = inflight.get(dedupeKey)
  if (pending) return pending

  const started = (async () => {
    let expectedLogoutNonce: string | undefined
    try {
      expectedLogoutNonce = (await FreeTierStore.read())?.logoutNonce
    } catch (error) {
      if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
      // The existing explicit-consent repair path below owns malformed records.
    }

    return Flock.withLock(LOCK_KEY, async () => {
      let fresh: Credentials | undefined
      try {
        const stored = await FreeTierStore.read()
        if (stored?.logoutNonce !== expectedLogoutNonce) throw registrationCancelled()
        fresh = credentialsFromStored(stored)
      } catch (error) {
        if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
        // This path is reachable only after explicit disclosure acceptance. Repairing here keeps a
        // truncated credential file from permanently bricking setup without silently erasing it
        // during provider discovery.
        log.warn("removing invalid Altimate Base credential record after explicit consent", { error })
        await FreeTierStore.remove()
      }
      if (
        fresh &&
        fresh.baseURL === configuredGateway &&
        !expired(fresh) &&
        !fresh.rejected &&
        !credentialWasRejected(fresh)
      )
        return fresh
      if (fresh && (fresh.rejected || credentialWasRejected(fresh))) {
        log.info("rotating a rejected Altimate Base credential after explicit consent")
      }
      return registerOnce(configuredGateway, expectedLogoutNonce, input.signal)
    })
  })().finally(() => {
    if (inflight.get(dedupeKey) === started) inflight.delete(dedupeKey)
  })
  inflight.set(dedupeKey, started)
  return started
}

function targetUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

function isReplayable(input: RequestInfo | URL, body: BodyInit | null | undefined): boolean {
  if (input instanceof Request && input.body) return false
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    body instanceof Blob
  )
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const initial = await credentialsForLoad()
  if (!initial) throw new Error("Altimate Base credentials are unavailable. Set up the model again.")

  const target = targetUrl(input)
  if (!sameOrigin(target, initial.baseURL)) {
    log.error("blocked Altimate Base request to an unregistered origin", {
      expected: safeOrigin(initial.baseURL),
      actual: safeOrigin(target),
    })
    throw new Error("Blocked an Altimate Base request to an unregistered gateway origin.")
  }

  const send = (next: Credentials): Promise<Response> | undefined => {
    if (!sameOrigin(target, next.baseURL)) return undefined
    const headers = requestHeaders(input, init)
    headers.set("Authorization", `Bearer ${next.apiKey}`)
    return fetch(input, { ...init, headers, redirect: "manual" })
  }

  const active = initial
  const response = await send(active)!
  // A success cannot prove that a concurrent 401 was stale: the key may have
  // been revoked after this request was authorized. Only explicit consent and
  // registration rotate/clear rejected credentials, keeping the ordinary
  // inference path lock-free after its initial credential read.
  //
  // It does, however, prove the credential is not dead right now, so the consecutive-401 counter
  // resets. Only an unbroken run of 401s disowns a credential on disk. Any non-401 response — a
  // 2xx, or a 429/413/503 the gateway would not return for a rejected key — is equally proof of
  // life; gating the reset on `response.ok` let a 401 that happened to straddle an unrelated
  // rate-limit or outage response still reach the persistence threshold.
  if (response.status !== 401) {
    clearUnauthorizedCount(active)
    return response
  }
  await markCredentialRejected(active)
  if (!isReplayable(input, init?.body)) return response

  // Another consented process may have rotated the key while this request was in flight. Reuse
  // that already-persisted credential once, but never POST /register from the inference path.
  const next = await credentialsForLoad().catch((error) => {
    log.warn("failed to read a rotated Altimate Base credential", { error })
    return undefined
  })
  if (!next || next.apiKey === active.apiKey) return response
  const retried = send(next)
  if (!retried) {
    log.error("blocked rotated Altimate Base credentials for a different origin", {
      expected: safeOrigin(initial.baseURL),
      actual: safeOrigin(next.baseURL),
    })
    return response
  }
  const retryResponse = await retried
  if (retryResponse.status === 401) await markCredentialRejected(next)
  return retryResponse
}

export function describeRateLimit(
  input: { body?: string; retryAfter?: string },
): { message: string; retryable: boolean } | undefined {
  let parsed: { error?: { type?: unknown; message?: unknown }; type?: unknown } | undefined
  try {
    parsed = input.body ? JSON.parse(input.body) : undefined
  } catch {
    return undefined
  }
  const kind = typeof parsed?.error?.type === "string" ? parsed.error.type : parsed?.type
  const detail = typeof parsed?.error?.message === "string" ? parsed.error.message : ""
  if (kind === "throttling_error") {
    if (/Limit type: tokens/.test(detail)) {
      return {
        message:
          "This request is too large for Altimate Base's per-minute token limit. Start a new session or shorten the context, then try again.",
        retryable: false,
      }
    }
    const seconds = Number(input.retryAfter)
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)}s.` : " Try again shortly."
    return { message: `Too many requests to Altimate Base right now.${wait}`, retryable: true }
  }
  if (kind === "budget_exceeded") {
    if (detail.includes("ExceededBudget: User=")) {
      return {
        message: "You've used today's free Altimate Base allowance. It resets tomorrow—switch models to keep going.",
        retryable: false,
      }
    }
    if (detail.includes("Budget has been exceeded")) {
      return {
        message: "Altimate Base has reached its shared daily limit. It resets tomorrow—switch models to keep going.",
        retryable: false,
      }
    }
    return {
      message: "The daily Altimate Base limit has been reached. It resets tomorrow—switch models to keep going.",
      retryable: false,
    }
  }
  return undefined
}

export function describeRequestTooLarge(body?: string): string | undefined {
  type Inner = { code?: unknown; message?: unknown; provider_specific_fields?: { error?: Inner } }
  let parsed: { error?: Inner } | undefined
  try {
    parsed = body ? JSON.parse(body) : undefined
  } catch {
    return undefined
  }
  const inner = parsed?.error?.provider_specific_fields?.error
  if (parsed?.error?.code !== "request_too_large" && inner?.code !== "request_too_large") return undefined
  const detail =
    typeof parsed?.error?.message === "string"
      ? parsed.error.message
      : typeof inner?.message === "string"
        ? inner.message
        : ""
  const sizes = detail.match(/Request is (\d+) bytes; the free tier limit is (\d+) bytes/)
  const numbers = sizes
    ? ` (${Math.round(Number(sizes[1]) / 1024)}KB against a ${Math.round(Number(sizes[2]) / 1024)}KB limit)`
    : ""
  return `This request is too large for Altimate Base${numbers}. Start a new session, or switch to another model for this task.`
}

export * as FreeTier from "./client"

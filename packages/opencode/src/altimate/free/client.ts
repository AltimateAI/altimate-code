import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Installation } from "../../installation"
import { Log } from "../util/log"
import { FreeTierStore } from "./store"
import { FreeTierUrl } from "./url"
// altimate_change — first-run health: time every Altimate Base registration
import { Telemetry } from "../telemetry"

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
// altimate_change start — Codex review finding: separate in-process dedupe maps for the explicit
// (picker/route) and auto (startup) registration paths. They used to share one map keyed only by
// gateway URL, so an explicit register() call arriving while an auto-register attempt was already
// in flight for the same gateway would just RETURN that auto attempt's promise — including its
// auto-only semantics. Concretely: autoRegister() treats "the user logged out" as a `{status:
// "skipped", reason: "logged-out"}` result (via AutoRegisterSkippedLoggedOutError, caught only in
// autoRegister() itself), while an explicit register() is documented to proceed through a logout
// and reconnect. A joined explicit call got that rejection surfaced as an unhandled/miscategorized
// error instead of actually registering.
//
// Splitting the maps does not reopen "both paths hit the network at once for the same gateway":
// both still funnel through the SAME `Flock.withLock(LOCK_KEY, ...)` in registerOnce()/
// autoRegisterLocked() below, which serializes the real work. Whichever call's locked body runs
// second re-reads the store fresh and (unless a genuine explicit-through-logout reconnect is in
// play) takes the "already registered" fast path instead of registering again.
const explicitInflight = new Map<string, Promise<Credentials>>()
const autoInflight = new Map<string, Promise<Credentials>>()
// altimate_change end
const rejectedCredentials = new Set<string>()
const REJECTED_CREDENTIAL_LIMIT = 32
// A credential is only disowned on disk after this many 401s in a row. One 401 can come from a
// gateway deploy, an LB restart, or key-propagation skew; persisting on the first one would take
// the whole free tier offline until every user re-ran the disclosure flow.
const REJECTED_PERSIST_THRESHOLD = 2
const unauthorizedCounts = new Map<string, number>()

export interface Credentials {
  apiKey: string
  baseURL: string
  expiresAt?: string
  installSecret: string
  rejected?: boolean
  /** Rotated by every logout; lets a caller tell a re-registered credential from an untouched one. */
  logoutNonce?: string
}

export type RegistrationFailureKind = "network" | "http" | "response" | "cancelled"

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly kind: RegistrationFailureKind,
    readonly status?: number,
    // altimate_change — the gateway's own Retry-After for a 429, in ms, when present and parseable
    // (numeric seconds or an HTTP-date). Lets autoRegister's post-failure backoff (below) honor a
    // longer-than-default wait instead of hammering a gateway that just told it to back off more.
    readonly retryAfterMs?: number,
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
    ...(stored.logoutNonce ? { logoutNonce: stored.logoutNonce } : {}),
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
  // Provider discovery must remain read-only. Refreshing here would mint credentials outside an
  // explicit `register()` call (autoRegister at startup, or the picker/route).
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

// altimate_change — Retry-After can be a plain seconds count or an HTTP-date; autoRegister's
// post-failure backoff below only needs a 429's value, so callers gate this on that status.
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const target = Date.parse(value)
  if (!Number.isFinite(target)) return undefined
  const ms = target - Date.now()
  return ms > 0 ? ms : undefined
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
    // altimate_change start — first-run health: a caller abort is a cancellation, not a gateway
    // failure; keep the registration timeout classified as network.
    if (signal?.aborted) {
      throw new RegistrationError("Altimate Base registration was cancelled.", "cancelled")
    }
    // altimate_change end
    log.warn("Altimate Base registration request failed", { error })
    throw new RegistrationError("Could not reach the Altimate Base gateway. Check your connection.", "network")
  }

  if (!response.ok) {
    log.warn("Altimate Base registration rejected", { status: response.status })
    // altimate_change — see autoRegister()'s post-failure backoff below for why 429 specifically
    const retryAfterMs =
      response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined
    throw new RegistrationError(describeRegistrationFailure(response.status), "http", response.status, retryAfterMs)
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
 * Register explicitly — the picker's "use Altimate Base" selection, and the HTTP route a host
 * with its own UI (the VS Code extension) calls. No consent token: the product no longer gates
 * registration behind a disclosure dialog (the wording still exists, served by
 * `FreeTierConsent.DISCLOSURE` / `GET /altimate/base/disclosure`, but accepting it is no longer a
 * precondition of minting a credential).
 *
 * Unlike `autoRegister`, this never treats "the user logged out" as a reason to skip: an explicit
 * register is the user asking to reconnect, so it proceeds and effectively clears the logout (the
 * resulting credential write carries a real `apiKey`, which is what `autoRegister`'s logout check
 * actually keys on).
 *
 * Shares `LOCK_KEY` and `registerOnce` with `autoRegister`, so the two can never both hit the
 * network for the same gateway at once — but dedupes concurrent explicit calls against
 * `explicitInflight`, a map of its own, never against an in-flight auto-register (see
 * `explicitInflight`'s declaration for why).
 */
export async function register(
  input: { origin: "picker" | "server"; signal?: AbortSignal } = { origin: "picker" },
): Promise<Credentials> {
  const startedAt = performance.now()
  let configuredGateway: string
  try {
    configuredGateway = gatewayUrl()
  } catch (error) {
    reportRegistration(registrationResult(error), startedAt, error, input.origin)
    throw error
  }
  const dedupeKey = configuredGateway
  const pending = explicitInflight.get(dedupeKey)
  if (pending) return pending

  const started = (async () => {
    let expectedLogoutNonce: string | undefined
    try {
      expectedLogoutNonce = (await FreeTierStore.read())?.logoutNonce
    } catch (error) {
      if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
      // The repair path below owns malformed records.
    }

    return Flock.withLock(LOCK_KEY, async () => {
      let fresh: Credentials | undefined
      try {
        const stored = await FreeTierStore.read()
        if (stored?.logoutNonce !== expectedLogoutNonce) throw registrationCancelled()
        fresh = credentialsFromStored(stored)
      } catch (error) {
        if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
        // This path is reachable only from an explicit, user-initiated register. Repairing here
        // keeps a truncated credential file from permanently bricking setup without silently
        // erasing it during provider discovery.
        log.warn("removing invalid Altimate Base credential record before explicit registration", { error })
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
        log.info("rotating a rejected Altimate Base credential")
      }
      return registerOnce(configuredGateway, expectedLogoutNonce, input.signal)
    })
  })().finally(() => {
    if (explicitInflight.get(dedupeKey) === started) explicitInflight.delete(dedupeKey)
  })
  explicitInflight.set(dedupeKey, started)
  // altimate_change start — report the outcome on a side branch so the caller's promise, and the
  // dedupe bookkeeping above, are untouched; the rejection handler keeps the branch from surfacing
  // as an unhandled rejection.
  started.then(
    () => reportRegistration("success", startedAt, undefined, input.origin),
    (error: unknown) => reportRegistration(registrationResult(error), startedAt, error, input.origin),
  )
  // altimate_change end
  return started
}

// altimate_change start — first-run health: altimate_base_registration
type RegistrationResult = Extract<Telemetry.Event, { type: "altimate_base_registration" }>["result"]

function registrationResult(error: unknown): RegistrationResult {
  if (error instanceof RegistrationError) return error.kind
  if (error instanceof ConfigurationError) return "configuration"
  // `signal.throwIfAborted()` before the request raises a DOMException named AbortError.
  if (error instanceof Error && error.name === "AbortError") return "cancelled"
  return "error"
}

function reportRegistration(
  result: RegistrationResult,
  startedAt: number,
  error?: unknown,
  // "consent" is retired (the disclosure dialog that emitted it is gone) but stays in the union so
  // historical events still type.
  origin?: "auto" | "consent" | "picker" | "server",
) {
  const status = error instanceof RegistrationError ? error.status : undefined
  const event: Telemetry.Event = {
    type: "altimate_base_registration",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    result,
    duration_ms: Math.round(performance.now() - startedAt),
    ...(status !== undefined ? { status } : {}),
    ...(origin ? { origin } : {}),
  }
  if (origin === "auto") {
    // autoRegister runs at process boot, before any prompt has initialised telemetry, and can run
    // entirely outside an Instance context. Calling Telemetry.init() from here (as the explicit
    // register path does below) would treat config as enabled regardless of a `telemetry.disabled`
    // opt-out. track() buffers the event until a real init() elsewhere enables it.
    Telemetry.track(event)
    return
  }
  // Registration can run before any prompt has initialised telemetry (TUI worker, serve after a
  // session shutdown). init() is idempotent; tracking after it guarantees the anchor flush fires
  // instead of the event sitting in a pre-init buffer that a killed process would lose.
  void Telemetry.init().then(
    () => Telemetry.track(event),
    () => Telemetry.track(event),
  )
}
// altimate_change end

// Marker for autoRegister's "the user explicitly logged out" skip. Distinct from
// RegistrationError so autoRegister can tell "nothing to do" apart from a real failure without
// inspecting message text.
class AutoRegisterSkippedLoggedOutError extends Error {}

export type AutoRegisterResult =
  | { status: "registered" }
  | { status: "skipped"; reason: "env" | "no-gateway" | "logged-out" | "already-registered" | "backoff" }
  | { status: "failed"; kind: Exclude<RegistrationResult, "success"> }

function autoRegisterDisabledByEnv(): boolean {
  const raw = process.env["ALTIMATE_BASE_AUTO_REGISTER"]?.trim().toLowerCase()
  return raw === "0" || raw === "false"
}

// altimate_change start — Codex review finding: every entrypoint calls autoRegisterWithin() at
// startup, so a persistent failure (network down, gateway returning 429/5xx) meant every single
// launch repeated the same 15s-timeout registration attempt (up to the 3s budget) for nothing.
// `run`/`serve`/`acp`/`web` are all short-lived processes — a Map would reset with every new
// launch, which is exactly the case that needed fixing — so the backoff deadline is persisted to a
// small JSON file next to the credential store (same directory as `FreeTierStore.credentialPath()`,
// mirroring the disclosure marker in consent.ts) and read at the start of every `autoRegister()`
// call, including the first one in a brand-new process.
const AUTO_REGISTER_BACKOFF_MS = 60 * 60 * 1000 // 1 hour
// A gateway or proxy sending an enormous Retry-After must not disable auto-registration for days.
const AUTO_REGISTER_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000 // 24 hours

function autoRegisterBackoffMs(
  kind: Exclude<RegistrationResult, "success">,
  error: unknown,
): number | undefined {
  if (kind === "network") return AUTO_REGISTER_BACKOFF_MS
  if (kind === "http" && error instanceof RegistrationError) {
    if (error.status === 429)
      return Math.min(AUTO_REGISTER_BACKOFF_MAX_MS, Math.max(AUTO_REGISTER_BACKOFF_MS, error.retryAfterMs ?? 0))
    if (error.status !== undefined && error.status >= 500) return AUTO_REGISTER_BACKOFF_MS
  }
  return undefined
}

function autoRegisterBackoffPath(): string {
  return path.join(path.dirname(FreeTierStore.credentialPath()), "altimate-base-auto-register-backoff.json")
}

type AutoRegisterBackoffRecord = { [gateway: string]: number }

async function readAutoRegisterBackoffRecord(): Promise<AutoRegisterBackoffRecord> {
  try {
    const raw = await fs.readFile(autoRegisterBackoffPath(), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const result: AutoRegisterBackoffRecord = {}
    for (const [gateway, until] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until)) result[gateway] = until
    }
    return result
  } catch {
    // Missing file, unreadable, or corrupt JSON — treated the same as "no backoff recorded".
    // Never blocks auto-registration: worst case is one extra attempt.
    return {}
  }
}

async function writeAutoRegisterBackoffRecord(record: AutoRegisterBackoffRecord): Promise<void> {
  const target = autoRegisterBackoffPath()
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.writeFile(target, JSON.stringify(record) + "\n", { mode: 0o600 })
  } catch (error) {
    // Best-effort persistence: a failure to write only risks one extra attempt on the next
    // launch, never blocks the current one.
    log.warn("failed to persist Altimate Base auto-register backoff", { error })
  }
}

async function getPersistedAutoRegisterBackoff(gateway: string): Promise<number | undefined> {
  const record = await readAutoRegisterBackoffRecord()
  return record[gateway]
}

// Concurrent entrypoints (a TUI and a `serve`, say) can update the record at the same moment; the
// read-modify-write runs under its own lock so one cannot drop or resurrect the other's entry.
// Not LOCK_KEY: these run after the registration lock is released, and must not queue behind it.
const BACKOFF_LOCK_KEY = "altimate-base-auto-register-backoff"

async function setPersistedAutoRegisterBackoff(gateway: string, until: number): Promise<void> {
  await Flock.withLock(BACKOFF_LOCK_KEY, async () => {
    const record = await readAutoRegisterBackoffRecord()
    record[gateway] = until
    await writeAutoRegisterBackoffRecord(record)
  }).catch((error) => log.warn("failed to update Altimate Base auto-register backoff", { error }))
}

async function clearPersistedAutoRegisterBackoff(gateway: string): Promise<void> {
  await Flock.withLock(BACKOFF_LOCK_KEY, async () => {
    const record = await readAutoRegisterBackoffRecord()
    if (!(gateway in record)) return
    delete record[gateway]
    await writeAutoRegisterBackoffRecord(record)
  }).catch((error) => log.warn("failed to clear Altimate Base auto-register backoff", { error }))
}

// Test-only: this file is otherwise process-global state with no reset hook, so a backoff set by
// one test would silently skip auto-register for every later test in the same file/gateway.
// Mirrors the `resetXForTests()` naming convention used elsewhere (e.g.
// `altimate/workspace/identity.ts`).
export async function resetAutoRegisterBackoffForTests(): Promise<void> {
  await writeAutoRegisterBackoffRecord({})
}

export async function getAutoRegisterBackoffUntilForTests(gateway: string): Promise<number | undefined> {
  return getPersistedAutoRegisterBackoff(gateway)
}
// altimate_change end

/**
 * Registration body for the no-consent auto-register path, run entirely under the shared
 * registration lock. Every read of the store happens while holding LOCK_KEY, so it always sees
 * the latest state — including a logout that raced a caller's earlier, lock-free check (see
 * `autoRegister`'s "already registered" fast path).
 */
async function autoRegisterLocked(configuredGateway: string, signal: AbortSignal | undefined): Promise<Credentials> {
  return Flock.withLock(LOCK_KEY, async () => {
    let stored: FreeTierStore.Record | undefined
    try {
      stored = await FreeTierStore.read()
    } catch (error) {
      if (!(error instanceof FreeTierStore.InvalidCredentialStoreError)) throw error
      log.warn("removing invalid Altimate Base credential record before auto-registration", { error })
      await FreeTierStore.remove()
      stored = undefined
    }
    if (stored?.logoutNonce && !stored.apiKey) throw new AutoRegisterSkippedLoggedOutError()
    const fresh = credentialsFromStored(stored)
    if (
      fresh &&
      fresh.baseURL === configuredGateway &&
      !expired(fresh) &&
      !fresh.rejected &&
      !credentialWasRejected(fresh)
    )
      return fresh
    return registerOnce(configuredGateway, stored?.logoutNonce, signal)
  })
}

/**
 * Register at startup, automatically — no consent gate, no user action. Every entrypoint calls
 * this before provider state is first built. Shares LOCK_KEY and `registerOnce` with `register()`
 * (the explicit, picker/route-triggered path), so an auto-register and an explicit registration
 * racing for the same gateway can never both hit the network — but dedupes concurrent auto calls
 * against `autoInflight`, a map of its own, never against an in-flight explicit register (see
 * `explicitInflight`'s declaration for why).
 *
 * Never throws: every failure mode resolves to a `{ status: "skipped" | "failed" }` result.
 */
export async function autoRegister(signal?: AbortSignal): Promise<AutoRegisterResult> {
  try {
    if (autoRegisterDisabledByEnv()) return { status: "skipped", reason: "env" }
    let configuredGateway: string
    try {
      configuredGateway = gatewayUrl()
    } catch (error) {
      if (error instanceof ConfigurationError) return { status: "skipped", reason: "no-gateway" }
      throw error
    }

    // Lock-free fast path: once a machine is registered, every later launch skips without ever
    // touching the flock. The logout check below still runs inside the lock for every launch that
    // reaches it, since that's the one check a lock-free read here could race.
    const alreadyRegistered = await isRegistered().catch(() => false)
    if (alreadyRegistered) return { status: "skipped", reason: "already-registered" }

    // altimate_change — see the persisted-backoff declarations above. Explicit register() never
    // consults this: it is the user asking to reconnect right now, not startup's own retry.
    const backoffUntil = await getPersistedAutoRegisterBackoff(configuredGateway)
    if (backoffUntil !== undefined && Date.now() < backoffUntil) return { status: "skipped", reason: "backoff" }

    const dedupeKey = configuredGateway
    const existing = autoInflight.get(dedupeKey)
    const startedAt = performance.now()
    const started =
      existing ??
      (() => {
        const promise = autoRegisterLocked(configuredGateway, signal).finally(() => {
          if (autoInflight.get(dedupeKey) === promise) autoInflight.delete(dedupeKey)
        })
        autoInflight.set(dedupeKey, promise)
        return promise
      })()

    try {
      await started
    } catch (error) {
      if (error instanceof AutoRegisterSkippedLoggedOutError) return { status: "skipped", reason: "logged-out" }
      const kind = registrationResult(error) as Exclude<RegistrationResult, "success">
      // Only the call that actually owns the in-flight promise reports it, so a dedupe hit never
      // double-counts one registration attempt.
      if (!existing) {
        reportRegistration(kind, startedAt, error, "auto")
        // altimate_change — see the persisted-backoff declarations above
        const backoffMs = autoRegisterBackoffMs(kind, error)
        if (backoffMs) await setPersistedAutoRegisterBackoff(configuredGateway, Date.now() + backoffMs)
      }
      return { status: "failed", kind }
    }
    // altimate_change — a launch that finally succeeds (network recovered, gateway stopped
    // throttling) must not keep skipping on some later launch just because a stale deadline is
    // still sitting on disk from the earlier failure.
    await clearPersistedAutoRegisterBackoff(configuredGateway)
    if (!existing) reportRegistration("success", startedAt, undefined, "auto")
    return { status: "registered" }
  } catch (error) {
    log.error("Altimate Base auto-registration failed unexpectedly", { error })
    return { status: "failed", kind: "error" }
  }
}

/**
 * Await `autoRegister()` for at most `ms`, then return regardless. A still-running attempt keeps
 * going in the background — its credentials are persisted to disk on success, so a late result is
 * picked up by the next launch even though this one already moved on.
 */
export function autoRegisterWithin(ms = 3000): Promise<AutoRegisterResult | { status: "pending" }> {
  const attempt = autoRegister().catch((error) => {
    log.error("Altimate Base auto-registration rejected unexpectedly", { error })
    return { status: "failed", kind: "error" } as const
  })
  const timeout = new Promise<{ status: "pending" }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "pending" }), ms)
    timer.unref?.()
  })
  return Promise.race([attempt, timeout])
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
  // been revoked after this request was authorized. Only autoRegister and an
  // explicit register() rotate/clear rejected credentials, keeping the ordinary
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

  // Another registration may have rotated the key while this request was in flight. Reuse that
  // already-persisted credential once, but never POST /register from the inference path.
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
  // altimate_change — mirror the initial response's reset above: a non-401 retry is equally proof
  // of life for the rotated credential, so a prior 401 recorded against it elsewhere must not
  // survive to later cross the rejection threshold on its own.
  if (retryResponse.status !== 401) {
    clearUnauthorizedCount(next)
    return retryResponse
  }
  await markCredentialRejected(next)
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
    // A per-minute token limit ("Limit type: tokens") and the generic burst limit are both
    // transient — we raised the token budget to 1.5M/min, so hitting it now means a burst of
    // fast turns, not an oversized request. Both are retryable with the same message shape;
    // the caller (provider/error.ts) caps how long a single retry actually waits.
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

// altimate_change start — the generic (no byte-count) request-too-large message is shared by two
// branches below: the parsed-JSON shape whose message didn't match the byte-count pattern, and
// the unparseable/empty-body 413 fallback (nginx's raw HTML edge rejection).
const REQUEST_TOO_LARGE_MESSAGE =
  "This request is too large for Altimate Base. Start a new session, or switch to another model for this task."
// altimate_change end

export function describeRequestTooLarge(input: { status?: number; body?: string }): string | undefined {
  const { status, body } = input
  type Inner = { code?: unknown; message?: unknown; provider_specific_fields?: { error?: Inner } }
  let parsed: { error?: Inner } | undefined
  let validJson = true
  try {
    parsed = body ? JSON.parse(body) : undefined
  } catch {
    validJson = false
  }
  if (validJson) {
    const inner = parsed?.error?.provider_specific_fields?.error
    const isRequestTooLarge = parsed?.error?.code === "request_too_large" || inner?.code === "request_too_large"
    if (isRequestTooLarge) {
      const detail =
        typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : typeof inner?.message === "string"
            ? inner.message
            : ""
      const sizes = detail.match(/Request is (\d+) bytes; the free tier limit is (\d+) bytes/)
      if (!sizes) return REQUEST_TOO_LARGE_MESSAGE
      const numbers = ` (${Math.round(Number(sizes[1]) / 1024)}KB against a ${Math.round(Number(sizes[2]) / 1024)}KB limit)`
      return `This request is too large for Altimate Base${numbers}. Start a new session, or switch to another model for this task.`
    }
    // Valid JSON but a shape unrelated to the free-tier byte cap (e.g. another provider's 413,
    // or a different gateway error entirely) — never rewrite it, regardless of status.
    if (body) return undefined
  }
  // altimate_change start — in production, an oversized request is rejected by nginx at the edge
  // with a raw HTML error page, not LiteLLM's JSON `request_too_large` body. That body will never
  // parse, so the friendly message must key off the actual HTTP status instead of a JSON shape
  // that this failure mode can never produce.
  if (status === 413) return REQUEST_TOO_LARGE_MESSAGE
  // altimate_change end
  return undefined
}

export * as FreeTier from "./client"

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
          cli_version: Installation.VERSION,
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
    if (typeof body?.api_key !== "string" || typeof body.base_url !== "string") {
      throw new RegistrationError("The free model gateway returned an unexpected response.")
    }

    const creds: Credentials = {
      apiKey: body.api_key,
      baseURL: body.base_url.replace(/\/+$/, ""),
      expiresAt: typeof body.expires_at === "string" ? body.expires_at : undefined,
      installSecret,
    }
    await store(creds)
    return creds
  }

  function isExpired(creds: Credentials): boolean {
    if (!creds.expiresAt) return false
    const expiry = Date.parse(creds.expiresAt)
    if (Number.isNaN(expiry)) return false
    return expiry - REFRESH_SKEW_MS <= Date.now()
  }

  /**
   * Rotate the key when it is at or near expiry. Silent and non-fatal: a network failure returns
   * the credential we already hold so the session degrades to a 401 from the gateway rather than
   * an error at provider-load time.
   */
  export async function refreshIfNeeded(): Promise<Credentials | undefined> {
    const current = await credentials()
    if (!current) return undefined
    if (!isExpired(current)) return current
    try {
      return await register()
    } catch (err) {
      log.warn("free tier key rotation failed; keeping existing credential", { error: err })
      return current
    }
  }
}

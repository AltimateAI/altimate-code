/**
 * Credential management for connection configs.
 *
 * Fallback order:
 * 1. The OS credential store — macOS Keychain, Windows Credential Manager, or
 *    libsecret on Linux — through keytar when it is installed, otherwise
 *    through Bun's built-in `Bun.secrets`
 * 2. ALTIMATE_CODE_CONN_* env vars — for headless/CI environments
 * 3. Refuse — never store plaintext credentials in config JSON
 *
 * keytar is an optional external that nothing installs, so in a released
 * binary it is almost never present. Before `Bun.secrets` was used as the
 * fallback, every credential was stripped from the saved connection: it
 * worked for the session that added it, then failed after a restart with the
 * driver's own "password must be specified".
 */

import { Log } from "@/altimate/util/log"
import type { ConnectionConfig } from "@altimateai/drivers"

const SERVICE_NAME = "altimate-code"

const SENSITIVE_FIELDS = new Set([
  "password",
  "private_key",
  "privateKey",
  "private_key_passphrase",
  "privateKeyPassphrase",
  "privateKeyPass",
  "access_token",
  "token",
  "oauth_client_secret",
  "oauthClientSecret",
  "passcode",
  "ssh_password",
  "connection_string",
  "credentials_json",
  "keyfile_json",
  "ssl_key",
  "ssl_cert",
  "ssl_ca",
  "tls_key",
  "tls_cert",
  "tls_ca_cert",
])

/** One OS credential store. `account` is `<connection>/<field>` under {@link SERVICE_NAME}. */
export interface SecretBackend {
  name: string
  set(account: string, value: string): Promise<void>
  get(account: string): Promise<string | null>
  delete(account: string): Promise<boolean>
}

/** Turns the OS credential store off; set by the test preload so the suite never touches a real keychain. */
const DISABLE_ENV = "ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE"

/** Cached backend: `null` once probed and found unavailable. */
let backend: SecretBackend | null | undefined = undefined

async function loadKeytar(): Promise<SecretBackend | null> {
  try {
    // @ts-expect-error — optional dependency, loaded at runtime
    const keytar = await import("keytar")
    const k = keytar.default ?? keytar
    if (typeof k?.setPassword !== "function") return null
    return {
      name: "keytar",
      set: (account, value) => k.setPassword(SERVICE_NAME, account, value),
      get: (account) => k.getPassword(SERVICE_NAME, account),
      delete: (account) => k.deletePassword(SERVICE_NAME, account),
    }
  } catch {
    return null
  }
}

/** `secrets` is `Bun.secrets` unless a test passes a stand-in with the same call shape. */
export function loadBunSecrets(secrets: any = (globalThis as { Bun?: { secrets?: any } }).Bun?.secrets): SecretBackend | null {
  if (typeof secrets?.set !== "function" || typeof secrets?.get !== "function") return null
  return {
    name: "Bun.secrets",
    set: (account, value) => secrets.set({ service: SERVICE_NAME, name: account, value }),
    get: async (account) => (await secrets.get({ service: SERVICE_NAME, name: account })) ?? null,
    delete: async (account) => Boolean(await secrets.delete({ service: SERVICE_NAME, name: account })),
  }
}

async function getBackend(): Promise<SecretBackend | null> {
  if (backend !== undefined) return backend
  if (process.env[DISABLE_ENV]) {
    backend = null
    return backend
  }
  backend = (await loadKeytar()) ?? loadBunSecrets()
  if (!backend) {
    Log.Default.warn(
      "no OS credential store available — use ALTIMATE_CODE_CONN_* env vars for secure credential storage",
    )
  }
  return backend
}

/** Swap the credential backend in tests. `undefined` re-probes on next use. */
export function setSecretBackendForTests(next: SecretBackend | null | undefined): void {
  backend = next
}

/** Store a single credential in the OS credential store (or return false if unavailable). */
export async function storeCredential(
  connectionName: string,
  field: string,
  value: string,
): Promise<boolean> {
  const store = await getBackend()
  if (!store) return false
  try {
    await store.set(`${connectionName}/${field}`, value)
    return true
  } catch (e) {
    // e.g. no libsecret on Linux, or a locked keychain: report "not stored" so
    // the caller warns, rather than claiming success.
    Log.Default.warn(`could not store '${field}' for connection '${connectionName}' in ${store.name}`, {
      error: String(e),
    })
    return false
  }
}

/** Retrieve a single credential from the OS credential store (or return null). */
export async function getCredential(
  connectionName: string,
  field: string,
): Promise<string | null> {
  const store = await getBackend()
  if (!store) return null
  try {
    return await store.get(`${connectionName}/${field}`)
  } catch {
    return null
  }
}

/** Delete a single credential from the OS credential store. */
export async function deleteCredential(
  connectionName: string,
  field: string,
): Promise<boolean> {
  const store = await getBackend()
  if (!store) return false
  try {
    return await store.delete(`${connectionName}/${field}`)
  } catch {
    return false
  }
}

/**
 * Delete every secret stored for connection `name`, except the fields `keep` holds. Entries are keyed by
 * connection name only, so without this a removed connection's secrets stay in the OS store, and a connection
 * re-added under the same name gets them back at the next restart (`resolveConfig` fills absent fields from the
 * store): an old private key would then outrank the new sign-in method.
 */
export async function forgetCredentials(name: string, keep?: ConnectionConfig): Promise<void> {
  for (const field of SENSITIVE_FIELDS) {
    const kept = keep?.[field]
    if (typeof kept === "string" && kept) continue
    await deleteCredential(name, field)
  }
}

/**
 * Resolve a connection config by pulling sensitive fields from the OS credential store.
 * If no store is available, returns the config as-is (credentials stay in JSON).
 */
export async function resolveConfig(
  name: string,
  config: ConnectionConfig,
): Promise<ConnectionConfig> {
  const resolved = { ...config }
  for (const field of SENSITIVE_FIELDS) {
    if (resolved[field]) continue // already present in config
    const stored = await getCredential(name, field)
    if (stored) {
      resolved[field] = stored
    }
  }
  return resolved
}

/**
 * Save a connection config, extracting sensitive fields to the keychain.
 * Returns the sanitized config and any warnings about stripped credentials.
 */
export async function saveConnection(
  name: string,
  config: ConnectionConfig,
): Promise<{ sanitized: ConnectionConfig; warnings: string[] }> {
  const sanitized = { ...config }
  const warnings: string[] = []
  for (const field of SENSITIVE_FIELDS) {
    const value = config[field]
    if (typeof value !== "string" || !value) continue
    const stored = await storeCredential(name, field, value)
    if (stored) {
      delete sanitized[field]
    } else {
      // No OS credential store — strip the sensitive field to prevent
      // plaintext storage. Users should use ALTIMATE_CODE_CONN_* env vars.
      const warning =
        `Could not store '${field}' for connection '${name}' securely, so it was not saved: ` +
        `the connection works in this session but will fail after a restart. ` +
        `Set ALTIMATE_CODE_CONN_${name.toUpperCase()} to the connection's full config as JSON instead.`
      Log.Default.warn(warning)
      warnings.push(warning)
      delete sanitized[field]
    }
  }
  // Secrets a previous config under this name stored, which this one no longer has. Only once every new secret
  // was stored: a failed write must not also discard the credentials that still work.
  if (warnings.length === 0) await forgetCredentials(name, config)
  return { sanitized, warnings }
}

/** Check if a field is sensitive. */
export function isSensitiveField(field: string): boolean {
  return SENSITIVE_FIELDS.has(field)
}

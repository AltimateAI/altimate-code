/**
 * Credential management for connection configs.
 *
 * 3-tier fallback:
 * 1. keytar (OS Keychain) — preferred, secure
 * 2. ALTIMATE_CODE_CONN_* env vars — for headless/CI environments
 * 3. Refuse — never store plaintext credentials in config JSON
 */

import { Log } from "../../../util/log"
import type { ConnectionConfig } from "@altimateai/drivers"

const SERVICE_NAME = "altimate-code"

const SENSITIVE_FIELDS = new Set([
  "password",
  "private_key_passphrase",
  "access_token",
  "ssh_password",
  "connection_string",
])

/** Cached keytar module (or null if unavailable). */
let keytarModule: any | null | undefined = undefined

async function getKeytar(): Promise<any | null> {
  if (keytarModule !== undefined) return keytarModule
  try {
    // @ts-expect-error — optional dependency, loaded at runtime
    keytarModule = await import("keytar")
    return keytarModule
  } catch {
    Log.Default.warn(
      "keytar not available — use ALTIMATE_CODE_CONN_* env vars for secure credential storage",
    )
    keytarModule = null
    return null
  }
}

/** Store a single credential in the OS keychain (or return false if unavailable). */
export async function storeCredential(
  connectionName: string,
  field: string,
  value: string,
): Promise<boolean> {
  const keytar = await getKeytar()
  if (!keytar) return false
  const account = `${connectionName}/${field}`
  await keytar.setPassword(SERVICE_NAME, account, value)
  return true
}

/** Retrieve a single credential from the OS keychain (or return null). */
export async function getCredential(
  connectionName: string,
  field: string,
): Promise<string | null> {
  const keytar = await getKeytar()
  if (!keytar) return null
  const account = `${connectionName}/${field}`
  return keytar.getPassword(SERVICE_NAME, account)
}

/** Delete a single credential from the OS keychain. */
export async function deleteCredential(
  connectionName: string,
  field: string,
): Promise<boolean> {
  const keytar = await getKeytar()
  if (!keytar) return false
  const account = `${connectionName}/${field}`
  return keytar.deletePassword(SERVICE_NAME, account)
}

/**
 * Resolve a connection config by pulling sensitive fields from the keychain.
 * If keytar is unavailable, returns the config as-is (credentials stay in JSON).
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
      // keytar unavailable — strip sensitive field from config to prevent
      // plaintext storage. Users should use ALTIMATE_CODE_CONN_* env vars.
      const warning = `Cannot securely store '${field}' for connection '${name}'. ` +
        `Set ALTIMATE_CODE_CONN_${name.toUpperCase()} env var with full config JSON instead.`
      Log.Default.warn(warning)
      warnings.push(warning)
      delete sanitized[field]
    }
  }
  return { sanitized, warnings }
}

/** Check if a field is sensitive. */
export function isSensitiveField(field: string): boolean {
  return SENSITIVE_FIELDS.has(field)
}

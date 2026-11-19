/**
 * Private-key handling for Snowflake key-pair auth.
 *
 * Users paste keys in many shapes: real multi-line PEM, single-line values with
 * literal `\n` sequences, bodies whose line breaks became spaces, CRLF files,
 * values wrapped in quotes. This module normalizes all of them back to a
 * canonical PEM and converts every supported key format to the unencrypted
 * PKCS#8 PEM that snowflake-sdk expects. Error messages never include key
 * material or the underlying OpenSSL text.
 */

import * as crypto from "crypto"

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END \1-----/g

export interface NormalizedKey {
  pem: string
  label: string
  /** True for legacy PKCS#1 (traditional) PEM encryption headers. */
  legacyEncrypted: boolean
}

function chunk64(body: string): string {
  return body.match(/.{1,64}/g)?.join("\n") ?? ""
}

/**
 * Rebuild a canonical PEM from a pasted value. Returns undefined when no
 * BEGIN/END block can be found.
 */
export function normalizePrivateKeyPem(raw: string): NormalizedKey | undefined {
  let text = raw.trim()
  // Strip surrounding quotes (possibly repeated, e.g. JSON inside env files).
  while (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    text = text.slice(1, -1).trim()
  }
  text = text.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n")

  // A pasted file may hold other blocks (certificates, public key) before the
  // private key; use the first block that is a private key.
  const match = [...text.matchAll(PEM_BLOCK)].find((m) => /PRIVATE KEY$/.test(m[1]))
  if (!match) return undefined
  const label = match[1]
  let inner = match[2]

  // Legacy encryption headers, either on their own lines or space-joined.
  let procType: string | undefined
  let dekInfo: string | undefined
  inner = inner.replace(/Proc-Type:\s*([^\s]+)/i, (_m, v: string) => {
    procType = v
    return " "
  })
  inner = inner.replace(/DEK-Info:\s*([^\s]+)/i, (_m, v: string) => {
    dekInfo = v
    return " "
  })

  const body = inner.replace(/\s+/g, "")
  const lines = [`-----BEGIN ${label}-----`]
  if (procType || dekInfo) {
    if (procType) lines.push(`Proc-Type: ${procType}`)
    if (dekInfo) lines.push(`DEK-Info: ${dekInfo}`)
    lines.push("")
  }
  lines.push(chunk64(body), `-----END ${label}-----`, "")
  return {
    pem: lines.join("\n"),
    label,
    legacyEncrypted: !!procType && /ENCRYPTED/i.test(procType),
  }
}

/**
 * Convert any supported private key text into an unencrypted PKCS#8 PEM.
 * Supports unencrypted PKCS#1/PKCS#8/SEC1, encrypted PKCS#8, and legacy
 * encrypted PKCS#1 (Proc-Type/DEK-Info).
 */
export function toPkcs8Pem(raw: string, passphrase?: string): string {
  const normalized = normalizePrivateKeyPem(raw)
  if (!normalized || !/PRIVATE KEY$/.test(normalized.label)) {
    throw new Error(
      "Snowflake private key format is not recognized. Provide a PEM private key " +
        "('-----BEGIN PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----' or '-----BEGIN RSA PRIVATE KEY-----').",
    )
  }
  const pass = passphrase && passphrase.length > 0 ? passphrase : undefined
  const encrypted = normalized.label === "ENCRYPTED PRIVATE KEY" || normalized.legacyEncrypted

  if (encrypted && !pass) {
    throw new Error(
      "Snowflake private key is encrypted; set the passphrase (private_key_passphrase) to decrypt it.",
    )
  }

  try {
    const keyObject = crypto.createPrivateKey({ key: normalized.pem, format: "pem", passphrase: pass })
    return keyObject.export({ type: "pkcs8", format: "pem" }).toString()
  } catch {
    if (encrypted) {
      throw new Error(
        "Snowflake: failed to decrypt the private key. The passphrase (private_key_passphrase) is incorrect, " +
          "or the key is corrupted or uses an unsupported cipher.",
      )
    }
    throw new Error(
      "Snowflake private key could not be parsed. It may be truncated, corrupted, or in an unsupported format; " +
        "use an RSA key in PKCS#8 or PKCS#1 PEM form.",
    )
  }
}
